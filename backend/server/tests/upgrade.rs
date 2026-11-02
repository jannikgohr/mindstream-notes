//! What a new release does to a database that is already in use.
//!
//! Every other test starts from an empty schema, where a migration that
//! changes rows has nothing to change.

mod common;

use std::path::PathBuf;

use mindstream_server::{admin, AppState, Config};
use sqlx::migrate::Migrator;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::PgPool;

/// A schema of its own in the test database, so that its migrations start
/// from nothing, and the options that reach it.
async fn empty_schema() -> (String, PgConnectOptions, PgPool) {
    let schema = format!("upgrade_{}", common::unique());
    let main = PgPool::connect_lazy(&common::database_url()).unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&main)
        .await
        .unwrap();
    let options: PgConnectOptions = common::database_url().parse().unwrap();
    (schema, options, main)
}

/// The migrations up to and including `last`, as they are in the source tree.
async fn migrations_up_to(last: u32) -> (Migrator, PathBuf) {
    let all = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let some = std::env::temp_dir().join(format!("mindstream-upgrade-{}", common::unique()));
    std::fs::create_dir(&some).unwrap();
    for entry in std::fs::read_dir(all).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_str().unwrap().to_owned();
        if name[..4].parse::<u32>().unwrap() <= last {
            std::fs::copy(&path, some.join(name)).unwrap();
        }
    }
    (Migrator::new(some.as_path()).await.unwrap(), some)
}

/// Two collections, as the last release left them: a shared one that has
/// been written to, with an invitation and a link waiting and someone taken
/// out, and one that holds only itself. What they are charged is what that
/// release counted, which is less than this one counts. The sizes are spelled
/// out so the test can add them up by hand.
const IN_USE: &str = r"
INSERT INTO accounts (username, username_key, email, version, salt, login_pubkey, pubkey,
                      encrypted_content)
SELECT name, name, name || '@test.local', 1, '\x00'::bytea, '\x00'::bytea, '\x00'::bytea,
       '\x00'::bytea
FROM unnest(ARRAY['owner', 'guest', 'gone', 'waiting']) AS name;

INSERT INTO collections (uid, owner_id, stoken, bytes_used)
SELECT uid, (SELECT id FROM accounts WHERE username = 'owner'), 9, 1
FROM unnest(ARRAY['shared', 'plain']) AS uid;

INSERT INTO items (collection_id, uid, version, encryption_key, is_main, revision_uid, stoken)
SELECT c.id, i.uid, 1, i.key, i.main, i.revision, 9
FROM collections c
JOIN (VALUES ('shared', 'main', NULL::bytea, TRUE, 'rev-1'),
             ('shared', 'note', '\x010203'::bytea, FALSE, 'rev-3'),
             ('plain', 'main', NULL::bytea, TRUE, 'rev-4'))
     AS i(collection, uid, key, main, revision) ON i.collection = c.uid;

INSERT INTO chunks (collection_id, uid, size, data)
SELECT c.id, k.uid, k.size, decode(repeat('00', k.size), 'hex')
FROM collections c
JOIN (VALUES ('chunk-a', 100), ('chunk-b', 50)) AS k(uid, size) ON c.uid = 'shared';

INSERT INTO revisions (item_id, uid, meta, deleted, chunk_ids, stoken)
SELECT i.id, r.uid, decode(repeat('00', r.meta), 'hex'), FALSE,
       ARRAY(SELECT k.id FROM chunks k
             WHERE k.collection_id = i.collection_id AND k.uid = ANY(r.chunks)
             ORDER BY k.uid), 9
FROM items i
JOIN collections c ON c.id = i.collection_id
JOIN (VALUES ('shared', 'main', 'rev-1', 10, ARRAY[]::text[]),
             ('shared', 'note', 'rev-2', 5, ARRAY['chunk-a']),
             ('shared', 'note', 'rev-3', 20, ARRAY['chunk-a', 'chunk-b']),
             ('plain', 'main', 'rev-4', 10, ARRAY[]::text[]))
     AS r(collection, item, uid, meta, chunks)
     ON r.collection = c.uid AND r.item = i.uid;

INSERT INTO members (collection_id, account_id, access_level, encryption_key, collection_type,
                     stoken)
SELECT c.id, a.id, 1, '\x01020304'::bytea, '\x010203040506'::bytea, 9
FROM collections c
JOIN accounts a ON a.username = 'owner' OR (a.username = 'guest' AND c.uid = 'shared');

INSERT INTO invitations (uid, version, collection_id, from_account_id, to_account_id,
                         access_level, signed_encryption_key)
SELECT 'inv', 1, c.id, c.owner_id, a.id, 2, '\x01020304050607'::bytea
FROM collections c JOIN accounts a ON a.username = 'waiting' WHERE c.uid = 'shared';

INSERT INTO invite_links (uid, version, collection_id, from_account_id, access_level,
                          signed_encryption_key, claim_pubkey, max_uses, expires_at)
SELECT 'link', 1, c.id, c.owner_id, 2, '\x0102030405'::bytea, '\x010203040506'::bytea, 5,
       now() + interval '1 day'
FROM collections c WHERE c.uid = 'shared';

INSERT INTO removed_members (collection_id, account_id, stoken)
SELECT c.id, a.id, 9
FROM collections c JOIN accounts a ON a.username = 'gone' WHERE c.uid = 'shared';
";

/// items 21, revisions 74, chunks 164, members 20, invitation 10, link 15.
const SHARED_COUNTS: i64 = 304;
/// item 9, revision 15, member 10.
const PLAIN_COUNTS: i64 = 34;

#[tokio::test]
async fn an_upgrade_counts_what_the_last_release_left_uncounted() {
    let (schema, options, main) = empty_schema().await;
    let options = options.options([("search_path", schema.as_str())]);
    let old = PgPoolOptions::new()
        .max_connections(2)
        .connect_with(options.clone())
        .await
        .unwrap();
    let (last_release, copied) = migrations_up_to(9).await;
    last_release.run(&old).await.unwrap();
    sqlx::raw_sql(IN_USE).execute(&old).await.unwrap();

    let config = Config::for_tests(
        format!(
            "{}?options=-c%20search_path%3D{schema}",
            common::database_url()
        ),
        std::env::temp_dir().join(format!("mindstream-upgrade-blobs-{schema}")),
    );
    let state = AppState::connect(config).await.expect("the upgrade ran");

    let charged: Vec<(String, i64)> =
        sqlx::query_as("SELECT uid, bytes_used FROM collections ORDER BY uid")
            .fetch_all(&old)
            .await
            .unwrap();
    assert_eq!(
        charged,
        [
            ("plain".to_owned(), PLAIN_COUNTS),
            ("shared".to_owned(), SHARED_COUNTS)
        ]
    );
    // The recount the running server audits itself by agrees.
    assert_eq!(admin::storage_drift(&state).await.unwrap(), []);
    // Nobody recorded who took this one out, so they are not held to it.
    let by_admin: Vec<bool> = sqlx::query_scalar("SELECT by_admin FROM removed_members")
        .fetch_all(&old)
        .await
        .unwrap();
    assert_eq!(by_admin, [false]);

    old.close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&main)
        .await
        .unwrap();
    std::fs::remove_dir_all(copied).unwrap();
}
