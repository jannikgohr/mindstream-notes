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

/// A ticket is asked for over HTTP and spent on a socket a moment later.
/// A session that ends in between has nothing open for the server to
/// close, so the news of its end passes the socket by. The socket is
/// therefore asked about once more after it has taken its place in the
/// room, and that is what turns it away here.
#[tokio::test]
async fn ticket_issued_before_a_sign_out_no_longer_opens_the_room() {
    let (owner, collection, item) = space().await;
    let guest = Device::signup(common::server(), "guest").await;
    owner.share(&collection, &guest, READ_WRITE).await;
    // Someone to notice whether the guest got in after all.
    let (mut watcher, _) = owner.enter(&collection, &item).await;

    let ticket = guest.ticket(&collection, &item).await.unwrap();
    let (status, _) = guest
        .call::<()>(reqwest::Method::POST, "/authentication/logout/", None)
        .await;
    assert!((200..300).contains(&status), "logout answered {status}");
    // The session is gone, so the same device gets no second ticket.
    assert_eq!(guest.ticket(&collection, &item).await, Err(401));

    // Turned away the way any ticket is that no longer entitles its holder
    // to the room. The server does not say which of the reasons it was. A
    // client asks for a new ticket either way, and that request is refused
    // as not signed in, as above.
    let mut socket = Socket::open(common::server(), "/api/v1/room/", None).await;
    socket.hello(&ticket).await;
    assert_eq!(socket.next().await, Frame::Closed(4403));

    // Whatever the room saw of the guest, the guest is not in it: a frame
    // from the owner's second socket is the next thing of substance.
    let (mut second, _) = owner.enter(&collection, &item).await;
    second.send(UPDATE, b"only among the owner's devices").await;
    loop {
        match watcher.next().await {
            Frame::Relayed { payload, .. } => {
                assert_eq!(payload, b"only among the owner's devices");
                break;
            }
            Frame::Control(JOINED | LEFT, _) => {}
            other => panic!("unexpected frame in the room: {other:?}"),
        }
    }
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

/// The ticket as the app gets it: from the client library it ships, with
/// the account's real session.
#[test]
fn ticket_from_the_client_the_app_ships_opens_the_room() {
    use etebase::error::Error;
    use etebase::CollectionAccessLevel;

    let owner = common::signup("owner");
    let reader = common::signup("reader");
    let outsider = common::signup("outsider");
    let collection = common::new_collection(&owner, "space");
    let items = owner
        .collection_manager()
        .unwrap()
        .item_manager(&collection)
        .unwrap();
    let note = items.create(&common::named("note"), b"body").unwrap();
    items.batch(std::iter::once(&note), None).unwrap();
    common::share(
        &owner,
        &collection,
        &reader,
        CollectionAccessLevel::ReadOnly,
    );

    let rooms = owner.mindstream();
    let ticket = rooms.room_ticket(collection.uid(), note.uid()).unwrap();
    assert_eq!(ticket.access_level(), CollectionAccessLevel::Admin);
    assert!((1..=60).contains(&ticket.expires_in()));
    let address = rooms.room_url().unwrap();
    assert!(address.starts_with("ws://127.0.0.1:"), "{address}");
    assert!(address.ends_with("/api/v1/room/"), "{address}");

    // A member who may only read is told so with the ticket, and still
    // gets one: reading along is allowed.
    let reading = reader
        .mindstream()
        .room_ticket(collection.uid(), note.uid())
        .unwrap();
    assert_eq!(reading.access_level(), CollectionAccessLevel::ReadOnly);
    assert!(matches!(
        outsider
            .mindstream()
            .room_ticket(collection.uid(), note.uid()),
        Err(Error::NotFound(_))
    ));

    let welcome = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut socket = Socket::open(&address, "", None).await;
            socket.hello(ticket.ticket()).await;
            match socket.next().await {
                Frame::Control(common::raw::WELCOME, welcome) => welcome,
                other => panic!("expected a welcome, got {other:?}"),
            }
        });
    assert_eq!(welcome["accessLevel"], ADMIN);
    assert!(welcome["you"].as_u64().is_some());
}

/// A frame may be larger than what a member is allowed to have waiting: a
/// document's whole state is one frame. A member that is reading must get
/// it, and must not be closed as one that cannot keep up.
#[tokio::test]
async fn frame_larger_than_the_backlog_allowance_reaches_a_member_that_is_reading() {
    let (owner, collection, item) = space().await;
    let (mut sender, _) = owner.enter(&collection, &item).await;
    let (mut receiver, _) = owner.enter(&collection, &item).await;
    assert!(matches!(sender.next().await, Frame::Control(JOINED, _)));

    let state = vec![7u8; 5 * 1024 * 1024];
    let (_, received) = tokio::join!(sender.send(UPDATE, &state), receiver.next());
    match received {
        Frame::Relayed { class, payload, .. } => {
            assert_eq!(class, UPDATE);
            assert_eq!(payload.len(), state.len());
        }
        other => panic!("expected the frame, got {other:?}"),
    }
    // And the room goes on as before.
    sender.send(UPDATE, b"after").await;
    assert!(matches!(receiver.next().await, Frame::Relayed { .. }));
}

// ---------- the protocol as written down ----------

fn protocol() -> serde_json::Value {
    serde_json::from_str(include_str!("../../../protocol/room/room-protocol.json"))
        .expect("the room protocol file is JSON")
}

fn bytes_of(hex: &serde_json::Value) -> Vec<u8> {
    let hex = hex.as_str().expect("hex as a string");
    (0..hex.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).expect("hex digits"))
        .collect()
}

