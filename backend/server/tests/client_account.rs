//! Account security the way the app reaches it: through the client library,
//! with real passwords and real keys.
//!
//! `security.rs` checks the server's rules with keys the tests make up. This
//! checks that the client and the server agree on what goes over the wire,
//! and that what the client derives from a password or a recovery key opens
//! what it should.

mod common;

use common::keyed::Authenticator;
use common::{named, new_collection};
use etebase::error::Error;
use etebase::{refusal, Account, Client, FetchOptions, RecoveryKey, SignupWith, User};
use mindstream_server::admin;

const PASSWORD: &str = "correct horse battery staple";

fn url() -> &'static str {
    common::server()
}

/// A device, named the way it will show in the list of sessions.
fn device(url: &str, name: &str) -> Client {
    Client::new(name, url).expect("client")
}

fn signup_at(
    url: &str,
    role: &str,
    with: &SignupWith,
) -> Result<(Account, String, RecoveryKey), Error> {
    let name = common::username(role);
    let user = User::new(&name, &format!("{name}@test.local"));
    let (account, key) = Account::signup_with(device(url, "Laptop"), &user, PASSWORD, with)?;
    Ok((account, name, key))
}

fn signup(role: &str) -> (Account, String, RecoveryKey) {
    signup_at(url(), role, &SignupWith::new()).expect("signup")
}

fn login(name: &str, password: &str, code: Option<&str>) -> Result<Account, Error> {
    Account::login_with_code(device(url(), "Phone"), name, password, code)
}

/// The reason a call was refused with.
fn reason<T>(result: Result<T, Error>) -> String {
    match result {
        Ok(_) => "accepted".to_owned(),
        Err(Error::Refused { code, .. }) => code,
        Err(other) => format!("{other:?}"),
    }
}

/// Set up an authenticator from this device. Gives it with the backup codes.
fn enrol(account: &Account) -> (Authenticator, Vec<String>) {
    let security = account.security();
    let setup = security
        .begin_authenticator(PASSWORD, None)
        .expect("start setting up");
    assert!(setup.url().starts_with("otpauth://totp/"));
    let mut authenticator = Authenticator::new(setup.secret());
    let codes = security
        .confirm_authenticator(&authenticator.code())
        .expect("confirm");
    (authenticator, codes)
}

#[test]
fn account_signs_up_with_a_recovery_key_and_signs_in_again() {
    let (account, name, _key) = signup("ann");
    let status = account.security().status().expect("status");
    assert!(status.recovery_key());
    assert!(!status.authenticator());
    assert_eq!(status.backup_codes(), 0);

    // The keys the password wraps are the ones signup made.
    let collection = new_collection(&account, "notes");
    let again = login(&name, PASSWORD, None).expect("sign in");
    let fetched = again
        .collection_manager()
        .unwrap()
        .fetch(collection.uid(), None)
        .expect("the other device reads the collection");
    assert_eq!(fetched.meta().unwrap().name(), Some("notes"));

    assert_eq!(
        reason(login(&name, "not the password", None)),
        refusal::WRONG_PASSWORD
    );
    assert_eq!(
        reason(login("t-nobody-at-all", PASSWORD, None)),
        refusal::UNKNOWN_USER
    );
    let taken = User::new(&name, "second@test.local");
    assert_eq!(
        reason(Account::signup_with(
            device(url(), "Laptop"),
            &taken,
            PASSWORD,
            &SignupWith::new()
        )),
        refusal::USER_EXISTS
    );
}

#[test]
fn code_is_asked_for_once_the_password_is_right() {
    let (account, name, _key) = signup("ann");
    let (mut authenticator, backup) = enrol(&account);
    assert_eq!(backup.len(), 10);

    let status = account.security().status().expect("status");
    assert!(status.authenticator());
    assert_eq!(status.backup_codes(), 10);
    // The device that set the authenticator up counts as having shown it.
    assert!(status.session_verified());

    assert_eq!(
        reason(login(&name, "not the password", None)),
        refusal::WRONG_PASSWORD
    );
    assert_eq!(reason(login(&name, PASSWORD, None)), refusal::CODE_REQUIRED);
    assert_eq!(
        reason(login(&name, PASSWORD, Some(&authenticator.wrong_code()))),
        refusal::CODE_INVALID
    );

    let code = authenticator.code();
    let phone = login(&name, PASSWORD, Some(&code)).expect("sign in with a code");
    assert!(phone.security().status().unwrap().session_verified());
    // A code works once.
    assert_eq!(
        reason(login(&name, PASSWORD, Some(&code))),
        refusal::CODE_INVALID
    );

    // So does a backup code, typed the way people type them.
    let typed = backup[0].to_lowercase().replace('-', " ");
    login(&name, PASSWORD, Some(&typed)).expect("sign in with a backup code");
    assert_eq!(
        reason(login(&name, PASSWORD, Some(&backup[0]))),
        refusal::CODE_INVALID
    );
    assert_eq!(phone.security().status().unwrap().backup_codes(), 9);
}

