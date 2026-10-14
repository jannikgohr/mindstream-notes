//! What is stored, what is charged for it, and what comes back out.
//!
//! These write revisions by hand, because the things tested here are things
//! the app's own client never sends: content under a deletion flag, a chunk
//! named many times, more in one request than a response should hold.

mod common;

use common::keyed::new_uid;
use common::raw::Device;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;

const KIB: usize = 1024;

#[derive(Serialize)]
struct Revision {
    uid: String,
    meta: ByteBuf,
    deleted: bool,
    chunks: Vec<(String, Option<ByteBuf>)>,
}

#[derive(Serialize)]
struct Item {
    uid: String,
    version: u8,
    content: Revision,
}

#[derive(Serialize)]
struct Batch {
    items: Vec<Item>,
}

/// A chunk with content of its own: `len` bytes that depend on `seed`.
fn chunk(seed: u8, len: usize) -> (String, Option<ByteBuf>) {
    let content: Vec<u8> = (0..len).map(|i| seed.wrapping_add(i as u8)).collect();
    (new_uid(), Some(ByteBuf::from(content)))
}

/// A revision of `item` with these chunks.
fn revision(item: &str, deleted: bool, chunks: Vec<(String, Option<ByteBuf>)>) -> Item {
    Item {
        uid: item.to_owned(),
        version: 1,
        content: Revision {
            uid: new_uid(),
            meta: ByteBuf::from(b"meta".to_vec()),
            deleted,
            chunks,
        },
    }
}

async fn push(device: &Device, collection: &str, items: Vec<Item>) -> (u16, String) {
    let path = format!("/collection/{collection}/item/batch/");
    let (status, body) = device
        .call(Method::POST, &path, Some(&Batch { items }))
        .await;
    (status, body["code"].as_str().unwrap_or("").to_owned())
}

async fn pool() -> sqlx::PgPool {
    sqlx::PgPool::connect(&common::database_url())
        .await
        .expect("connect to the test database")
}

