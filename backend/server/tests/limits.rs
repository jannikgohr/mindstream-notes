//! What an account's plan allows, enforced where the data comes in.
//!
//! The limits are set the way the billing program will set them, through
//! the admin interface, and then tested with the client the app ships.

mod common;

use std::iter;

use common::{named, new_collection, share, signup, signup_at, TestAccount};
use etebase::error::Error;
use etebase::CollectionAccessLevel;

const ADMIN_TOKEN: &str = "test-admin-token";
const MIB: i64 = 1024 * 1024;

/// A server with the admin interface on.
fn server() -> &'static str {
    static URL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    URL.get_or_init(|| {
        common::start_server(|config| config.admin_token = Some(ADMIN_TOKEN.to_owned()))
    })
}

fn admin(method: reqwest::Method, path: &str, body: Option<&str>, token: &str) -> (u16, String) {
    let url = format!("{}/admin/v1{path}", server());
    let body = body.map(str::to_owned);
    let token = token.to_owned();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async move {
            let mut request = reqwest::Client::new()
                .request(method, url)
                .header("Authorization", format!("Bearer {token}"));
            if let Some(body) = body {
                request = request
                    .header("Content-Type", "application/json")
                    .body(body);
            }
            let response = request.send().await.unwrap();
            (response.status().as_u16(), response.text().await.unwrap())
        })
}

fn set_plan(account: &TestAccount, plan: &str) {
    let path = format!("/account/{}/entitlements/", account.name);
    let (status, body) = admin(reqwest::Method::PUT, &path, Some(plan), ADMIN_TOKEN);
    assert_eq!(status, 204, "{body}");
}

/// Assert a refusal for breaking a limit, with the code that says which.
fn assert_over<T>(result: Result<T, Error>, code: &str) {
    match result {
        Err(Error::Http(message)) => {
            assert!(message.contains("402"), "{message}");
            assert!(message.contains(code), "expected {code} in: {message}");
        }
        Err(other) => panic!("refused, but with {other:?}"),
        Ok(_) => panic!("was allowed"),
    }
}

fn megabyte(seed: u8) -> Vec<u8> {
    etebase::utils::randombytes_deterministic(MIB as usize, &[seed; 32])
}

