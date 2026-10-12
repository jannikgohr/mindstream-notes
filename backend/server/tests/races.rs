//! What must hold when two things happen at once, or when the server missed
//! hearing of one of them.
//!
//! Each test here pins a way the server once got it wrong. They hold one
//! side still with a lock the test controls, so the order of events is the
//! test's choice and not the scheduler's.

mod common;

use std::time::Duration;

use common::keyed::{new_key, public, refused, Extra, Person};
use common::raw::{Device, Frame, ADMIN, JOINED, READ_WRITE, UPDATE};
use reqwest::Method;
use serde::Deserialize;

/// The tests here hold locks in the database the test servers share. Two
/// of them running at once can each end up waiting for what the other
/// holds, with the test code in between where the database cannot see the
/// cycle and break it. So they take turns.
static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn pool() -> sqlx::PgPool {
    sqlx::PgPool::connect(&common::database_url())
        .await
        .expect("connect to the test database")
}

/// Wait until some backend is stuck on a lock while running a query that
/// contains `marker`.
async fn wait_until_blocked(pool: &sqlx::PgPool, marker: &str) {
    let blocked = async {
        loop {
            let waiting: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                 WHERE datname = current_database() AND wait_event_type = 'Lock'
                   AND query LIKE '%' || $1 || '%')",
            )
            .bind(marker)
            .fetch_one(pool)
            .await
            .unwrap();
            if waiting {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(10), blocked)
        .await
        .unwrap_or_else(|_| panic!("nothing got as far as waiting on: {marker}"));
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Listing {
    data: Vec<ListedCollection>,
    stoken: String,
    #[serde(default)]
    removed_memberships: Option<Vec<Removed>>,
}

#[derive(Deserialize)]
struct ListedCollection {
    item: ListedItem,
}

#[derive(Deserialize)]
struct ListedItem {
    uid: String,
}

#[derive(Deserialize)]
struct Removed {
    uid: String,
}

async fn list_collections(device: &Device, cursor: Option<&str>) -> Listing {
    let mut request = reqwest::Client::new()
        .get(format!("{}/api/v1/collection/", device.url))
        .header("Authorization", format!("Token {}", device.token));
    if let Some(cursor) = cursor {
        request = request.query(&[("stoken", cursor)]);
    }
    let response = request.send().await.unwrap();
    assert_eq!(response.status(), 200);
    rmp_serde::from_slice(&response.bytes().await.unwrap()).unwrap()
}

/// A collection listing is built from two reads, the collections that
/// changed and the memberships that were lost, and hands out one cursor for
/// both. A change that commits between the two must not end up behind the
/// cursor without having been in the answer.
#[tokio::test]
async fn collection_cursor_never_passes_a_change_it_did_not_report() {
    let _turn = ONE_AT_A_TIME.lock().await;
    let url = common::server();
    let device = Device::signup(url, "cursor-reader").await;
    let owner = Device::signup(url, "cursor-owner").await;
    let retained = device.create_collection().await;
    let removed = owner.create_collection().await;
    owner.share(&removed, &device, ADMIN).await;
    let cursor = list_collections(&device, None).await.stoken;

    // Hold the second read still by locking the table it reads.
    let pool = pool().await;
    let mut barrier = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE removed_members IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *barrier)
        .await
        .unwrap();
    let read = list_collections(&device, Some(&cursor));
    let change = async {
        wait_until_blocked(&pool, "SELECT c.uid, r.stoken").await;
        // First an ordinary change in a collection the reader keeps.
        device.add_item(&retained).await;
        // Then, later in the order of changes, the loss of the other one,
        // made the way the server makes it.
        let account: i64 = sqlx::query_scalar("SELECT id FROM accounts WHERE username = $1")
            .bind(&device.name)
            .fetch_one(&mut *barrier)
            .await
            .unwrap();
        let collection: i64 = sqlx::query_scalar("SELECT id FROM collections WHERE uid = $1")
            .bind(&removed)
            .fetch_one(&mut *barrier)
            .await
            .unwrap();
        sqlx::query("DELETE FROM members WHERE collection_id = $1 AND account_id = $2")
            .bind(collection)
            .bind(account)
            .execute(&mut *barrier)
            .await
            .unwrap();
        let stoken: i64 =
            sqlx::query_scalar("UPDATE change_counter SET value = value + 1 RETURNING value")
                .fetch_one(&mut *barrier)
                .await
                .unwrap();
        sqlx::query("UPDATE collections SET stoken = $2 WHERE id = $1")
            .bind(collection)
            .bind(stoken)
            .execute(&mut *barrier)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO removed_members (collection_id, account_id, stoken) VALUES ($1, $2, $3)",
        )
        .bind(collection)
        .bind(account)
        .bind(stoken)
        .execute(&mut *barrier)
        .await
        .unwrap();
        barrier.commit().await.unwrap();
    };
    let (first, _) = tokio::join!(read, change);

    // Whatever the first answer held, following its cursor must bring the
    // rest: the edit in the retained collection, and the lost membership.
    let second = list_collections(&device, Some(&first.stoken)).await;
    let reported = |listing: &Listing, uid: &str| {
        listing
            .data
            .iter()
            .any(|collection| collection.item.uid == uid)
    };
    assert!(
        reported(&first, &retained) || reported(&second, &retained),
        "the change in the retained collection was skipped"
    );
    let lost = |listing: &Listing| {
        listing
            .removed_memberships
            .iter()
            .flatten()
            .any(|collection| collection.uid == removed)
    };
    assert!(
        lost(&first) || lost(&second),
        "the lost membership was skipped"
    );
}

