//! The change feed: devices are told to sync when there is something to
//! sync, and not otherwise.

mod common;

use common::raw::{Device, Socket, READ_WRITE};

#[tokio::test]
async fn members_hear_about_a_push_and_the_pusher_does_not() {
    let owner = Device::signup(common::server(), "owner").await;
    let guest = Device::signup(common::server(), "guest").await;
    let stranger = Device::signup(common::server(), "stranger").await;
    let collection = owner.create_collection().await;
    owner.share(&collection, &guest, READ_WRITE).await;

    let mut owner_feed = owner.feed().await;
    let mut guest_feed = guest.feed().await;
    let mut stranger_feed = stranger.feed().await;

    owner.add_item(&collection).await;
    assert_eq!(guest_feed.news().await, Some((true, false)));
    // The session that pushed already knows; someone outside the collection
    // has nothing to learn.
    owner_feed.expect_no_news().await;
    stranger_feed.expect_no_news().await;

    guest.add_item(&collection).await;
    assert_eq!(owner_feed.news().await, Some((true, false)));
    guest_feed.expect_no_news().await;
}

#[tokio::test]
async fn burst_of_pushes_is_one_piece_of_news() {
    let owner = Device::signup(common::server(), "owner").await;
    let guest = Device::signup(common::server(), "guest").await;
    let collection = owner.create_collection().await;
    owner.share(&collection, &guest, READ_WRITE).await;
    let mut guest_feed = guest.feed().await;

    let pushes = (0..5).map(|_| owner.add_item(&collection));
    futures_util::future::join_all(pushes).await;

    assert_eq!(guest_feed.news().await, Some((true, false)));
    guest_feed.expect_no_news().await;
}

#[tokio::test]
async fn invitations_and_memberships_are_announced() {
    let owner = Device::signup(common::server(), "owner").await;
    let guest = Device::signup(common::server(), "guest").await;
    let collection = owner.create_collection().await;
    let mut owner_feed = owner.feed().await;
    let mut guest_feed = guest.feed().await;

    let invitation = owner.invite(&collection, &guest, READ_WRITE).await;
    assert_eq!(guest_feed.news().await, Some((false, true)));
    owner_feed.expect_no_news().await;

    // Accepting gives the guest a collection to sync and takes the
    // invitation off the owner's outgoing list.
    guest.accept(&invitation).await;
    assert_eq!(guest_feed.news().await, Some((true, false)));
    assert_eq!(owner_feed.news().await, Some((true, true)));

    // Being removed is news for the one removed.
    owner.remove_member(&collection, &guest).await;
    assert_eq!(guest_feed.news().await, Some((true, false)));
}

#[tokio::test]
async fn feed_needs_a_session() {
    let refused = Socket::try_open(common::server(), "/api/v1/mindstream/feed/", None).await;
    assert!(refused.is_err(), "an anonymous feed socket was opened");
    let refused = Socket::try_open(
        common::server(),
        "/api/v1/mindstream/feed/",
        Some("not-a-token"),
    )
    .await;
    assert!(refused.is_err(), "a bad token opened a feed socket");
}

/// The feed as the app opens it: at the address, and with the header, that
/// the client library it ships hands out for a signed-in account.
#[test]
fn feed_opens_with_what_the_client_the_app_ships_hands_out() {
    let laptop = common::signup("owner");
    let endpoint = laptop.mindstream().feed_endpoint().unwrap();
    assert!(endpoint.url().starts_with("ws://127.0.0.1:"));
    assert!(endpoint.url().ends_with("/api/v1/mindstream/feed/"));
    let token = endpoint
        .authorization()
        .strip_prefix("Token ")
        .expect("a token header");
    // The session token must not end up in a log by way of a debug print.
    assert!(!format!("{endpoint:?}").contains(token));

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut feed = runtime.block_on(async {
        let mut socket = Socket::open(endpoint.url(), "", Some(token)).await;
        match socket.next_message().await {
            Some(tokio_tungstenite::tungstenite::Message::Binary(hello)) => {
                let hello: serde_json::Value = rmp_serde::from_slice(&hello).unwrap();
                assert_eq!(hello["protocol"], 1);
            }
            other => panic!("expected the feed's greeting, got {other:?}"),
        }
        socket
    });

    // The same account on a second device makes a change. The first hears
    // of it without asking.
    let phone =
        etebase::Account::login_key(common::client(common::server()), &laptop.name, &laptop.key)
            .unwrap();
    common::new_collection(&phone, "made on the phone");
    assert_eq!(runtime.block_on(feed.news()), Some((true, false)));
}