#[test]
fn second_factor_is_replaced_and_removed_with_the_password_and_a_code() {
    let (account, name, _key) = signup("ann");
    let (_authenticator, backup) = enrol(&account);
    let security = account.security();

    assert_eq!(
        reason(security.new_backup_codes("not the password", &backup[0])),
        refusal::WRONG_PASSWORD
    );
    assert_eq!(
        reason(security.new_backup_codes(PASSWORD, "000000")),
        refusal::CODE_INVALID
    );
    let fresh = security
        .new_backup_codes(PASSWORD, &backup[0])
        .expect("new backup codes");
    assert_eq!(fresh.len(), 10);
    assert_eq!(
        reason(login(&name, PASSWORD, Some(&backup[1]))),
        refusal::CODE_INVALID
    );

    assert_eq!(
        reason(security.remove_authenticator("not the password", &fresh[0])),
        refusal::WRONG_PASSWORD
    );
    security
        .remove_authenticator(PASSWORD, &fresh[0])
        .expect("turn it off");
    assert!(!security.status().unwrap().authenticator());
    login(&name, PASSWORD, None).expect("the password is enough again");
    assert_eq!(
        reason(security.remove_authenticator(PASSWORD, &fresh[1])),
        refusal::NO_AUTHENTICATOR
    );
    assert_eq!(
        reason(security.confirm_authenticator("123456")),
        refusal::SETUP_NOT_STARTED
    );
}

#[test]
fn recovery_sets_a_new_password_and_keeps_the_data() {
    let (account, name, key) = signup("ann");
    let collection = new_collection(&account, "notes");
    let items = account
        .collection_manager()
        .unwrap()
        .item_manager(&collection)
        .unwrap();
    let note = items.create(&named("a note"), b"what it says").unwrap();
    items.batch(std::iter::once(&note), None).unwrap();

    // The key as the user kept it: on paper.
    let written_down = key.to_string();
    let read_back = RecoveryKey::parse(&written_down).expect("the key reads back");
    let stranger = RecoveryKey::generate();
    assert_eq!(
        reason(Account::recover(
            device(url(), "Tablet"),
            &name,
            &stranger,
            None
        )),
        refusal::WRONG_RECOVERY_KEY
    );

    let recovery =
        Account::recover(device(url(), "Tablet"), &name, &read_back, None).expect("first half");
    let (tablet, new_key) = recovery.complete("a new password").expect("second half");
    assert!(new_key != key);

    // Same account keys, so the same data.
    let collections = tablet.collection_manager().unwrap();
    let fetched = collections.fetch(collection.uid(), None).expect("fetch");
    let listed = collections
        .item_manager(&fetched)
        .unwrap()
        .list(Some(&FetchOptions::new()))
        .expect("list");
    let contents: Vec<Vec<u8>> = listed
        .data()
        .iter()
        .map(|item| item.content().unwrap())
        .collect();
    assert!(contents.contains(&b"what it says".to_vec()));

    // Every other device is out, the old password and the old key are dead.
    assert!(matches!(
        account.security().status(),
        Err(Error::Refused { ref code, .. }) if code == refusal::SESSION_ENDED
    ));
    assert_eq!(
        reason(login(&name, PASSWORD, None)),
        refusal::WRONG_PASSWORD
    );
    login(&name, "a new password", None).expect("the new password");
    assert_eq!(
        reason(Account::recover(device(url(), "Tablet"), &name, &key, None)),
        refusal::WRONG_RECOVERY_KEY
    );
    Account::recover(device(url(), "Tablet"), &name, &new_key, None)
        .expect("the new key opens a recovery");
    assert!(tablet.security().status().unwrap().recovery_key());
}

#[test]
fn recovery_of_an_account_with_a_second_factor_takes_a_code() {
    let (account, name, key) = signup("ann");
    let (mut authenticator, _backup) = enrol(&account);

    assert_eq!(
        reason(Account::recover(device(url(), "Tablet"), &name, &key, None)),
        refusal::CODE_REQUIRED
    );
    let recovery = Account::recover(
        device(url(), "Tablet"),
        &name,
        &key,
        Some(&authenticator.code()),
    )
    .expect("first half");
    let (tablet, _new_key) = recovery.complete("a new password").expect("second half");
    // The authenticator survives a recovery, and the session it opens has
    // shown it.
    let status = tablet.security().status().unwrap();
    assert!(status.authenticator());
    assert!(status.session_verified());
}

