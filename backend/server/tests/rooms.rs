//! Live rooms, driven over real sockets: who gets in, who is told what, and
//! whose frames are passed on.

mod common;

use common::raw::{
    Device, Frame, Socket, ACCESS, ADMIN, JOINED, LEFT, PRESENCE, READ_ONLY, READ_WRITE, SYNC,
    UPDATE,
};
use mindstream_server::{admin, AppState, Config};

/// An owner with one collection holding one item, on the shared server.
async fn space() -> (Device, String, String) {
    let owner = Device::signup(common::server(), "owner").await;
    let collection = owner.create_collection().await;
    let item = owner.add_item(&collection).await;
    (owner, collection, item)
}

#[tokio::test]
async fn members_of_a_room_see_each_other_and_exchange_frames() {
    let (owner, collection, item) = space().await;
    let writer = Device::signup(common::server(), "writer").await;
    owner.share(&collection, &writer, READ_WRITE).await;

    let (mut owner_socket, welcome) = owner.enter(&collection, &item).await;
    assert_eq!(welcome["accessLevel"], ADMIN);
    assert!(welcome["peers"].as_array().unwrap().is_empty());
    let owner_id = welcome["you"].as_u64().unwrap();

    let (mut writer_socket, welcome) = writer.enter(&collection, &item).await;
    assert_eq!(welcome["accessLevel"], READ_WRITE);
    // The roster names members by the account the server authenticated,
    // not by anything a client says about itself.
    let peers = welcome["peers"].as_array().unwrap();
    assert_eq!(peers.len(), 1);
    assert_eq!(peers[0]["username"], owner.name.as_str());
    assert_eq!(peers[0]["id"], owner_id);
    let writer_id = welcome["you"].as_u64().unwrap();

    match owner_socket.next().await {
        Frame::Control(JOINED, joined) => {
            assert_eq!(joined["username"], writer.name.as_str());
            assert_eq!(joined["id"], writer_id);
        }
        other => panic!("expected a join notice, got {other:?}"),
    }

    writer_socket.send(UPDATE, b"ciphertext").await;
    assert_eq!(
        owner_socket.next().await,
        Frame::Relayed {
            class: UPDATE,
            sender: writer_id,
            payload: b"ciphertext".to_vec()
        }
    );
    writer_socket.expect_quiet().await;

    // A reply reaches the member it names and nobody else.
    let reader = Device::signup(common::server(), "third").await;
    owner.share(&collection, &reader, READ_WRITE).await;
    let (mut third_socket, _) = reader.enter(&collection, &item).await;
    assert!(matches!(
        owner_socket.next().await,
        Frame::Control(JOINED, _)
    ));
    assert!(matches!(
        writer_socket.next().await,
        Frame::Control(JOINED, _)
    ));
    owner_socket.reply(writer_id, b"state for you").await;
    assert!(matches!(
        writer_socket.next().await,
        Frame::Relayed { sender, .. } if sender == owner_id
    ));
    third_socket.expect_quiet().await;

    drop(writer_socket);
    assert!(matches!(owner_socket.next().await, Frame::Control(LEFT, _)));
}

#[tokio::test]
async fn nobody_enters_without_a_ticket_they_are_entitled_to() {
    let (owner, collection, item) = space().await;
    let outsider = Device::signup(common::server(), "outsider").await;

    // Not a member: no ticket, and no hint the collection exists.
    assert_eq!(outsider.ticket(&collection, &item).await, Err(404));
    // A member, but no such item.
    assert_eq!(
        owner.ticket(&collection, "AAAAAAAAAAAAAAAAAAAAAAAA").await,
        Err(404)
    );

    // A made-up ticket.
    let mut socket = Socket::open(common::server(), "/api/v1/room/", None).await;
    socket.hello("bm90IGEgdGlja2V0").await;
    assert_eq!(socket.next().await, Frame::Closed(4401));

    // Frames before the ticket.
    let mut socket = Socket::open(common::server(), "/api/v1/room/", None).await;
    socket.send(UPDATE, b"let me in").await;
    assert_eq!(socket.next().await, Frame::Closed(4401));

    // A ticket from a server with another secret is worthless here. A second
    // database would be needed to show that end to end; the key tests cover
    // it.
}

#[tokio::test]
async fn ticket_issued_before_a_removal_no_longer_opens_the_room() {
    let (owner, collection, item) = space().await;
    let guest = Device::signup(common::server(), "guest").await;
    owner.share(&collection, &guest, READ_WRITE).await;

    let ticket = guest.ticket(&collection, &item).await.unwrap();
    owner.remove_member(&collection, &guest).await;

    let mut socket = Socket::open(common::server(), "/api/v1/room/", None).await;
    socket.hello(&ticket).await;
    assert_eq!(socket.next().await, Frame::Closed(4403));
}