#[test]
fn storage_limit_stops_new_content_and_lets_deletions_through() {
    let owner = signup_at(server(), "owner");
    let collection = new_collection(&owner, "files");
    let items = owner
        .collection_manager()
        .unwrap()
        .item_manager(&collection)
        .unwrap();
    set_plan(
        &owner,
        &format!(r#"{{"plan":"small","storageLimitBytes":{}}}"#, 2 * MIB),
    );

    let mut first = items.create(&named("one"), &megabyte(1)).unwrap();
    items.batch(iter::once(&first), None).unwrap();
    let second = items.create(&named("two"), &megabyte(2)).unwrap();
    assert_over(items.batch(iter::once(&second), None), "storage_full");
    // Uploading the content ahead of the item is the same storage.
    assert_over(items.upload_content(&second), "storage_full");
    // Nothing of the refused upload was kept.
    assert_eq!(items.list(None).unwrap().data().len(), 1);

    // A small edit still fits, and a deletion always does.
    first.set_meta(&named("renamed")).unwrap();
    items.batch(iter::once(&first), None).unwrap();
    first.delete().unwrap();
    items.batch(iter::once(&first), None).unwrap();

    // Raising the limit lets the upload through.
    set_plan(
        &owner,
        &format!(r#"{{"plan":"big","storageLimitBytes":{}}}"#, 8 * MIB),
    );
    items.batch(iter::once(&second), None).unwrap();
}

#[test]
fn collaborators_spend_the_owners_storage() {
    let owner = signup_at(server(), "owner");
    let guest = signup_at(server(), "guest");
    let collection = new_collection(&owner, "shared");
    let guest_view = share(
        &owner,
        &collection,
        &guest,
        CollectionAccessLevel::ReadWrite,
    );
    set_plan(
        &owner,
        &format!(r#"{{"plan":"small","storageLimitBytes":{MIB}}}"#),
    );

    // The guest has no limits of their own, and it is not their storage.
    let guest_items = guest
        .collection_manager()
        .unwrap()
        .item_manager(&guest_view)
        .unwrap();
    let file = guest_items.create(&named("file"), &megabyte(3)).unwrap();
    match guest_items.batch(iter::once(&file), None) {
        Err(Error::Http(message)) => {
            assert!(message.contains("storage_full"), "{message}");
            // The app has to be able to say whose storage is full.
            assert!(message.contains(&owner.name), "{message}");
        }
        other => panic!("expected the owner's storage to be full, got {other:?}"),
    }

    // In a collection of their own the guest is not held back.
    let own = new_collection(&guest, "mine");
    let own_items = guest
        .collection_manager()
        .unwrap()
        .item_manager(&own)
        .unwrap();
    let file = own_items.create(&named("file"), &megabyte(4)).unwrap();
    own_items.batch(iter::once(&file), None).unwrap();
}

#[test]
fn lapsed_plan_is_read_only_and_keeps_everything() {
    let owner = signup_at(server(), "owner");
    let collection = new_collection(&owner, "notes");
    let collections = owner.collection_manager().unwrap();
    let items = collections.item_manager(&collection).unwrap();
    let mut note = items.create(&named("note"), b"body").unwrap();
    items.batch(iter::once(&note), None).unwrap();

    set_plan(&owner, r#"{"plan":"lapsed","readOnly":true}"#);

    // Everything is still there to read.
    let listed = items.list(None).unwrap();
    assert_eq!(listed.data().len(), 1);
    assert_eq!(listed.data()[0].content().unwrap(), b"body");

    let fresh = items.create(&named("new"), b"more").unwrap();
    assert_over(items.batch(iter::once(&fresh), None), "plan_lapsed");
    note.set_content(b"edited").unwrap();
    assert_over(items.batch(iter::once(&note), None), "plan_lapsed");

    // Deleting keeps working, so the account can be tidied up.
    let mut gone = items.fetch(note.uid(), None).unwrap();
    gone.delete().unwrap();
    items.batch(iter::once(&gone), None).unwrap();

    // Lifting the limits brings it back to normal.
    let path = format!("/account/{}/entitlements/", owner.name);
    assert_eq!(
        admin(reqwest::Method::DELETE, &path, None, ADMIN_TOKEN).0,
        204
    );
    items.batch(iter::once(&fresh), None).unwrap();
}

#[test]
fn item_size_and_collection_count_are_limited() {
    let owner = signup_at(server(), "owner");
    let collection = new_collection(&owner, "first");
    set_plan(
        &owner,
        &format!(
            r#"{{"plan":"tiny","maxSpaces":2,"maxItemBytes":{}}}"#,
            MIB / 2
        ),
    );

    let items = owner
        .collection_manager()
        .unwrap()
        .item_manager(&collection)
        .unwrap();
    let small = items
        .create(&named("small"), &megabyte(5)[..100_000])
        .unwrap();
    items.batch(iter::once(&small), None).unwrap();
    let large = items.create(&named("large"), &megabyte(6)).unwrap();
    assert_over(items.batch(iter::once(&large), None), "item_too_large");

    new_collection(&owner, "second");
    let collections = owner.collection_manager().unwrap();
    let third = collections
        .create(common::COLLECTION_TYPE, &named("third"), b"")
        .unwrap();
    assert_over(collections.upload(&third, None), "space_limit");
}

#[test]
fn member_limit_is_checked_when_inviting_and_when_accepting() {
    let owner = signup_at(server(), "owner");
    let first = signup_at(server(), "first");
    let second = signup_at(server(), "second");
    let collection = new_collection(&owner, "shared");
    // The owner and one more.
    set_plan(&owner, r#"{"plan":"pair","maxMembersPerSpace":2}"#);

    let invites = owner.invitation_manager().unwrap();
    let invite = |guest: &TestAccount| {
        let profile = invites.fetch_user_profile(&guest.name).unwrap();
        invites.invite(
            &collection,
            &guest.name,
            profile.pubkey(),
            CollectionAccessLevel::ReadWrite,
        )
    };
    invite(&first).unwrap();
    // A second invitation could never be accepted while the first stands.
    assert_over(invite(&second), "member_limit");

    let first_invites = first.invitation_manager().unwrap();
    let incoming = first_invites.list_incoming(None).unwrap();
    first_invites.accept(&incoming.data()[0]).unwrap();
    assert_over(invite(&second), "member_limit");
}

#[test]
fn admin_interface_needs_its_token_and_reports_usage() {
    let owner = signup_at(server(), "owner");
    new_collection(&owner, "one");
    let path = format!("/account/{}/", owner.name);

    assert_eq!(admin(reqwest::Method::GET, &path, None, "wrong").0, 401);
    assert_eq!(
        admin(
            reqwest::Method::PUT,
            &format!("{path}entitlements/"),
            Some("{}"),
            "wrong"
        )
        .0,
        401
    );
    assert_eq!(
        admin(
            reqwest::Method::GET,
            "/account/nobody-here/",
            None,
            ADMIN_TOKEN
        )
        .0,
        404
    );

    let (status, usage) = admin(reqwest::Method::GET, &path, None, ADMIN_TOKEN);
    assert_eq!(status, 200);
    assert!(usage.contains(r#""limited":false"#), "{usage}");
    assert!(usage.contains(r#""spaces":1"#), "{usage}");

    set_plan(&owner, r#"{"plan":"basic","storageLimitBytes":1048576}"#);
    let (_, usage) = admin(reqwest::Method::GET, &path, None, ADMIN_TOKEN);
    assert!(usage.contains(r#""limited":true"#), "{usage}");
    assert!(usage.contains(r#""plan":"basic""#), "{usage}");
    assert!(usage.contains(r#""storageLimitBytes":1048576"#), "{usage}");

    // On a server without a token configured the interface is not there.
    let closed = format!("{}/admin/v1{path}", common::server());
    let status = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            reqwest::Client::new()
                .get(closed)
                .header("Authorization", format!("Bearer {ADMIN_TOKEN}"))
                .send()
                .await
                .unwrap()
                .status()
                .as_u16()
        });
    assert_eq!(status, 404);
    // Limits on one account leave another alone.
    let other = signup("bystander");
    new_collection(&other, "free");
}
