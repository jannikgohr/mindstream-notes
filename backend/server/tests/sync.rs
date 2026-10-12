//! What the server promises a syncing client beyond the wire format: that a
//! cursor never skips a change, that large content survives the trip through
//! the blob store, and that storage is counted.

mod common;

use std::collections::HashSet;
use std::iter;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use common::{named, new_collection, signup, COLLECTION_TYPE};
use etebase::{FetchOptions, PrefetchOption};

/// Run one query against the test database and return its single value.
fn query_i64(sql: &'static str, collection_uid: &str) -> i64 {
    let collection_uid = collection_uid.to_owned();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async move {
            let pool = sqlx::PgPool::connect(&common::database_url())
                .await
                .unwrap();
            sqlx::query_scalar(sql)
                .bind(collection_uid)
                .fetch_one(&pool)
                .await
                .unwrap()
        })
}

#[test]
fn one_cursor_covers_every_collection() {
    let account = signup("solo");
    let collections = account.collection_manager().unwrap();
    let first = new_collection(&account, "first");
    let second = new_collection(&account, "second");

    let all = collections.list(COLLECTION_TYPE, None).unwrap();
    assert_eq!(all.data().len(), 2);
    let cursor = all.stoken().map(str::to_owned);
    let options = FetchOptions::new().stoken(cursor.as_deref());
    assert!(collections
        .list(COLLECTION_TYPE, Some(&options))
        .unwrap()
        .data()
        .is_empty());

    // A new item in one collection is enough for that collection, and only
    // that one, to show up after the cursor.
    let items = collections.item_manager(&second).unwrap();
    let note = items.create(&named("note"), b"body").unwrap();
    items.batch(iter::once(&note), None).unwrap();

    let changed = collections.list(COLLECTION_TYPE, Some(&options)).unwrap();
    assert_eq!(changed.data().len(), 1);
    assert_eq!(changed.data()[0].uid(), second.uid());
    assert_ne!(changed.data()[0].uid(), first.uid());

    // Moving the cursor forward settles it again.
    let options = FetchOptions::new().stoken(changed.stoken());
    assert!(collections
        .list(COLLECTION_TYPE, Some(&options))
        .unwrap()
        .data()
        .is_empty());
}

/// Writers in several collections push while a reader follows with a cursor,
/// and the reader must end up with everything.
///
/// This runs the whole path under contention, but it would rarely catch
/// change numbers handed out in the wrong order: the window is about a
/// millisecond wide. The unit test next to `next_changes` pins that down
/// directly.
#[test]
fn cursor_never_skips_a_change_under_concurrent_writers() {
    const WRITERS: usize = 6;
    const NOTES_EACH: usize = 40;

    let account = Arc::new(signup("busy"));
    let spaces: Vec<_> = (0..WRITERS)
        .map(|i| new_collection(&account, &format!("space {i}")))
        .collect();
    let writing = Arc::new(AtomicBool::new(true));

    let reader = {
        let account = Arc::clone(&account);
        let writing = Arc::clone(&writing);
        std::thread::spawn(move || {
            let collections = account.collection_manager().unwrap();
            let mut collection_cursor: Option<String> = None;
            let mut item_cursors = std::collections::HashMap::<String, Option<String>>::new();
            let mut seen = HashSet::new();
            loop {
                // Read the flag first: a pass that starts after the writers
                // finished is the one that must find everything.
                let last_pass = !writing.load(Ordering::SeqCst);
                let options = FetchOptions::new().stoken(collection_cursor.as_deref());
                let changed = collections.list(COLLECTION_TYPE, Some(&options)).unwrap();
                for collection in changed.data() {
                    let items = collections.item_manager(collection).unwrap();
                    let cursor = item_cursors.entry(collection.uid().to_owned()).or_default();
                    loop {
                        let options = FetchOptions::new().stoken(cursor.as_deref()).limit(7);
                        let page = items.list(Some(&options)).unwrap();
                        for item in page.data() {
                            seen.insert(item.uid().to_owned());
                        }
                        if let Some(next) = page.stoken() {
                            *cursor = Some(next.to_owned());
                        }
                        if page.done() {
                            break;
                        }
                    }
                }
                if let Some(next) = changed.stoken() {
                    collection_cursor = Some(next.to_owned());
                }
                if last_pass {
                    return seen;
                }
            }
        })
    };

    let writers: Vec<_> = spaces
        .into_iter()
        .map(|space| {
            let account = Arc::clone(&account);
            std::thread::spawn(move || {
                let items = account
                    .collection_manager()
                    .unwrap()
                    .item_manager(&space)
                    .unwrap();
                let mut written = Vec::new();
                for i in 0..NOTES_EACH {
                    let note = items.create(&named(&format!("note {i}")), b"x").unwrap();
                    items.batch(iter::once(&note), None).unwrap();
                    written.push(note.uid().to_owned());
                }
                written
            })
        })
        .collect();

    let written: HashSet<String> = writers
        .into_iter()
        .flat_map(|writer| writer.join().unwrap())
        .collect();
    writing.store(false, Ordering::SeqCst);
    let seen = reader.join().unwrap();

    assert_eq!(written.len(), WRITERS * NOTES_EACH);
    let missed: Vec<_> = written.difference(&seen).collect();
    assert!(
        missed.is_empty(),
        "the cursor skipped {} items",
        missed.len()
    );
}

