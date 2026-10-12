//! What an administrator can do to an account from the command line.

mod common;

use common::keyed::{enrol, refused, Extra, Person};
use common::{new_collection, signup, COLLECTION_TYPE};
use etebase::error::Error;
use mindstream_server::{admin, AppState, Config};

/// Run an admin operation the way the command line does: on its own
/// connection to the same database the server uses.
fn admin_do<T>(operation: impl AsyncFnOnce(&AppState) -> T) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async { operation(&admin_state().await).await })
}

async fn admin_state() -> AppState {
    let blob_dir = std::env::temp_dir().join("mindstream-server-test-admin");
    let config = Config::for_tests(common::database_url(), blob_dir);
    AppState::connect(config).await.unwrap()
}

#[test]
fn disabling_an_account_ends_its_sessions_until_it_is_enabled() {
    let account = signup("member");
    let name = account.name.clone();
    let collection = new_collection(&account, "mine");
    let collections = account.collection_manager().unwrap();

    let listed = admin_do(async |state| admin::list_accounts(state).await.unwrap());
    let row = listed
        .iter()
        .find(|row| row.username == name)
        .expect("the account is listed");
    assert!(!row.disabled);
    assert_eq!(row.sessions, 1);
    assert!(row.bytes_used > 0);

    assert!(admin_do(async |state| admin::set_disabled(
        state, &name, true
    )
    .await
    .unwrap()));
    // The session it held stops working at once.
    assert!(matches!(
        collections.fetch(collection.uid(), None),
        Err(Error::Unauthorized(_))
    ));
    // And a new one cannot be had, even with the right key.
    let login =
        || etebase::Account::login_key(common::client(common::server()), &name, &account.key);
    assert!(matches!(login(), Err(Error::Unauthorized(_))));

    assert!(admin_do(async |state| admin::set_disabled(
        state, &name, false
    )
    .await
    .unwrap()));
    // Enabling does not bring the old session back; signing in again does.
    assert!(matches!(
        collections.fetch(collection.uid(), None),
        Err(Error::Unauthorized(_))
    ));
    let again = login().expect("an enabled account can sign in");
    again
        .collection_manager()
        .unwrap()
        .fetch(collection.uid(), None)
        .expect("and reach its data");
    let listed = admin_do(async |state| admin::list_accounts(state).await.unwrap());
    let row = listed.iter().find(|row| row.username == name).unwrap();
    assert!(!row.disabled);
    assert_eq!(row.sessions, 1);

    assert!(!admin_do(async |state| {
        admin::set_disabled(state, "no-such-account", true)
            .await
            .unwrap()
    }));
}

#[test]
fn deleting_an_account_removes_what_it_owned() {
    let owner = signup("leaving");
    let guest = signup("staying");
    let collection = new_collection(&owner, "shared");
    common::share(
        &owner,
        &collection,
        &guest,
        etebase::CollectionAccessLevel::ReadWrite,
    );
    let guest_collections = guest.collection_manager().unwrap();
    assert_eq!(
        guest_collections
            .list(COLLECTION_TYPE, None)
            .unwrap()
            .data()
            .len(),
        1
    );

    let name = owner.name.clone();
    assert!(admin_do(async |state| admin::delete_account(state, &name)
        .await
        .unwrap()));
    assert!(!admin_do(async |state| admin::delete_account(state, &name)
        .await
        .unwrap()));

    // The collection went with its owner, for the other member too.
    assert!(guest_collections
        .list(COLLECTION_TYPE, None)
        .unwrap()
        .data()
        .is_empty());
    assert!(matches!(
        guest_collections.fetch(collection.uid(), None),
        Err(Error::NotFound(_))
    ));
    let listed = admin_do(async |state| admin::list_accounts(state).await.unwrap());
    assert!(listed.iter().all(|row| row.username != name));
}

#[tokio::test]
async fn second_factor_reset_lets_the_owner_back_in_with_the_password() {
    let ann = Person::signup(common::server(), "locked-out", false).await;
    enrol(&ann).await;
    let state = admin_state().await;
    let second_factor = async || {
        let listed = admin::list_accounts(&state).await.unwrap();
        let row = listed.iter().find(|row| row.username == ann.name);
        row.expect("the account is listed").second_factor
    };
    assert!(second_factor().await);
    // The authenticator and the backup codes are gone, and the password
    // alone is not enough.
    assert_eq!(
        ann.login(&ann.login, &Extra::none(), "New phone")
            .await
            .err(),
        Some(refused(401, "totp_required"))
    );

    assert!(admin::reset_second_factor(&state, &ann.name).await.unwrap());
    assert!(!second_factor().await);
    ann.login(&ann.login, &Extra::none(), "New phone")
        .await
        .expect("the password alone");
    let status = ann.get("/mindstream/security/").await.value();
    assert_eq!(status["totp"], false);
    assert_eq!(status["backupCodes"], 0);
    assert_eq!(status["sessionVerified"], false);

    assert!(!admin::reset_second_factor(&state, "no-such-account")
        .await
        .unwrap());
}
