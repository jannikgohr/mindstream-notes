//! What is stored, what is charged for it, and what comes back out.
//!
//! These write revisions by hand, because the things tested here are things
//! the app's own client never sends: content under a deletion flag, a chunk
//! named many times, more in one request than a response should hold.

mod common;

use common::keyed::new_uid;
use common::raw::{Device, READ_ONLY};
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
    #[serde(
        rename = "encryptionKey",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    encryption_key: Option<ByteBuf>,
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
        encryption_key: None,
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

/// The storage budget belongs to the account, not to one collection. Two
/// writes to different collections that check it at the same time must not
/// both be let through on the same room.
#[tokio::test]
async fn concurrent_writes_to_different_collections_share_one_budget() {
    let device = Device::signup(common::server(), "quota-race").await;
    let pool = pool().await;
    sqlx::query(
        "INSERT INTO entitlements (account_id, storage_limit_bytes)
         SELECT id, $1 FROM accounts WHERE username = $2",
    )
    .bind(2 * 1024 * KIB as i64)
    .bind(&device.name)
    .execute(&pool)
    .await
    .unwrap();

    // Each collection is a few bytes of its own; the room left is for one
    // megabyte and a bit, so a second megabyte cannot honestly fit.
    let mut collections = Vec::new();
    for _ in 0..32 {
        collections.push(device.create_collection().await);
    }
    // Send them all at once, each on a client of its own, the way separate
    // devices of one account would.
    let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(collections.len()));
    let mut tasks = Vec::new();
    for collection in &collections {
        let barrier = barrier.clone();
        let client = reqwest::Client::new();
        let token = device.token.clone();
        let url = device.url.clone();
        let collection = collection.clone();
        tasks.push(tokio::spawn(async move {
            let item = revision(&new_uid(), false, vec![chunk(4, 1024 * KIB)]);
            let body = Batch { items: vec![item] };
            barrier.wait().await;
            let response = client
                .post(format!("{url}/api/v1/collection/{collection}/item/batch/"))
                .header("Authorization", format!("Token {token}"))
                .body(rmp_serde::to_vec_named(&body).unwrap())
                .send()
                .await
                .expect("push");
            response.status().as_u16()
        }));
    }
    let mut results = Vec::new();
    for task in tasks {
        results.push(task.await.expect("join"));
    }
    let stored = results.iter().filter(|status| **status == 200).count();
    assert!(stored >= 1, "not one write went through: {results:?}");

    let used: i64 = sqlx::query_scalar(
        "SELECT COALESCE(sum(c.bytes_used), 0)::bigint
         FROM collections c JOIN accounts a ON a.id = c.owner_id
         WHERE a.username = $1",
    )
    .bind(&device.name)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        used <= 2 * 1024 * KIB as i64,
        "{stored} writes stored {used} bytes on a 2 MiB plan"
    );
}

/// A chunk upload bigger than any chunk may be is refused before it is
/// buffered, not after the whole body is in memory.
#[tokio::test]
async fn oversized_chunk_upload_is_refused_up_front() {
    let device = Device::signup(common::server(), "chunk-cap").await;
    let collection = device.create_collection().await;
    let upload = |bytes: usize| upload_bytes(&device, &collection, bytes);
    assert_eq!(upload(3 * 1024 * 1024).await, 413);
    // A chunk of exactly the largest legal size still reaches the handler.
    assert_eq!(upload(1024 * 1024).await, 201);
}