#[tokio::test]
async fn read_only_member_watches_live_but_cannot_edit() {
    let (owner, collection, item) = space().await;
    let reader = Device::signup(common::server(), "reader").await;
    owner.share(&collection, &reader, READ_ONLY).await;

    let (mut owner_socket, _) = owner.enter(&collection, &item).await;
    let (mut reader_socket, welcome) = reader.enter(&collection, &item).await;
    assert_eq!(welcome["accessLevel"], READ_ONLY);
    let reader_id = welcome["you"].as_u64().unwrap();
    assert!(matches!(
        owner_socket.next().await,
        Frame::Control(JOINED, _)
    ));

    owner_socket.send(UPDATE, b"edit").await;
    assert!(matches!(
        reader_socket.next().await,
        Frame::Relayed { class: UPDATE, .. }
    ));

    // The reader's own attempts at changing the document go nowhere,
    // whether sent to the room or addressed to one member.
    reader_socket.send(UPDATE, b"forged edit").await;
    reader_socket.reply(1, b"forged state").await;
    owner_socket.expect_quiet().await;

    // Asking for the state and showing a cursor are fine.
    reader_socket.send(SYNC, b"what did I miss").await;
    assert_eq!(
        owner_socket.next().await,
        Frame::Relayed {
            class: SYNC,
            sender: reader_id,
            payload: b"what did I miss".to_vec()
        }
    );
    reader_socket.send(PRESENCE, b"cursor").await;
    assert!(matches!(
        owner_socket.next().await,
        Frame::Relayed {
            class: PRESENCE,
            ..
        }
    ));
}

#[tokio::test]
async fn removing_a_member_closes_their_open_socket() {
    let (owner, collection, item) = space().await;
    let guest = Device::signup(common::server(), "guest").await;
    owner.share(&collection, &guest, READ_WRITE).await;

    let (mut owner_socket, _) = owner.enter(&collection, &item).await;
    let (mut guest_socket, _) = guest.enter(&collection, &item).await;
    assert!(matches!(
        owner_socket.next().await,
        Frame::Control(JOINED, _)
    ));

    owner.remove_member(&collection, &guest).await;
    assert_eq!(guest_socket.next().await, Frame::Closed(4403));
    assert!(matches!(owner_socket.next().await, Frame::Control(LEFT, _)));

    // The owner's own socket is untouched.
    owner_socket.send(PRESENCE, b"still here").await;
    owner_socket.expect_quiet().await;
}

#[tokio::test]
async fn downgrade_reaches_the_open_socket() {
    let (owner, collection, item) = space().await;
    let guest = Device::signup(common::server(), "guest").await;
    owner.share(&collection, &guest, READ_WRITE).await;

    let (mut owner_socket, _) = owner.enter(&collection, &item).await;
    let (mut guest_socket, _) = guest.enter(&collection, &item).await;
    assert!(matches!(
        owner_socket.next().await,
        Frame::Control(JOINED, _)
    ));

    guest_socket.send(UPDATE, b"allowed").await;
    assert!(matches!(owner_socket.next().await, Frame::Relayed { .. }));

    owner.set_access(&collection, &guest, READ_ONLY).await;
    match guest_socket.next().await {
        Frame::Control(ACCESS, access) => assert_eq!(access["accessLevel"], READ_ONLY),
        other => panic!("expected the new access level, got {other:?}"),
    }
    guest_socket.send(UPDATE, b"no longer allowed").await;
    owner_socket.expect_quiet().await;

    // And back again.
    owner.set_access(&collection, &guest, READ_WRITE).await;
    assert!(matches!(
        guest_socket.next().await,
        Frame::Control(ACCESS, _)
    ));
    guest_socket.send(UPDATE, b"allowed again").await;
    assert!(matches!(owner_socket.next().await, Frame::Relayed { .. }));
}

#[tokio::test]
async fn disabling_an_account_from_the_command_line_closes_its_sockets() {
    let (owner, collection, item) = space().await;
    let (mut socket, _) = owner.enter(&collection, &item).await;

    // The admin command runs in another process. Here it is another
    // connection to the same database, which is all the server can see of
    // it either way.
    let blob_dir = std::env::temp_dir().join("mindstream-server-test-admin");
    let other = AppState::connect(Config::for_tests(common::database_url(), blob_dir))
        .await
        .unwrap();
    assert!(admin::set_disabled(&other, &owner.name, true)
        .await
        .unwrap());

    assert_eq!(socket.next().await, Frame::Closed(4403));
    assert_eq!(owner.ticket(&collection, &item).await, Err(401));
}