/// Signing in and changing the password take turns. A sign-in with the old
/// password that is under way while the password changes either finishes
/// first, and is then signed out with every other device, or goes second and
/// finds the old password no longer stands. It never opens a session that
/// the change has already swept past.
#[tokio::test]
async fn sign_in_waits_for_a_password_change_in_progress_and_then_fails() {
    let _turn = ONE_AT_A_TIME.lock().await;
    let person = Person::signup(common::server(), "login-race", false).await;
    let pool = pool().await;

    // A password change that has done its work and not yet committed: the
    // new key is in, the other sessions are gone.
    let mut change = pool.begin().await.unwrap();
    let account: i64 = sqlx::query_scalar(
        "UPDATE accounts SET login_pubkey = $2 WHERE username = $1 RETURNING id",
    )
    .bind(&person.name)
    .bind(public(&new_key()))
    .fetch_one(&mut *change)
    .await
    .unwrap();
    sqlx::query("DELETE FROM sessions WHERE account_id = $1")
        .bind(account)
        .execute(&mut *change)
        .await
        .unwrap();

    let extra = Extra::none();
    let login = person.login(&person.login, &extra, "racing device");
    tokio::pin!(login);
    // The old password still checks out against what has committed. The
    // sign-in must not act on that while the change is open.
    let early = tokio::time::timeout(Duration::from_millis(700), &mut login).await;
    assert!(
        early.is_err(),
        "the sign-in went ahead while the password was changing"
    );

    change.commit().await.unwrap();
    let outcome = login.await;
    assert_eq!(
        outcome.err(),
        Some(refused(401, "login_bad_signature")),
        "the old password opened a session after the change"
    );
    let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions WHERE account_id = $1")
        .bind(account)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(sessions, 0);
}

async fn incoming(device: &Device) -> Vec<String> {
    // Decoded by hand: an invitation carries binary fields, which the
    // helper that returns JSON cannot hold.
    #[derive(Deserialize)]
    struct Invitations {
        data: Vec<Invitation>,
    }
    #[derive(Deserialize)]
    struct Invitation {
        uid: String,
    }
    let response = reqwest::Client::new()
        .get(format!("{}/api/v1/invitation/incoming/", device.url))
        .header("Authorization", format!("Token {}", device.token))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let list: Invitations = rmp_serde::from_slice(&response.bytes().await.unwrap()).unwrap();
    list.data
        .into_iter()
        .map(|invitation| invitation.uid)
        .collect()
}

async fn try_accept(device: &Device, invitation: &str) -> u16 {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Accept {
        collection_type: serde_bytes::ByteBuf,
        encryption_key: serde_bytes::ByteBuf,
    }
    let body = Accept {
        collection_type: serde_bytes::ByteBuf::from(b"type".to_vec()),
        encryption_key: serde_bytes::ByteBuf::from(b"my key".to_vec()),
    };
    let path = format!("/invitation/incoming/{invitation}/accept/");
    device.call(Method::POST, &path, Some(&body)).await.0
}

/// An invitation carries its sender's authority to let someone in. Once the
/// sender is no longer an admin of the collection, it lets nobody in.
#[tokio::test]
async fn invitation_from_a_removed_admin_grants_nothing() {
    let _turn = ONE_AT_A_TIME.lock().await;
    let url = common::server();
    let owner = Device::signup(url, "owner").await;
    let admin = Device::signup(url, "admin").await;
    let guest = Device::signup(url, "guest").await;
    let collection = owner.create_collection().await;
    owner.share(&collection, &admin, ADMIN).await;
    let invitation = admin.invite(&collection, &guest, ADMIN).await;
    assert_eq!(incoming(&guest).await, vec![invitation.clone()]);

    owner.remove_member(&collection, &admin).await;

    assert!(incoming(&guest).await.is_empty());
    assert_eq!(try_accept(&guest, &invitation).await, 404);
    assert_eq!(guest.try_add_item(&collection).await.0, 404);
}