async fn upload_bytes(device: &Device, collection: &str, bytes: usize) -> u16 {
    reqwest::Client::new()
        .put(format!(
            "{}/api/v1/collection/{collection}/item/{}/chunk/{}/",
            device.url,
            new_uid(),
            new_uid()
        ))
        .header("Authorization", format!("Token {}", device.token))
        .body(vec![7u8; bytes])
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

/// A deletion that names stored chunks is not a deletion: the references
/// would keep those bytes alive without counting against any limit, past a
/// plan that allows nothing.
#[tokio::test]
async fn tombstone_may_not_reference_chunks() {
    let device = Device::signup(common::server(), "tombstone-refs").await;
    let collection = device.create_collection().await;
    let existing = new_uid();
    let stored_uid = new_uid();
    let stored = push(
        &device,
        &collection,
        vec![revision(
            &existing,
            false,
            vec![(stored_uid.clone(), Some(ByteBuf::from(vec![7u8; KIB])))],
        )],
    )
    .await;
    assert_eq!(stored.0, 200);
    let pool = pool().await;
    lapse(&pool, &device).await;
    let before = bytes_used(&pool, &collection).await;

    // Deleted, but naming the stored chunk: a write like any other.
    let pinned = revision(&existing, true, vec![(stored_uid, None)]);
    assert_eq!(
        push(&device, &collection, vec![pinned]).await,
        (402, "plan_lapsed".to_owned())
    );
    assert_eq!(bytes_used(&pool, &collection).await, before);
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

/// What the account's usage page reports.
async fn usage(device: &Device) -> serde_json::Value {
    reqwest::Client::new()
        .get(format!("{}/api/v1/mindstream/usage/", device.url))
        .header("Authorization", format!("Token {}", device.token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn put_chunk(device: &Device, collection: &str, content: Vec<u8>) -> u16 {
    reqwest::Client::new()
        .put(format!(
            "{}/api/v1/collection/{collection}/item/{}/chunk/{}/",
            device.url,
            new_uid(),
            new_uid()
        ))
        .header("Authorization", format!("Token {}", device.token))
        .body(content)
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

/// Deleting a collection drops what it held: its items, their content, and
/// chunks uploaded for items that never came. The owner stops paying for
/// any of it, and for the collection as a space. Nothing can be put back.
#[tokio::test]
async fn deleting_a_collection_drops_what_it_held() {
    let dir = std::env::temp_dir().join(format!("mindstream-deleted-space-{}", new_uid()));
    let url = {
        let dir = dir.clone();
        common::start_server(move |config| config.blob_dir = dir)
    };
    let device = Device::signup(&url, "deleted-space").await;
    let collection = device.create_collection().await;
    let pool = pool().await;
    let empty = bytes_used(&pool, &collection).await;
    let items = vec![
        revision(&new_uid(), false, vec![chunk(1, 4 * KIB)]),
        revision(&new_uid(), false, vec![chunk(2, 100 * KIB)]),
    ];
    assert_eq!(push(&device, &collection, items).await.0, 200);
    assert_eq!(
        put_chunk(&device, &collection, vec![3; 100 * KIB]).await,
        201
    );
    assert_eq!(count(&pool, "chunks", &collection).await, 3);
    assert_eq!(usage(&device).await["spaces"], 1);

    let deletion = revision(&collection, true, Vec::new());
    assert_eq!(push(&device, &collection, vec![deletion]).await.0, 200);

    assert_eq!(count(&pool, "chunks", &collection).await, 0);
    assert_eq!(count(&pool, "revisions", &collection).await, 0);
    let after = bytes_used(&pool, &collection).await;
    assert!(
        after < empty + KIB as i64,
        "the deletion left {after} bytes charged, {empty} before anything was in it"
    );
    let reported = usage(&device).await;
    assert_eq!(reported["spaces"], 0);
    assert_eq!(reported["storageUsedBytes"], after);
    let blobs = dir.join(format!("{}/{collection}", &collection[..2]));
    let on_disk = || std::fs::read_dir(&blobs).map_or(0, |entries| entries.count());
    let settled = async {
        while on_disk() > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    };
    if tokio::time::timeout(std::time::Duration::from_secs(5), settled)
        .await
        .is_err()
    {
        panic!("{} blob(s) outlived the collection", on_disk());
    }

    // The collection's own item may be marked deleted again, a retry by
    // another name. Nothing else may be written.
    let again = revision(&collection, true, Vec::new());
    assert_eq!(push(&device, &collection, vec![again]).await.0, 200);
    let refused = (403, "collection_deleted".to_owned());
    let revived = revision(&collection, false, Vec::new());
    assert_eq!(push(&device, &collection, vec![revived]).await, refused);
    let late = revision(&new_uid(), false, vec![chunk(4, KIB)]);
    assert_eq!(push(&device, &collection, vec![late]).await, refused);
    assert_eq!(put_chunk(&device, &collection, vec![5; KIB]).await, 403);
    assert_eq!(count(&pool, "chunks", &collection).await, 0);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Create {
    item: Item,
    collection_key: ByteBuf,
    collection_type: ByteBuf,
}

/// Make a collection with these keys and return its status and uid.
async fn create_with(device: &Device, key: &[u8], kind: &[u8]) -> (u16, String) {
    let collection = new_uid();
    let body = Create {
        item: Item {
            uid: collection.clone(),
            version: 1,
            encryption_key: None,
            content: Revision {
                uid: new_uid(),
                meta: ByteBuf::from(b"meta".to_vec()),
                deleted: false,
                chunks: Vec::new(),
            },
        },
        collection_key: ByteBuf::from(key.to_vec()),
        collection_type: ByteBuf::from(kind.to_vec()),
    };
    let (status, _) = device.call(Method::POST, "/collection/", Some(&body)).await;
    (status, collection)
}

/// A collection key is a key, not somewhere to keep content. Sharing and
/// links already hold a membership key to the size the app sends; creating
/// a collection does too, so the bytes cannot be parked outside what a plan
/// counts.
#[tokio::test]
async fn collection_keys_are_held_to_a_size_the_app_uses() {
    let device = Device::signup(common::server(), "collection-key-cap").await;
    let too_big = vec![7u8; 4096 + 1];
    assert_eq!(create_with(&device, &too_big, b"type").await.0, 400);
    assert_eq!(create_with(&device, b"key", &too_big).await.0, 400);
    assert_eq!(create_with(&device, b"", b"type").await.0, 400);

    let (status, collection) = create_with(&device, &[7u8; 4096], &[8u8; 4096]).await;
    assert_eq!(status, 201);
    let pool = pool().await;
    let used = bytes_used(&pool, &collection).await;
    assert!(
        used >= 8192,
        "the collection keys were stored but only {used} bytes were counted"
    );
}

/// The same for an item's key: a revision may carry one, but not megabytes
/// of one that no plan counts.
#[tokio::test]
async fn item_keys_are_held_to_a_size_the_app_uses() {
    let device = Device::signup(common::server(), "item-key-cap").await;
    let collection = device.create_collection().await;

    let mut entry = revision(&new_uid(), false, Vec::new());
    entry.encryption_key = Some(ByteBuf::from(vec![7u8; 4096 + 1]));
    assert_eq!(
        push(&device, &collection, vec![entry]).await,
        (400, "bad_request".to_owned())
    );

    let mut entry = revision(&new_uid(), false, Vec::new());
    entry.encryption_key = Some(ByteBuf::from(vec![7u8; 4096]));
    assert_eq!(push(&device, &collection, vec![entry]).await.0, 200);
}

/// Put an account on a plan with a storage limit before it writes anything.
async fn plan(pool: &sqlx::PgPool, device: &Device, bytes: i64) {
    sqlx::query(
        "INSERT INTO entitlements (account_id, storage_limit_bytes)
         SELECT id, $1 FROM accounts WHERE username = $2",
    )
    .bind(bytes)
    .bind(&device.name)
    .execute(pool)
    .await
    .unwrap();
}

/// A key is stored bytes. A plan that counts only content and metadata can
/// be filled with keys, and an item may carry one with no content at all.
#[tokio::test]
async fn item_keys_count_against_storage() {
    let device = Device::signup(common::server(), "item-key-plan").await;
    let pool = pool().await;
    // Enough for the collection's own keys and one 4 KiB item key.
    plan(&pool, &device, 6 * KIB as i64).await;
    let collection = device.create_collection().await;

    let mut first = revision(&new_uid(), false, Vec::new());
    first.encryption_key = Some(ByteBuf::from(vec![7u8; 4096]));
    assert_eq!(push(&device, &collection, vec![first]).await.0, 200);
    let counted = bytes_used(&pool, &collection).await;
    assert!(
        counted >= 4096,
        "the item key was stored but only {counted} bytes were counted"
    );

    let mut second = revision(&new_uid(), false, Vec::new());
    second.encryption_key = Some(ByteBuf::from(vec![7u8; 4096]));
    assert_eq!(
        push(&device, &collection, vec![second]).await,
        (402, "storage_full".to_owned()),
        "a second key fit a plan that counts keys"
    );
}

/// A chunk uid is stored bytes too. Zero-byte chunks with long names could
/// otherwise fill a collection for free.
#[tokio::test]
async fn chunk_uids_count_against_storage() {
    let device = Device::signup(common::server(), "chunk-uid-plan").await;
    let pool = pool().await;
    plan(&pool, &device, 8 * KIB as i64).await;
    let collection = device.create_collection().await;

    let named = |start: u32| -> Vec<(String, Option<ByteBuf>)> {
        (start..start + 100)
            .map(|i| (format!("{i:0>64}"), Some(ByteBuf::from(Vec::new()))))
            .collect()
    };
    assert_eq!(
        push(
            &device,
            &collection,
            vec![revision(&new_uid(), false, named(0))]
        )
        .await
        .0,
        200
    );
    let counted = bytes_used(&pool, &collection).await;
    assert!(
        counted >= 6400,
        "the chunk uids were stored but only {counted} bytes were counted"
    );

    assert_eq!(
        push(
            &device,
            &collection,
            vec![revision(&new_uid(), false, named(100))]
        )
        .await,
        (402, "storage_full".to_owned()),
        "a second set of chunk names fit a plan that counts them"
    );
}

/// A page without content still carries every chunk uid of every item. The
/// budget has to weigh those names, or `prefetch=medium` returns as much as
/// the collection holds.
#[tokio::test]
async fn medium_prefetch_page_is_held_to_the_budget() {
    let url = common::start_server(|config| config.max_page_bytes = 512 * KIB as i64);
    let device = Device::signup(&url, "medium-page").await;
    let collection = device.create_collection().await;

    // The same thousand names, shared by a hundred items.
    let names: Vec<(String, Option<ByteBuf>)> = (0..1000u32)
        .map(|i| (format!("{i:0>64}"), Some(ByteBuf::from(Vec::new()))))
        .collect();
    let items = (0..100)
        .map(|_| revision(&new_uid(), false, names.clone()))
        .collect();
    assert_eq!(push(&device, &collection, items).await.0, 200);

    let response = reqwest::Client::new()
        .get(format!(
            "{}/api/v1/collection/{collection}/item/?prefetch=medium&limit=1000",
            device.url
        ))
        .header("Authorization", format!("Token {}", device.token))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body = response.bytes().await.unwrap();
    assert!(
        body.len() < 700 * KIB,
        "a medium page ignored the budget: {} bytes",
        body.len()
    );
}

/// An invitation carries a preview of the collection's main item. That item
/// may name 32,768 chunks, and a page may hold a thousand invitations; the
/// previews have to share the same page budget as everything else.
#[tokio::test]
async fn invitation_previews_are_held_to_the_page_budget() {
    let url = common::start_server(|config| config.max_page_bytes = 512 * KIB as i64);
    let owner = Device::signup(&url, "preview-owner").await;
    let guest = Device::signup(&url, "preview-guest").await;
    let collection = owner.create_collection().await;

    let names: Vec<(String, Option<ByteBuf>)> = (0..32_768u32)
        .map(|i| (format!("{i:0>64}"), Some(ByteBuf::from(Vec::new()))))
        .collect();
    assert_eq!(
        push(
            &owner,
            &collection,
            vec![revision(&collection, false, names)]
        )
        .await
        .0,
        200
    );
    owner.invite(&collection, &guest, READ_ONLY).await;

    let response = reqwest::Client::new()
        .get(format!(
            "{}/api/v1/invitation/incoming/?limit=1000",
            guest.url
        ))
        .header("Authorization", format!("Token {}", guest.token))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body = response.bytes().await.unwrap();
    assert!(
        body.len() < 700 * KIB,
        "an invitation preview ignored the budget: {} bytes",
        body.len()
    );
}