/// Someone in the exchange: the name the protocol file gives them, the
/// account that plays them, and what the server made of them.
struct Player {
    username: String,
    id: Option<u64>,
    socket: Option<Socket>,
}

/// A body from the protocol file with its names turned into what this
/// server handed out: a member's name into their id or their username, an
/// access level's name into its number.
fn in_this_room(
    body: &serde_json::Value,
    key: Option<&str>,
    players: &std::collections::HashMap<String, Player>,
    spec: &serde_json::Value,
) -> serde_json::Value {
    use serde_json::Value;
    match body {
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(name, value)| (name.clone(), in_this_room(value, Some(name), players, spec)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| in_this_room(item, None, players, spec))
                .collect(),
        ),
        Value::String(name) => match key {
            Some("you" | "id") => players[name].id.expect("they have joined").into(),
            Some("username") => players[name].username.clone().into(),
            Some("accessLevel") => spec["accessLevels"][name].clone(),
            _ => body.clone(),
        },
        other => other.clone(),
    }
}

/// The conversation in the protocol file, held over real sockets. The
/// hub's own test checks the frames it builds. This checks the whole way:
/// what a member's bytes are taken to mean, who is sent what because of
/// them, and what a member who may only read is not allowed to say.
#[tokio::test]
async fn room_exchange_goes_as_the_protocol_says() {
    use std::collections::HashMap;

    let spec = protocol();
    // The numbers this file's helpers send and expect are the protocol's.
    for (name, value) in [
        ("hello", common::raw::HELLO),
        ("welcome", common::raw::WELCOME),
        ("joined", JOINED),
        ("left", LEFT),
        ("access", ACCESS),
    ] {
        assert_eq!(spec["frames"][name], value, "frame {name}");
    }
    for (name, value) in [
        ("update", UPDATE),
        ("sync", SYNC),
        ("reply", common::raw::REPLY),
        ("presence", PRESENCE),
    ] {
        assert_eq!(spec["classes"][name], value, "class {name}");
    }
    for (name, value) in [
        ("readOnly", READ_ONLY),
        ("admin", ADMIN),
        ("readWrite", READ_WRITE),
    ] {
        assert_eq!(spec["accessLevels"][name], value, "access {name}");
    }

    // Ann owns the space, which makes her its admin. Bob is invited with
    // whatever access the protocol file has him join with.
    let (ann, collection, item) = space().await;
    let bob = Device::signup(common::server(), "bob").await;
    let mut players: HashMap<String, Player> = HashMap::new();
    for (name, device) in [("ann", &ann), ("bob", &bob)] {
        players.insert(
            name.to_string(),
            Player {
                username: device.name.clone(),
                id: None,
                socket: None,
            },
        );
    }
    let level = |name: &serde_json::Value| -> i16 {
        spec["accessLevels"][name.as_str().unwrap()]
            .as_i64()
            .expect("an access level") as i16
    };
    let class = |name: &serde_json::Value| -> u8 {
        spec["classes"][name.as_str().unwrap()]
            .as_u64()
            .expect("a class") as u8
    };

    for (number, step) in spec["exchange"].as_array().unwrap().iter().enumerate() {
        let what = format!("step {number}: {step}");
        let mut welcome = None;
        if let Some(who) = step["join"].as_str() {
            let device = if who == "ann" {
                assert_eq!(level(&step["access"]), ADMIN, "{what}");
                &ann
            } else {
                ann.share(&collection, &bob, level(&step["access"])).await;
                &bob
            };
            let (socket, body) = device.enter(&collection, &item).await;
            let player = players.get_mut(who).unwrap();
            player.id = body["you"].as_u64();
            player.socket = Some(socket);
            welcome = Some((who.to_string(), body));
        } else if let Some(who) = step["send"].as_str() {
            let payload = bytes_of(&step["payload"]);
            let target = step["target"]
                .as_str()
                .map(|name| players[name].id.expect("the target has joined"));
            let socket = players.get_mut(who).unwrap().socket.as_mut().unwrap();
            match target {
                Some(target) => {
                    assert_eq!(class(&step["class"]), common::raw::REPLY, "{what}");
                    socket.reply(target, &payload).await;
                }
                None => socket.send(class(&step["class"]), &payload).await,
            }
        } else if let Some(who) = step["setAccess"].as_str() {
            assert_eq!(who, "bob", "{what}");
            ann.set_access(&collection, &bob, level(&step["access"]))
                .await;
        } else if let Some(who) = step["leave"].as_str() {
            // Dropping the socket closes it.
            players.get_mut(who).unwrap().socket = None;
        } else {
            panic!("a step this test does not know how to take: {what}");
        }

        for expected in step["then"].as_array().unwrap() {
            let to = expected["to"].as_str().unwrap();
            let received = match &welcome {
                // `enter` has read the welcome off the socket already.
                Some((who, body)) if who == to && expected["frame"] == "welcome" => {
                    Frame::Control(common::raw::WELCOME, body.clone())
                }
                _ => {
                    players
                        .get_mut(to)
                        .unwrap()
                        .socket
                        .as_mut()
                        .unwrap()
                        .next()
                        .await
                }
            };
            let wanted = match expected["frame"].as_str() {
                Some(frame) => Frame::Control(
                    spec["frames"][frame].as_u64().expect("a frame") as u8,
                    in_this_room(&expected["body"], None, &players, &spec),
                ),
                None => Frame::Relayed {
                    class: class(&expected["class"]),
                    sender: players[expected["sender"].as_str().unwrap()]
                        .id
                        .expect("the sender has joined"),
                    payload: bytes_of(&expected["payload"]),
                },
            };
            assert_eq!(received, wanted, "{what}, to {to}");
        }
    }
}