#[test]
fn new_password_signs_other_devices_out_and_keeps_the_recovery_key() {
    let (mut account, name, key) = signup("ann");
    let phone = login(&name, PASSWORD, None).expect("second device");
    let collection = new_collection(&account, "notes");

    account
        .change_password_with_code("a new password", None)
        .expect("change the password");
    // This device carries on with the keys it has.
    account
        .collection_manager()
        .unwrap()
        .fetch(collection.uid(), None)
        .expect("still signed in");
    assert!(matches!(
        phone.security().status(),
        Err(Error::Refused { ref code, .. }) if code == refusal::SESSION_ENDED
    ));
    assert_eq!(
        reason(login(&name, PASSWORD, None)),
        refusal::WRONG_PASSWORD
    );
    let again = login(&name, "a new password", None).expect("the new password");
    again
        .collection_manager()
        .unwrap()
        .fetch(collection.uid(), None)
        .expect("the new password opens the same keys");

    // The recovery copy wraps the account keys, which did not change.
    Account::recover(device(url(), "Tablet"), &name, &key, None)
        .expect("the recovery key still works");

    // And the account can change it again with what it now holds.
    account
        .change_password_with_code("a third password", None)
        .expect("change it again");
    login(&name, "a third password", None).expect("the third password");
}

#[test]
fn new_password_takes_a_code_where_there_is_a_second_factor() {
    let (mut account, name, _key) = signup("ann");
    let (mut authenticator, backup) = enrol(&account);

    assert_eq!(
        reason(account.change_password_with_code("a new password", None)),
        refusal::CODE_REQUIRED
    );
    // Refused, so nothing changed, here or there.
    login(&name, PASSWORD, Some(&backup[0])).expect("the old password still works");

    account
        .change_password_with_code("a new password", Some(&authenticator.code()))
        .expect("with a code");
}

#[test]
fn new_recovery_key_replaces_the_old_one() {
    let (account, name, key) = signup("ann");
    let security = account.security();

    assert_eq!(
        reason(security.new_recovery_key("not the password", None)),
        refusal::WRONG_PASSWORD
    );
    let new_key = security
        .new_recovery_key(PASSWORD, None)
        .expect("a new recovery key");
    assert_eq!(
        reason(Account::recover(device(url(), "Tablet"), &name, &key, None)),
        refusal::WRONG_RECOVERY_KEY
    );
    let recovery = Account::recover(device(url(), "Tablet"), &name, &new_key, None)
        .expect("the new key opens a recovery");
    recovery
        .complete("a new password")
        .expect("and finishes it");
}

#[test]
fn devices_are_listed_and_signed_out_one_by_one_or_all_at_once() {
    let (account, name, _key) = signup("ann");
    let phone = login(&name, PASSWORD, None).expect("second device");
    let tablet = Account::login_with_code(device(url(), "Tablet"), &name, PASSWORD, None)
        .expect("third device");

    let sessions = account.security().sessions().expect("list");
    assert_eq!(sessions.len(), 3);
    let named = |start: &str| {
        sessions
            .iter()
            .find(|session| session.device_name().starts_with(start))
            .unwrap_or_else(|| panic!("no session of {start}"))
    };
    assert!(named("Laptop").current());
    assert!(!named("Phone").current());
    assert!(!named("Phone").second_factor());
    assert!(named("Phone").created_at() > 1_700_000_000);
    assert!(named("Phone").last_used_at() >= named("Phone").created_at());

    account
        .security()
        .end_session(named("Phone").id())
        .expect("sign the phone out");
    assert!(matches!(
        phone.security().sessions(),
        Err(Error::Refused { ref code, .. }) if code == refusal::SESSION_ENDED
    ));
    // The Etebase calls say the same in their own way, which is what the
    // app's sync sees.
    assert_eq!(
        phone.collection_manager().unwrap().list("any", None).err(),
        Some(Error::Unauthorized("Invalid token.".to_owned()))
    );
    tablet.security().status().expect("the tablet is untouched");
    assert!(matches!(
        account.security().end_session(named("Phone").id()),
        Err(Error::Refused { status: 404, .. })
    ));

    tablet
        .security()
        .end_other_sessions()
        .expect("sign everyone else out");
    assert!(account.security().status().is_err());
    let left = tablet.security().sessions().expect("list");
    assert_eq!(left.len(), 1);
    assert!(left[0].current());
}

#[test]
fn closed_server_takes_a_signup_with_a_code_and_no_other() {
    let url = common::start_server(common::closed_signup);
    assert_eq!(
        reason(signup_at(&url, "ann", &SignupWith::new())),
        refusal::SIGNUP_CLOSED
    );
    assert_eq!(
        reason(signup_at(
            &url,
            "ann",
            &SignupWith::new().signup_code("ABCD-EFGH-JKLM")
        )),
        refusal::SIGNUP_INVITATION_INVALID
    );

    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    let code = runtime.block_on(async {
        let state = common::admin_state().await;
        admin::create_signup_code(&state, "for Ann", 7)
            .await
            .expect("a signup code")
    });
    let with = SignupWith::new().signup_code(&code);
    let (account, _name, _key) = signup_at(&url, "ann", &with).expect("signup with the code");
    assert!(account.security().status().unwrap().recovery_key());
    // Good for one account.
    assert_eq!(
        reason(signup_at(&url, "bob", &with)),
        refusal::SIGNUP_INVITATION_INVALID
    );
}