/// The same when the sender keeps their membership and loses the right to
/// invite, and it stays so if they are made an admin again: the old
/// invitation was withdrawn, not shelved.
#[tokio::test]
async fn invitation_from_a_downgraded_admin_grants_nothing_even_after_promotion() {
    let _turn = ONE_AT_A_TIME.lock().await;
    let url = common::server();
    let owner = Device::signup(url, "owner").await;
    let admin = Device::signup(url, "admin").await;
    let guest = Device::signup(url, "guest").await;
    let collection = owner.create_collection().await;
    owner.share(&collection, &admin, ADMIN).await;
    let invitation = admin.invite(&collection, &guest, READ_WRITE).await;

    owner.set_access(&collection, &admin, READ_WRITE).await;
    assert!(incoming(&guest).await.is_empty());
    assert_eq!(try_accept(&guest, &invitation).await, 404);

    owner.set_access(&collection, &admin, ADMIN).await;
    assert!(incoming(&guest).await.is_empty());
    assert_eq!(try_accept(&guest, &invitation).await, 404);

    // A new invitation from the admin they are again works as ever.
    let again = admin.invite(&collection, &guest, READ_WRITE).await;
    assert_eq!(try_accept(&guest, &again).await, 201);
    assert_eq!(guest.try_add_item(&collection).await.0, 200);
}

/// The server learns that a session ended from a notification, and
/// notifications sent while its listening connection is down are lost. When
/// the connection comes back it asks the database about every socket it
/// holds, and closes the ones whose session is gone: in rooms and on the
/// change feed alike.
#[tokio::test]
async fn sockets_of_a_session_that_ended_unheard_close_when_the_listener_returns() {
    let _turn = ONE_AT_A_TIME.lock().await;
    // A server of its own, so that cutting its listener off disturbs no
    // other test, and named so that its connections can be told apart.
    let name = format!("mindstream-races-{}", std::process::id());
    let url = {
        let name = name.clone();
        common::start_server(move |config| {
            let separator = if config.database_url.contains('?') {
                '&'
            } else {
                '?'
            };
            config
                .database_url
                .push_str(&format!("{separator}application_name={name}"));
        })
    };
    let device = Device::signup(&url, "missed-revocation").await;
    let collection = device.create_collection().await;
    let item = device.add_item(&collection).await;
    let (mut sender, _) = device.enter(&collection, &item).await;
    let (mut receiver, _) = device.enter(&collection, &item).await;
    assert!(matches!(sender.next().await, Frame::Control(JOINED, _)));
    let mut feed = device.feed().await;

    let pool = pool().await;
    let listener_of = |except: i32| {
        let pool = pool.clone();
        let name = name.clone();
        async move {
            sqlx::query_scalar::<_, i32>(
                "SELECT pid FROM pg_stat_activity
                 WHERE application_name = $1 AND query ILIKE 'LISTEN %' AND pid <> $2
                 LIMIT 1",
            )
            .bind(name)
            .bind(except)
            .fetch_optional(&pool)
            .await
            .unwrap()
        }
    };
    let listener = listener_of(0).await.expect("the server is listening");

    // The session ends and the server does not hear of it.
    sqlx::query(
        "DELETE FROM sessions USING accounts
         WHERE sessions.account_id = accounts.id AND accounts.username = $1",
    )
    .bind(&device.name)
    .execute(&pool)
    .await
    .unwrap();
    // Still relaying: nothing has told the server.
    sender.send(UPDATE, b"before the listener returns").await;
    assert!(matches!(receiver.next().await, Frame::Relayed { .. }));

    sqlx::query("SELECT pg_terminate_backend($1)")
        .bind(listener)
        .execute(&pool)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while listener_of(listener).await.is_none() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the listener came back");

    assert_eq!(receiver.next().await, Frame::Closed(4401));
    assert_eq!(sender.next().await, Frame::Closed(4401));
    assert_eq!(feed.close_code().await, Some(4401));
    assert_eq!(
        device
            .call::<()>(Method::GET, "/mindstream/security/", None)
            .await
            .0,
        401
    );
}