#[test]
fn large_content_round_trips_through_the_blob_store() {
    let account = signup("solo");
    let collection = new_collection(&account, "files");
    let items = account
        .collection_manager()
        .unwrap()
        .item_manager(&collection)
        .unwrap();

    // Several chunks, each well past what is kept in a database row.
    let content = etebase::utils::randombytes_deterministic(300 * 1024, &[9; 32]);
    let file = items.create(&named("file"), &content).unwrap();
    items.batch(iter::once(&file), None).unwrap();

    let in_blob_store = query_i64(
        "SELECT count(*) FROM chunks k JOIN collections c ON c.id = k.collection_id
         WHERE c.uid = $1 AND k.blob_key IS NOT NULL",
        collection.uid(),
    );
    assert!(
        in_blob_store >= 4,
        "only {in_blob_store} chunks left the database"
    );
    // One upload, one blob, however many chunks it carried.
    let blobs = query_i64(
        "SELECT count(DISTINCT k.blob_key) FROM chunks k
         JOIN collections c ON c.id = k.collection_id WHERE c.uid = $1",
        collection.uid(),
    );
    assert_eq!(blobs, 1);

    let fetched = items.fetch(file.uid(), None).unwrap();
    assert_eq!(fetched.content().unwrap(), content);

    // Fetched without content, then downloaded chunk by chunk.
    let lean = FetchOptions::new().prefetch(&PrefetchOption::Medium);
    let mut partial = items.fetch(file.uid(), Some(&lean)).unwrap();
    assert!(partial.is_missing_content());
    items.download_content(&mut partial).unwrap();
    assert_eq!(partial.content().unwrap(), content);
}

#[test]
fn stored_bytes_are_counted_once_per_chunk() {
    let account = signup("solo");
    let collection = new_collection(&account, "counted");
    let items = account
        .collection_manager()
        .unwrap()
        .item_manager(&collection)
        .unwrap();
    let used = || {
        query_i64(
            "SELECT bytes_used FROM collections WHERE uid = $1",
            collection.uid(),
        )
    };
    let empty = used();

    let content = etebase::utils::randombytes_deterministic(100 * 1024, &[3; 32]);
    let mut file = items.create(&named("file"), &content).unwrap();
    items.batch(iter::once(&file), None).unwrap();
    let with_file = used();
    assert!(
        with_file - empty >= 100 * 1024,
        "a 100 KiB upload added only {} bytes",
        with_file - empty
    );

    // The same upload again is a retry and stores nothing.
    items.batch(iter::once(&file), None).unwrap();
    assert_eq!(used(), with_file);

    // A new revision that keeps the content adds its metadata and no chunks.
    file.set_meta(&named("renamed")).unwrap();
    items.batch(iter::once(&file), None).unwrap();
    let renamed = used() - with_file;
    assert!(
        (1..2048).contains(&renamed),
        "renaming a file added {renamed} bytes"
    );
}

#[test]
fn chunk_uploaded_ahead_is_found_by_the_revision() {
    let account = signup("solo");
    let collection = new_collection(&account, "ahead");
    let items = account
        .collection_manager()
        .unwrap()
        .item_manager(&collection)
        .unwrap();
    let content = etebase::utils::randombytes_deterministic(80 * 1024, &[5; 32]);
    let file = items.create(&named("file"), &content).unwrap();

    items.upload_content(&file).unwrap();
    let before = query_i64(
        "SELECT bytes_used FROM collections WHERE uid = $1",
        collection.uid(),
    );
    assert!(before >= 80 * 1024);

    // The revision then refers to chunks the server already has, and they
    // are neither stored nor counted a second time.
    items.batch(iter::once(&file), None).unwrap();
    let after = query_i64(
        "SELECT bytes_used FROM collections WHERE uid = $1",
        collection.uid(),
    );
    assert!(after - before < 2048, "chunks were counted twice");
    assert_eq!(
        items.fetch(file.uid(), None).unwrap().content().unwrap(),
        content
    );
}

/// A client asks for fifty items, not for fifty megabytes. A page that
/// would carry too much ends early, and the client carries on from the
/// cursor exactly as it does after a full page.
#[test]
fn page_of_large_items_ends_early_and_nothing_is_lost() {
    const KIB: usize = 1024;
    let url = common::start_server(|config| config.max_page_bytes = 300 * KIB as i64);
    let account = common::signup_at(&url, "owner");
    let collection = new_collection(&account, "attachments");
    let items = account
        .collection_manager()
        .unwrap()
        .item_manager(&collection)
        .unwrap();

    // Five of 200 KiB, so two never fit one page, and one larger than any
    // page.
    let mut contents = Vec::new();
    for seed in 0..5u8 {
        contents.push(etebase::utils::randombytes_deterministic(
            200 * KIB,
            &[seed; 32],
        ));
    }
    contents.push(etebase::utils::randombytes_deterministic(
        700 * KIB,
        &[9; 32],
    ));
    for content in &contents {
        let item = items.create(&named("attachment"), content).unwrap();
        items.batch(iter::once(&item), None).unwrap();
    }

    let mut fetched = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        let options = FetchOptions::new().stoken(cursor.as_deref()).limit(50);
        let page = items.list(Some(&options)).unwrap();
        pages += 1;
        assert!(pages <= 10, "the list never finished");
        // Every page moves on, including the one holding the oversized item.
        assert_eq!(page.data().len(), 1, "page {pages}");
        for item in page.data() {
            fetched.push(item.content().unwrap());
        }
        cursor = page.stoken().map(str::to_owned);
        if page.done() {
            break;
        }
    }
    assert_eq!(pages, 6);
    assert_eq!(fetched, contents);

    // Without content a page is not cut short: there is nothing to weigh.
    let lean = FetchOptions::new()
        .prefetch(&PrefetchOption::Medium)
        .limit(50);
    let page = items.list(Some(&lean)).unwrap();
    assert_eq!(page.data().len(), 6);
    assert!(page.done());
}
