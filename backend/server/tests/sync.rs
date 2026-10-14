//! What the server promises a syncing client beyond the wire format: that a
//! cursor never skips a change, that large content survives the trip through
//! the blob store, and that storage is counted.

mod common;

use std::collections::{HashMap, HashSet};
use std::iter;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use common::{named, new_collection, share, signup, COLLECTION_TYPE};
use etebase::{CollectionAccessLevel, FetchOptions, Item, PrefetchOption};

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

/// A device asks once what changed and visits only that. So the one answer
/// has to name every collection the device must look at: one of either type
/// it asked about, one whose rights changed, one it has just joined and one
/// that was deleted. And nothing else.
#[test]
fn idle_check_names_every_collection_a_device_has_to_visit() {
    const OTHER_TYPE: &str = "test.other-space";
    let types = [COLLECTION_TYPE, OTHER_TYPE];
    let owner = signup("owner");
    let guest = signup("guest");
    let owner_collections = owner.collection_manager().unwrap();
    let guest_collections = guest.collection_manager().unwrap();

    // The guest has a collection of each type, and is a reader of one of
    // the owner's.
    let plain = new_collection(&guest, "plain");
    let other = guest_collections
        .create(OTHER_TYPE, &named("other"), b"")
        .unwrap();
    guest_collections.upload(&other, None).unwrap();
    let shared = new_collection(&owner, "shared");
    share(&owner, &shared, &guest, CollectionAccessLevel::ReadOnly);

    // Everything, once, and from then on nothing.
    let everything = guest_collections.list_multi(types, None).unwrap();
    assert!(everything.done());
    let listed: HashSet<&str> = everything.data().iter().map(|c| c.uid()).collect();
    assert_eq!(
        listed,
        HashSet::from([plain.uid(), other.uid(), shared.uid()])
    );
    let mut cursor = everything.stoken().map(str::to_owned);
    let changed_since = |cursor: &Option<String>| {
        let options = FetchOptions::new().stoken(cursor.as_deref());
        let page = guest_collections.list_multi(types, Some(&options)).unwrap();
        assert!(page.done());
        let uids: HashSet<String> = page.data().iter().map(|c| c.uid().to_owned()).collect();
        let removed: Vec<String> = page
            .removed_memberships()
            .map(|gone| gone.iter().map(|c| c.uid().to_string()).collect())
            .unwrap_or_default();
        (uids, removed, page.stoken().map(str::to_owned))
    };
    let (uids, removed, same) = changed_since(&cursor);
    assert!(uids.is_empty() && removed.is_empty());
    // Nothing changed, so there is nowhere new for the cursor to be.
    assert_eq!(same, cursor);

    // An item in the collection of the second type.
    let items = guest_collections.item_manager(&other).unwrap();
    let note = items.create(&named("note"), b"body").unwrap();
    items.batch(iter::once(&note), None).unwrap();
    let (uids, removed, next) = changed_since(&cursor);
    assert_eq!(uids, HashSet::from([other.uid().to_owned()]));
    assert!(removed.is_empty());
    cursor = next;

    // The owner lets the guest write. Nothing in the collection changed,
    // and the guest's device still has to hear of it.
    owner_collections
        .member_manager(&shared)
        .unwrap()
        .modify_access_level(&guest.name, CollectionAccessLevel::ReadWrite)
        .unwrap();
    let options = FetchOptions::new().stoken(cursor.as_deref());
    let page = guest_collections.list_multi(types, Some(&options)).unwrap();
    assert_eq!(page.data().len(), 1);
    assert_eq!(page.data()[0].uid(), shared.uid());
    assert_eq!(
        page.data()[0].access_level(),
        CollectionAccessLevel::ReadWrite
    );
    cursor = page.stoken().map(str::to_owned);

    // The owner changes what the collection says about itself: its name
    // here, and in the app the key material of its live sessions too.
    let mut renamed = owner_collections.fetch(shared.uid(), None).unwrap();
    renamed.set_meta(&named("shared, renamed")).unwrap();
    renamed.set_content(b"a new manifest").unwrap();
    owner_collections.upload(&renamed, None).unwrap();
    let options = FetchOptions::new().stoken(cursor.as_deref());
    let page = guest_collections.list_multi(types, Some(&options)).unwrap();
    assert_eq!(page.data().len(), 1);
    assert_eq!(page.data()[0].uid(), shared.uid());
    assert_eq!(page.data()[0].content().unwrap(), b"a new manifest");
    cursor = page.stoken().map(str::to_owned);

    // A collection the guest joins after the cursor.
    let joined = new_collection(&owner, "joined");
    share(&owner, &joined, &guest, CollectionAccessLevel::ReadWrite);
    let (uids, removed, next) = changed_since(&cursor);
    assert_eq!(uids, HashSet::from([joined.uid().to_owned()]));
    assert!(removed.is_empty());
    cursor = next;

    // One that its owner deletes, which is how sharing stops, takes the
    // guest out of it, and is reported as lost.
    let mut doomed = owner_collections.fetch(joined.uid(), None).unwrap();
    doomed.delete().unwrap();
    owner_collections.upload(&doomed, None).unwrap();
    let (uids, removed, next) = changed_since(&cursor);
    assert!(uids.is_empty());
    assert_eq!(removed, vec![joined.uid().to_owned()]);
    cursor = next;

    // One the guest is taken out of is reported as lost, and with that the
    // device is level again.
    owner_collections
        .member_manager(&shared)
        .unwrap()
        .remove(&guest.name)
        .unwrap();
    let (uids, removed, next) = changed_since(&cursor);
    assert!(uids.is_empty());
    assert_eq!(removed, vec![shared.uid().to_owned()]);
    let (uids, removed, _) = changed_since(&next);
    assert!(uids.is_empty() && removed.is_empty());

    // A type that was not asked about is left out, changed or not.
    let (uids, _, _) = {
        let page = guest_collections
            .list_multi([COLLECTION_TYPE], None)
            .unwrap();
        let uids: HashSet<String> = page.data().iter().map(|c| c.uid().to_owned()).collect();
        (uids, (), ())
    };
    assert!(uids.contains(plain.uid()));
    assert!(!uids.contains(other.uid()));
}

