//! A server started inside the test process, and the client the app ships
//! pointed at it.
//!
//! Tests share one Postgres database and keep out of each other's way by
//! using fresh usernames, so they can run in parallel. Point
//! `MINDSTREAM_TEST_DATABASE_URL` at another database to override the
//! default, which is the one `compose.dev.yml` starts.

#![allow(dead_code)] // each test file uses its own subset

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use etebase::{Account, Client, Collection, CollectionAccessLevel, ItemMetadata, User};
use mindstream_server::config::SignupPolicy;
use mindstream_server::{serve, AppState, Config};

const DEFAULT_DATABASE_URL: &str = "postgres://mindstream:mindstream@127.0.0.1:15432/mindstream";

pub fn database_url() -> String {
    std::env::var("MINDSTREAM_TEST_DATABASE_URL").unwrap_or_else(|_| DEFAULT_DATABASE_URL.into())
}

/// Start a server on a free port and return its URL. It lives until the test
/// process exits.
pub fn start_server(configure: impl FnOnce(&mut Config) + Send + 'static) -> String {
    let (ready, started) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        runtime.block_on(async move {
            let blob_dir = std::env::temp_dir().join(format!(
                "mindstream-server-test-{}-{}",
                std::process::id(),
                unique()
            ));
            let mut config = Config::for_tests(database_url(), blob_dir);
            configure(&mut config);
            let state = AppState::connect(config).await.unwrap_or_else(|err| {
                panic!(
                    "could not start the test server ({err}). These tests need Postgres: \
                     run `docker compose -f backend/server/compose.dev.yml up -d`, or set \
                     MINDSTREAM_TEST_DATABASE_URL."
                )
            });
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind a free port");
            ready
                .send(listener.local_addr().expect("local address"))
                .expect("report the address");
            serve(listener, state, std::future::pending())
                .await
                .expect("serve");
        });
    });
    let address = started.recv().expect("the test server did not start");
    format!("http://{address}")
}

/// The server most tests share: open signup, nothing else special.
pub fn server() -> &'static str {
    static URL: OnceLock<String> = OnceLock::new();
    URL.get_or_init(|| start_server(|_| {}))
}

fn unique() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .subsec_nanos() as u64;
    (nanos << 16) | (COUNTER.fetch_add(1, Ordering::Relaxed) & 0xffff)
}

pub fn username(role: &str) -> String {
    format!("t-{role}-{}-{:x}", std::process::id(), unique())
}

pub fn client(url: &str) -> Client {
    Client::new("mindstream-server-tests", url).expect("client")
}

/// An account and the username it signed up with, which the client does not
/// expose once the account exists.
pub struct TestAccount {
    account: Account,
    pub name: String,
    /// The account main key, which stands in for the password.
    pub key: Vec<u8>,
}

impl std::ops::Deref for TestAccount {
    type Target = Account;

    fn deref(&self) -> &Account {
        &self.account
    }
}

/// Sign up a new account. The key is used directly so no test waits on the
/// password hash.
pub fn signup_at(url: &str, role: &str) -> TestAccount {
    etebase::init().expect("init etebase");
    let name = username(role);
    let user = User::new(&name, &format!("{name}@test.local"));
    let key = etebase::utils::randombytes(32);
    let account = Account::signup_key(client(url), &user, &key).expect("signup");
    TestAccount { account, name, key }
}

pub fn signup(role: &str) -> TestAccount {
    signup_at(server(), role)
}

pub fn named(name: &str) -> ItemMetadata {
    ItemMetadata::new().set_name(Some(name)).clone()
}

pub const COLLECTION_TYPE: &str = "test.space";

/// Create and upload a collection owned by `account`.
pub fn new_collection(account: &Account, name: &str) -> Collection {
    let collections = account.collection_manager().expect("collection manager");
    let collection = collections
        .create(COLLECTION_TYPE, &named(name), b"")
        .expect("create collection");
    collections.upload(&collection, None).expect("upload");
    collection
}

/// Invite `guest` to `collection` and have them accept. Returns the
/// collection as the guest sees it.
pub fn share(
    owner: &Account,
    collection: &Collection,
    guest: &TestAccount,
    level: CollectionAccessLevel,
) -> Collection {
    let guest_name = guest.name.as_str();
    let owner_invites = owner.invitation_manager().expect("invitation manager");
    let profile = owner_invites
        .fetch_user_profile(guest_name)
        .expect("guest profile");
    owner_invites
        .invite(collection, guest_name, profile.pubkey(), level)
        .expect("invite");

    let guest_invites = guest.invitation_manager().expect("invitation manager");
    let incoming = guest_invites.list_incoming(None).expect("incoming");
    let invitation = incoming
        .data()
        .iter()
        .find(|invitation| invitation.collection() == collection.uid())
        .expect("the invitation arrived");
    guest_invites.accept(invitation).expect("accept");
    guest
        .collection_manager()
        .expect("collection manager")
        .fetch(collection.uid(), None)
        .expect("guest fetches the collection")
}

pub fn closed_signup(config: &mut Config) {
    config.signup = SignupPolicy::Closed;
}