async fn bytes_used(pool: &sqlx::PgPool, collection: &str) -> i64 {
    sqlx::query_scalar("SELECT bytes_used FROM collections WHERE uid = $1")
        .bind(collection)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn count(pool: &sqlx::PgPool, what: &str, collection: &str) -> i64 {
    let sql = match what {
        "chunks" => {
            "SELECT count(*) FROM chunks k JOIN collections c ON c.id = k.collection_id
             WHERE c.uid = $1"
        }
        "revisions" => {
            "SELECT count(*) FROM revisions r JOIN items i ON i.id = r.item_id
             JOIN collections c ON c.id = i.collection_id
             WHERE c.uid = $1 AND NOT i.is_main"
        }
        other => panic!("cannot count {other}"),
    };
    sqlx::query_scalar(sql)
        .bind(collection)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Put the account on a plan that has lapsed and allows nothing.
async fn lapse(pool: &sqlx::PgPool, device: &Device) {
    sqlx::query(
        "INSERT INTO entitlements (account_id, storage_limit_bytes, max_item_bytes, read_only)
         SELECT id, 0, 0, true FROM accounts WHERE username = $1",
    )
    .bind(&device.name)
    .execute(pool)
    .await
    .unwrap();
}

/// The exception that lets deletions past a lapsed or full plan is for
/// deletions. Calling a write a deletion does not make it one.
#[tokio::test]
async fn content_marked_deleted_is_held_to_the_plan_like_any_other() {
    let device = Device::signup(common::server(), "quota-bypass").await;
    let collection = device.create_collection().await;
    let existing = new_uid();
    let stored = push(
        &device,
        &collection,
        vec![revision(&existing, false, vec![chunk(1, 30 * KIB)])],
    )
    .await;
    assert_eq!(stored.0, 200);
    let pool = pool().await;
    lapse(&pool, &device).await;
    let before = bytes_used(&pool, &collection).await;

    // A new item that says it is deleted, with a megabyte in it.
    let smuggled = revision(&new_uid(), true, vec![chunk(2, 1024 * KIB)]);
    assert_eq!(
        push(&device, &collection, vec![smuggled]).await,
        (402, "plan_lapsed".to_owned())
    );
    // The same against an item that exists: deleted, and with new content.
    let smuggled = revision(&existing, true, vec![chunk(3, 1024 * KIB)]);
    assert_eq!(
        push(&device, &collection, vec![smuggled]).await,
        (402, "plan_lapsed".to_owned())
    );
    assert_eq!(bytes_used(&pool, &collection).await, before);

    // An actual deletion goes through, as it must: it is how an account
    // that may store nothing more is tidied up.
    let tombstone = revision(&existing, true, Vec::new());
    assert_eq!(push(&device, &collection, vec![tombstone]).await.0, 200);
}

/// A new chunk is stored with the first content the request gives it,
/// whichever item that comes with, and is charged for that content even
/// when an item before it names the chunk without any.
#[tokio::test]
async fn chunk_named_before_its_content_is_charged_for_that_content() {
    let device = Device::signup(common::server(), "content-later").await;
    let collection = device.create_collection().await;
    let pool = pool().await;
    sqlx::query(
        "INSERT INTO entitlements (account_id, storage_limit_bytes)
         SELECT id, $2 FROM accounts WHERE username = $1",
    )
    .bind(&device.name)
    .bind(KIB as i64)
    .execute(&pool)
    .await
    .unwrap();
    let before = bytes_used(&pool, &collection).await;

    let (shared, content) = chunk(1, 4 * KIB);
    let items = vec![
        revision(&new_uid(), false, vec![(shared.clone(), None)]),
        revision(&new_uid(), false, vec![(shared, content)]),
    ];
    assert_eq!(
        push(&device, &collection, items).await,
        (402, "storage_full".to_owned())
    );
    assert_eq!(bytes_used(&pool, &collection).await, before);
    assert_eq!(count(&pool, "chunks", &collection).await, 0);
}

/// A write that fails after its content went to the blob store takes the
/// blob out again. Here it fails on a revision uid the item has used
/// before, which comes to light only once the content is stored.
#[tokio::test]
async fn failed_write_leaves_no_blob_behind() {
    let dir = std::env::temp_dir().join(format!("mindstream-failed-write-{}", new_uid()));
    let url = {
        let dir = dir.clone();
        common::start_server(move |config| config.blob_dir = dir)
    };
    let device = Device::signup(&url, "failed-write").await;
    let collection = device.create_collection().await;
    let item = new_uid();
    let first = revision(&item, false, vec![chunk(1, 100 * KIB)]);
    let used_before = first.content.uid.clone();
    assert_eq!(push(&device, &collection, vec![first]).await.0, 200);
    let second = revision(&item, false, vec![chunk(2, KIB)]);
    assert_eq!(push(&device, &collection, vec![second]).await.0, 200);

    let mut again = revision(&item, false, vec![chunk(3, 100 * KIB)]);
    again.content.uid = used_before;
    assert_eq!(
        push(&device, &collection, vec![again]).await,
        (409, "item_failed".to_owned())
    );

    // What is on disk comes down to the one blob a row points into. The
    // other goes as the failed request unwinds, so it may take a moment.
    let pool = pool().await;
    let kept: Vec<String> = sqlx::query_scalar(
        "SELECT k.blob_key FROM chunks k JOIN collections c ON c.id = k.collection_id
         WHERE c.uid = $1 AND k.blob_key IS NOT NULL",
    )
    .bind(&collection)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(kept.len(), 1);
    let blobs = format!("{}/{collection}", &collection[..2]);
    let on_disk = || -> Vec<String> {
        std::fs::read_dir(dir.join(&blobs))
            .map(|entries| {
                entries
                    .map(|entry| {
                        let name = entry.unwrap().file_name();
                        format!("{blobs}/{}", name.to_string_lossy())
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    let settled = async {
        while on_disk() != kept {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    };
    if tokio::time::timeout(std::time::Duration::from_secs(5), settled)
        .await
        .is_err()
    {
        panic!("on disk: {:?}, pointed into: {kept:?}", on_disk());
    }
}

/// Deleting an item gives its storage back: the content goes, its earlier
/// revisions go, and what is left is the tombstone.
#[tokio::test]
async fn deleting_an_item_releases_what_it_stored() {
    let device = Device::signup(common::server(), "deletion-accounting").await;
    let collection = device.create_collection().await;
    let pool = pool().await;
    let empty = bytes_used(&pool, &collection).await;

    // Two revisions with content: one small enough for a database row, one
    // that goes to the blob store.
    let item = new_uid();
    for content in [chunk(1, 4 * KIB), chunk(2, 100 * KIB)] {
        let pushed = push(
            &device,
            &collection,
            vec![revision(&item, false, vec![content])],
        );
        assert_eq!(pushed.await.0, 200);
    }
    let full = bytes_used(&pool, &collection).await;
    assert!(full >= empty + 104 * KIB as i64, "full={full}");
    assert_eq!(count(&pool, "chunks", &collection).await, 2);

    let tombstone = revision(&item, true, Vec::new());
    assert_eq!(push(&device, &collection, vec![tombstone]).await.0, 200);

    let after = bytes_used(&pool, &collection).await;
    assert!(
        after < empty + KIB as i64,
        "the deletion left {after} bytes charged, {empty} before the item existed"
    );
    assert_eq!(count(&pool, "chunks", &collection).await, 0);
    assert_eq!(count(&pool, "revisions", &collection).await, 1);
    // Nothing points into a blob that is gone.
    let dangling: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM chunks k JOIN collections c ON c.id = k.collection_id
         WHERE c.uid = $1 AND k.blob_key IS NOT NULL",
    )
    .bind(&collection)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(dangling, 0);
}

/// A chunk two items share is stored once. Deleting one of the items must
/// leave it for the other.
#[tokio::test]
async fn chunk_still_used_by_another_item_survives_a_deletion() {
    let device = Device::signup(common::server(), "shared-chunk").await;
    let collection = device.create_collection().await;
    let shared = chunk(7, 50 * KIB);
    let reference = (shared.0.clone(), None);
    let (first, second) = (new_uid(), new_uid());
    let pushed = push(
        &device,
        &collection,
        vec![
            revision(&first, false, vec![shared]),
            revision(&second, false, vec![reference]),
        ],
    );
    assert_eq!(pushed.await.0, 200);
    let pool = pool().await;
    assert_eq!(count(&pool, "chunks", &collection).await, 1);

    let tombstone = revision(&first, true, Vec::new());
    assert_eq!(push(&device, &collection, vec![tombstone]).await.0, 200);

    assert_eq!(count(&pool, "chunks", &collection).await, 1);
    let path = format!("/collection/{collection}/item/{second}/");
    let (status, _) = device.call::<()>(Method::GET, &path, None).await;
    assert_eq!(status, 200, "the surviving item still reads");
}

/// An item keeps its current revision and a set number before it. The
/// revisions that fall off the end go, and their content with them.
#[tokio::test]
async fn item_keeps_only_its_last_few_revisions() {
    let url = common::start_server(|config| config.keep_revisions = 2);
    let device = Device::signup(&url, "history").await;
    let collection = device.create_collection().await;
    let item = new_uid();
    for edit in 0..6u8 {
        let pushed = push(
            &device,
            &collection,
            vec![revision(&item, false, vec![chunk(edit, 10 * KIB)])],
        );
        assert_eq!(pushed.await.0, 200);
    }

    let pool = pool().await;
    // The current one and the two before it.
    assert_eq!(count(&pool, "revisions", &collection).await, 3);
    assert_eq!(count(&pool, "chunks", &collection).await, 3);
    let used = bytes_used(&pool, &collection).await;
    assert!(
        (30 * KIB as i64..40 * KIB as i64).contains(&used),
        "three revisions of 10 KiB are charged, not six: {used}"
    );
}

/// A revision lists each chunk once. One that names a chunk over and over
/// costs a few bytes to send and would cost the server the chunk each time
/// to send back.
#[tokio::test]
async fn chunk_named_twice_in_one_revision_is_refused() {
    let device = Device::signup(common::server(), "repeated-chunk").await;
    let collection = device.create_collection().await;
    let content = chunk(1, 10 * KIB);
    let again = (content.0.clone(), None);
    let pushed = push(
        &device,
        &collection,
        vec![revision(&new_uid(), false, vec![content, again])],
    );
    assert_eq!(pushed.await.0, 400);
}

#[derive(Deserialize)]
struct Fetched {
    data: Vec<FetchedItem>,
}

#[derive(Deserialize)]
struct FetchedItem {
    uid: String,
    content: FetchedRevision,
}

#[derive(Deserialize)]
struct FetchedRevision {
    chunks: Vec<(String, Option<ByteBuf>)>,
}

impl FetchedItem {
    fn has_content(&self) -> bool {
        self.content.chunks.iter().all(|chunk| chunk.1.is_some())
    }
}

/// A response is built in memory, so every one that carries content is held
/// to the same budget, not only the paged list. What does not fit goes out
/// as the uids of its chunks, for the client to ask for again.
#[tokio::test]
async fn content_past_the_budget_goes_out_as_references() {
    let url = common::start_server(|config| config.max_page_bytes = 300 * KIB as i64);
    let device = Device::signup(&url, "budget").await;
    let collection = device.create_collection().await;
    let uids = [new_uid(), new_uid(), new_uid()];
    for (seed, uid) in uids.iter().enumerate() {
        let pushed = push(
            &device,
            &collection,
            vec![revision(uid, false, vec![chunk(seed as u8, 200 * KIB)])],
        );
        assert_eq!(pushed.await.0, 200);
    }

    async fn fetch(device: &Device, collection: &str, wanted: &[String]) -> Fetched {
        #[derive(Serialize)]
        struct Wanted<'a> {
            uid: &'a str,
        }
        let body: Vec<Wanted> = wanted.iter().map(|uid| Wanted { uid }).collect();
        let response = reqwest::Client::new()
            .post(format!(
                "{}/api/v1/collection/{collection}/item/fetch_updates/",
                device.url
            ))
            .header("Authorization", format!("Token {}", device.token))
            .body(rmp_serde::to_vec_named(&body).unwrap())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        rmp_serde::from_slice(&response.bytes().await.unwrap()).unwrap()
    }

    // Three of 200 KiB against a budget of 300: one comes whole.
    let all = fetch(&device, &collection, &uids).await;
    assert_eq!(all.data.len(), 3);
    let whole: Vec<&str> = all
        .data
        .iter()
        .filter(|item| item.has_content())
        .map(|item| item.uid.as_str())
        .collect();
    assert_eq!(whole.len(), 1, "{whole:?}");
    // The first in the answer is the one with content, so asking again for
    // the rest makes progress every time.
    assert!(all.data[0].has_content());

    // Asking for the rest brings the next one whole.
    let rest: Vec<String> = all.data[1..].iter().map(|item| item.uid.clone()).collect();
    let next = fetch(&device, &collection, &rest).await;
    assert_eq!(next.data.len(), 2);
    assert!(next.data[0].has_content());
    assert!(!next.data[1].has_content());
}