/// A push asks for the items it is about to change by name, many at a time
/// and without their content, and builds the next revision on what comes
/// back. So an item that came without content has to take new content, and
/// a deletion, like one that came whole.
#[test]
fn item_fetched_without_content_takes_new_content_and_a_deletion() {
    let account = signup("solo");
    let collection = new_collection(&account, "space");
    let items = account
        .collection_manager()
        .unwrap()
        .item_manager(&collection)
        .unwrap();
    let kept = items.create(&named("kept"), b"old content").unwrap();
    let doomed = items.create(&named("doomed"), b"more old content").unwrap();
    let untouched = items.create(&named("untouched"), b"left alone").unwrap();
    items
        .batch([&kept, &doomed, &untouched].into_iter(), None)
        .unwrap();

    // Two of the three by name, and one name the server has nothing under.
    let unknown = etebase::utils::to_base64(&etebase::utils::randombytes(32)).unwrap();
    let without_content = PrefetchOption::Medium;
    let options = FetchOptions::new().prefetch(&without_content);
    let fetched = items
        .fetch_multi(
            [kept.uid(), doomed.uid(), unknown.as_str()].into_iter(),
            Some(&options),
        )
        .unwrap();
    // The unknown one is left out. It is not an error.
    let mut by_uid: HashMap<String, Item> = fetched
        .data()
        .iter()
        .map(|item| (item.uid().to_owned(), item.clone()))
        .collect();
    assert_eq!(by_uid.len(), 2);
    for item in by_uid.values() {
        assert!(
            item.is_missing_content(),
            "{} came with content",
            item.uid()
        );
        // What it is called is in the revision, so it is there all the same.
        assert!(item.meta().unwrap().name().is_some());
    }

    let mut edited = by_uid.remove(kept.uid()).unwrap();
    edited.set_meta(&named("kept, renamed")).unwrap();
    edited.set_content(b"new content").unwrap();
    let mut deleted = by_uid.remove(doomed.uid()).unwrap();
    deleted.delete().unwrap();
    items
        .transaction([&edited, &deleted].into_iter(), None)
        .unwrap();

    let now = items.fetch(kept.uid(), None).unwrap();
    assert_eq!(now.content().unwrap(), b"new content");
    assert_eq!(now.meta().unwrap().name(), Some("kept, renamed"));
    assert!(items.fetch(doomed.uid(), None).unwrap().is_deleted());
    assert_eq!(
        items
            .fetch(untouched.uid(), None)
            .unwrap()
            .content()
            .unwrap(),
        b"left alone"
    );

    // Built on a revision that is no longer the latest, a change is still
    // refused, content or no content: that is what keeps two devices from
    // overwriting each other.
    let mut stale = fetched
        .data()
        .iter()
        .find(|item| item.uid() == kept.uid())
        .unwrap()
        .clone();
    stale
        .set_content(b"from the device that fell behind")
        .unwrap();
    assert!(matches!(
        items.transaction(std::iter::once(&stale), None),
        Err(etebase::error::Error::Conflict(_))
    ));
    assert_eq!(
        items.fetch(kept.uid(), None).unwrap().content().unwrap(),
        b"new content"
    );
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
    let mut largest = String::new();
    for content in &contents {
        let item = items.create(&named("attachment"), content).unwrap();
        items.batch(iter::once(&item), None).unwrap();
        largest = item.uid().to_owned();
    }

    let mut fetched = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    let mut oversized = 0;
    loop {
        let options = FetchOptions::new().stoken(cursor.as_deref()).limit(50);
        let page = items.list(Some(&options)).unwrap();
        pages += 1;
        assert!(pages <= 10, "the list never finished");
        // Every page moves on, including the one holding the oversized item.
        assert_eq!(page.data().len(), 1, "page {pages}");
        for item in page.data() {
            let mut item = item.clone();
            // The item no page has room for arrives as the uids of its
            // chunks, and the client fetches those one at a time.
            if item.is_missing_content() {
                oversized += 1;
                items.download_content(&mut item).unwrap();
            }
            fetched.push(item.content().unwrap());
        }
        cursor = page.stoken().map(str::to_owned);
        if page.done() {
            break;
        }
    }
    assert_eq!(pages, 6);
    assert_eq!(fetched, contents);
    assert_eq!(oversized, 1);

    // Asked for by itself, the oversized item comes back whole: the client
    // library goes and gets what the server held back.
    let oversized = items.fetch(&largest, None).unwrap();
    assert!(!oversized.is_missing_content());
    assert_eq!(oversized.content().unwrap(), contents[5]);

    // Without content a page is not cut short: there is nothing to weigh.
    let lean = FetchOptions::new()
        .prefetch(&PrefetchOption::Medium)
        .limit(50);
    let page = items.list(Some(&lean)).unwrap();
    assert_eq!(page.data().len(), 6);
    assert!(page.done());
}
