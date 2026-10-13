//! The sockets this process holds open: who is in which room, and which
//! devices are waiting to hear that something changed.
//!
//! Everything here is in memory and synchronous. Decisions that need the
//! database are made by the callers, and changes made elsewhere arrive as
//! events (see `events`), so a second process serving sockets stays correct.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use axum::body::Bytes;
use serde::Serialize;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::sync::Notify;

use crate::wire::ACCESS_READ_ONLY;

// Client to server.
pub const FRAME_HELLO: u8 = 0x01;
// Server to client.
pub const FRAME_WELCOME: u8 = 0x02;
pub const FRAME_JOINED: u8 = 0x03;
pub const FRAME_LEFT: u8 = 0x04;
pub const FRAME_ACCESS: u8 = 0x05;
// Relayed between members. The class is outside the ciphertext so the server
// can decide who may send it, and a receiver must act on the class and not
// on anything inside the payload: that is what stops a read-only member from
// passing a document change off as presence.
/// A change to the document. Needs write access.
pub const CLASS_UPDATE: u8 = 0x10;
/// A request for the document's state, sent on joining.
pub const CLASS_SYNC: u8 = 0x11;
/// An answer to one member's request. It carries document state, so it needs
/// write access too.
pub const CLASS_REPLY: u8 = 0x12;
/// Cursors and the like. Never stored, never part of the document.
pub const CLASS_PRESENCE: u8 = 0x20;

pub const CLOSE_BAD_FRAME: u16 = 4400;
pub const CLOSE_UNAUTHORIZED: u16 = 4401;
pub const CLOSE_REMOVED: u16 = 4403;
pub const CLOSE_SLOW: u16 = 4408;
pub const CLOSE_TOO_MANY: u16 = 4429;
/// The server can no longer check that the socket may stay open. The
/// standard code for "try again later".
pub const CLOSE_UNAVAILABLE: u16 = 1013;

/// A member whose socket already has this much waiting to be written when
/// the next frame comes is not keeping up. Frames are ciphertext, so nothing
/// can be merged or dropped for them; the socket is closed and the client
/// reconnects and resyncs.
const MAX_QUEUED_BYTES: usize = 4 * 1024 * 1024;
/// Sockets one account may hold across all rooms.
const MAX_ROOM_SOCKETS_PER_ACCOUNT: usize = 64;
/// Change feeds one account may hold. A device needs one.
const MAX_FEEDS_PER_ACCOUNT: usize = 32;
/// Change feeds one session may hold: the one it uses, and room for the one
/// it opens while the last is still closing.
const MAX_FEEDS_PER_SESSION: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct RoomKey {
    pub collection_id: i64,
    pub item_id: i64,
}

/// Tells a connection task to close its socket now, ahead of anything queued.
#[derive(Default)]
pub struct Kick {
    code: AtomicU16,
    notify: Notify,
}

impl Kick {
    fn fire(&self, code: u16) {
        self.code.store(code, Ordering::SeqCst);
        self.notify.notify_one();
    }

    pub async fn fired(&self) -> u16 {
        self.notify.notified().await;
        self.code.load(Ordering::SeqCst)
    }
}

struct Peer {
    account_id: i64,
    session_id: i64,
    username: String,
    access: i16,
    frames: UnboundedSender<Bytes>,
    queued: Arc<AtomicUsize>,
    kick: Arc<Kick>,
}

impl Peer {
    /// Queue a frame, or report that the peer has fallen too far behind.
    ///
    /// Behind is judged by what was waiting before this frame. A frame may
    /// be several times the backlog allowance, a document's whole state for
    /// one, and a peer that is reading as fast as frames arrive must not be
    /// dropped for having been sent a large one.
    fn push(&self, frame: &Bytes) -> bool {
        let waiting = self.queued.fetch_add(frame.len(), Ordering::Relaxed);
        waiting <= MAX_QUEUED_BYTES && self.frames.send(frame.clone()).is_ok()
    }
}

/// What a device waiting on the change feed has been told since it last
/// looked. Flags, not a queue: "something changed" does not get truer by
/// being said twice.
#[derive(Default)]
pub struct FeedSignal {
    pub changed: AtomicBool,
    pub invitations: AtomicBool,
    /// The code to close the socket with, once there is one. Zero until
    /// then.
    pub closed: AtomicU16,
    pub notify: Notify,
}

impl FeedSignal {
    /// The code the feed was told to close with, if it was.
    pub fn close_code(&self) -> Option<u16> {
        match self.closed.load(Ordering::SeqCst) {
            0 => None,
            code => Some(code),
        }
    }
}

struct Feed {
    id: u32,
    session_id: i64,
    signal: Arc<FeedSignal>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeedNews {
    Changed,
    Invitations,
}

#[derive(Default)]
struct Inner {
    rooms: HashMap<RoomKey, HashMap<u32, Peer>>,
    feeds: HashMap<i64, Vec<Feed>>,
}

#[derive(Default)]
pub struct Hub {
    inner: Mutex<Inner>,
    next_id: AtomicU32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PeerInfo<'a> {
    id: u32,
    username: &'a str,
    access_level: i16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Welcome<'a> {
    you: u32,
    access_level: i16,
    peers: Vec<PeerInfo<'a>>,
}

#[derive(Serialize)]
struct Left {
    id: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessChanged {
    access_level: i16,
}

/// A frame from the server itself. Its body is JSON, unlike the rest of the
/// API: room sockets are opened by a web view, which reads JSON without
/// carrying a msgpack decoder for four small messages.
fn control<T: Serialize>(kind: u8, body: &T) -> Bytes {
    let mut frame = vec![kind];
    frame.extend(serde_json::to_vec(body).expect("control frames serialise"));
    Bytes::from(frame)
}

/// What a connection task needs after joining a room.
pub struct Joined {
    pub id: u32,
    pub frames: UnboundedReceiver<Bytes>,
    pub queued: Arc<AtomicUsize>,
    pub kick: Arc<Kick>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Relay {
    Sent,
    /// The sender may not send this class. The frame is dropped and the
    /// socket stays open: a client that was just downgraded will have frames
    /// in flight.
    Denied,
}

impl Hub {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A panic while holding the lock leaves the maps consistent enough
        // to keep serving; refusing every socket from then on would not be
        // better.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn next_id(&self) -> u32 {
        self.next_id.fetch_add(1, Ordering::Relaxed).wrapping_add(1)
    }

    /// Add a member to a room, tell it who is there and tell them it came.
    pub fn join(
        &self,
        key: RoomKey,
        account_id: i64,
        session_id: i64,
        username: String,
        access: i16,
    ) -> Result<Joined, u16> {
        let mut inner = self.lock();
        let held = inner
            .rooms
            .values()
            .flat_map(|room| room.values())
            .filter(|peer| peer.account_id == account_id)
            .count();
        if held >= MAX_ROOM_SOCKETS_PER_ACCOUNT {
            return Err(CLOSE_TOO_MANY);
        }

        let id = self.next_id();
        let (frames, receiver) = unbounded_channel();
        let peer = Peer {
            account_id,
            session_id,
            username,
            access,
            frames,
            queued: Arc::new(AtomicUsize::new(0)),
            kick: Arc::new(Kick::default()),
        };
        let room = inner.rooms.entry(key).or_default();

        let welcome = control(
            FRAME_WELCOME,
            &Welcome {
                you: id,
                access_level: access,
                peers: room
                    .iter()
                    .map(|(id, other)| PeerInfo {
                        id: *id,
                        username: &other.username,
                        access_level: other.access,
                    })
                    .collect(),
            },
        );
        let joined = control(
            FRAME_JOINED,
            &PeerInfo {
                id,
                username: &peer.username,
                access_level: access,
            },
        );
        peer.push(&welcome);
        Self::broadcast(room, &joined, None);

        let result = Joined {
            id,
            frames: receiver,
            queued: Arc::clone(&peer.queued),
            kick: Arc::clone(&peer.kick),
        };
        room.insert(id, peer);
        Ok(result)
    }

    pub fn leave(&self, key: RoomKey, id: u32) {
        let mut inner = self.lock();
        let Some(room) = inner.rooms.get_mut(&key) else {
            return;
        };
        if room.remove(&id).is_none() {
            return;
        }
        if room.is_empty() {
            inner.rooms.remove(&key);
        } else {
            Self::broadcast(room, &control(FRAME_LEFT, &Left { id }), None);
        }
    }

    /// Send a frame to everyone in the room but `except`, closing whoever
    /// cannot keep up.
    fn broadcast(room: &mut HashMap<u32, Peer>, frame: &Bytes, except: Option<u32>) {
        let mut slow = Vec::new();
        for (id, peer) in room.iter() {
            if Some(*id) != except && !peer.push(frame) {
                slow.push(*id);
            }
        }
        for id in slow {
            if let Some(peer) = room.remove(&id) {
                peer.kick.fire(CLOSE_SLOW);
            }
        }
    }

    /// Pass a member's frame on, if its access allows the class. `target`
    /// limits delivery to one member.
    pub fn relay(
        &self,
        key: RoomKey,
        sender: u32,
        class: u8,
        payload: &[u8],
        target: Option<u32>,
    ) -> Relay {
        let mut inner = self.lock();
        let Some(room) = inner.rooms.get_mut(&key) else {
            return Relay::Denied;
        };
        let Some(access) = room.get(&sender).map(|peer| peer.access) else {
            // Dropped for being slow, or removed, with frames still arriving.
            return Relay::Denied;
        };
        let needs_write = matches!(class, CLASS_UPDATE | CLASS_REPLY);
        if needs_write && access == ACCESS_READ_ONLY {
            return Relay::Denied;
        }

        let mut frame = Vec::with_capacity(5 + payload.len());
        frame.push(class);
        frame.extend_from_slice(&sender.to_be_bytes());
        frame.extend_from_slice(payload);
        let frame = Bytes::from(frame);
        match target {
            None => Self::broadcast(room, &frame, Some(sender)),
            Some(target) => {
                let delivered = room.get(&target).is_none_or(|peer| peer.push(&frame));
                if !delivered {
                    if let Some(peer) = room.remove(&target) {
                        peer.kick.fire(CLOSE_SLOW);
                    }
                }
            }
        }
        Relay::Sent
    }

    /// An account's access to a collection changed, or ended. Applies to
    /// every room of that collection the account is in, at once.
    pub fn membership_changed(&self, collection_id: i64, account_id: i64, access: Option<i16>) {
        let mut inner = self.lock();
        for (key, room) in inner.rooms.iter_mut() {
            if key.collection_id != collection_id {
                continue;
            }
            match access {
                Some(access) => {
                    let frame = control(
                        FRAME_ACCESS,
                        &AccessChanged {
                            access_level: access,
                        },
                    );
                    for peer in room.values_mut() {
                        if peer.account_id == account_id && peer.access != access {
                            peer.access = access;
                            peer.push(&frame);
                        }
                    }
                }
                None => Self::evict(room, CLOSE_REMOVED, |peer| peer.account_id == account_id),
            }
        }
        inner.rooms.retain(|_, room| !room.is_empty());
    }

    /// Remove the matching members from a room, and tell the rest they left.
    fn evict(room: &mut HashMap<u32, Peer>, code: u16, matches: impl Fn(&Peer) -> bool) {
        let gone: Vec<u32> = room
            .iter()
            .filter(|(_, peer)| matches(peer))
            .map(|(id, _)| *id)
            .collect();
        for id in gone {
            if let Some(peer) = room.remove(&id) {
                peer.kick.fire(code);
            }
            Self::broadcast(room, &control(FRAME_LEFT, &Left { id }), None);
        }
    }

    /// The account was disabled or deleted: close every socket it holds.
    pub fn account_closed(&self, account_id: i64) {
        self.close_sockets(CLOSE_REMOVED, |account, _| account == account_id);
    }

    /// One session ended: close the sockets it opened and leave the
    /// account's other devices alone.
    pub fn session_closed(&self, session_id: i64) {
        self.close_sockets(CLOSE_UNAUTHORIZED, |_, session| session == session_id);
    }

    /// Every session of an account ended, apart from `keep`.
    pub fn sessions_closed(&self, account_id: i64, keep: Option<i64>) {
        self.close_sockets(CLOSE_UNAUTHORIZED, |account, session| {
            account == account_id && Some(session) != keep
        });
    }

    /// Close the room and feed sockets whose account and session match.
    fn close_sockets(&self, code: u16, matches: impl Fn(i64, i64) -> bool) {
        let mut inner = self.lock();
        for room in inner.rooms.values_mut() {
            Self::evict(room, code, |peer| matches(peer.account_id, peer.session_id));
        }
        inner.rooms.retain(|_, room| !room.is_empty());
        for (account, feeds) in inner.feeds.iter_mut() {
            feeds.retain(|feed| {
                if !matches(*account, feed.session_id) {
                    return true;
                }
                feed.signal.closed.store(code, Ordering::SeqCst);
                feed.signal.notify.notify_one();
                false
            });
        }
        inner.feeds.retain(|_, feeds| !feeds.is_empty());
    }

    /// Close every socket, in every room and on every feed. For when the
    /// server has lost the means to tell which of them may stay.
    pub fn close_all(&self, code: u16) {
        self.close_sockets(code, |_, _| true);
    }

    /// Every session with a socket open, in a room or on the feed, for
    /// checking them against the database after events may have been missed.
    pub fn open_sessions(&self) -> Vec<i64> {
        let inner = self.lock();
        let in_rooms = inner
            .rooms
            .values()
            .flat_map(|room| room.values().map(|peer| peer.session_id));
        let on_feeds = inner.feeds.values().flatten().map(|feed| feed.session_id);
        let mut sessions: Vec<i64> = in_rooms.chain(on_feeds).collect();
        sessions.sort_unstable();
        sessions.dedup();
        sessions
    }

    /// The collection is gone: close its rooms.
    pub fn collection_closed(&self, collection_id: i64) {
        let mut inner = self.lock();
        inner.rooms.retain(|key, room| {
            if key.collection_id != collection_id {
                return true;
            }
            for peer in room.values() {
                peer.kick.fire(CLOSE_REMOVED);
            }
            false
        });
    }

    /// Every (collection, account) pair with a socket in a room, for checking
    /// them against the database after events may have been missed.
    pub fn room_memberships(&self) -> Vec<(i64, i64)> {
        let inner = self.lock();
        let mut pairs: Vec<(i64, i64)> = inner
            .rooms
            .iter()
            .flat_map(|(key, room)| {
                room.values()
                    .map(|peer| (key.collection_id, peer.account_id))
            })
            .collect();
        pairs.sort_unstable();
        pairs.dedup();
        pairs
    }

    /// Register a change feed, or refuse with a close code when the account
    /// or the session already holds as many as it may.
    pub fn subscribe_feed(
        &self,
        account_id: i64,
        session_id: i64,
    ) -> Result<(u32, Arc<FeedSignal>), u16> {
        let id = self.next_id();
        let signal = Arc::new(FeedSignal::default());
        let mut inner = self.lock();
        let feeds = inner.feeds.entry(account_id).or_default();
        let of_session = feeds
            .iter()
            .filter(|feed| feed.session_id == session_id)
            .count();
        if feeds.len() >= MAX_FEEDS_PER_ACCOUNT || of_session >= MAX_FEEDS_PER_SESSION {
            return Err(CLOSE_TOO_MANY);
        }
        feeds.push(Feed {
            id,
            session_id,
            signal: Arc::clone(&signal),
        });
        Ok((id, signal))
    }

    pub fn unsubscribe_feed(&self, account_id: i64, id: u32) {
        let mut inner = self.lock();
        if let Some(feeds) = inner.feeds.get_mut(&account_id) {
            feeds.retain(|feed| feed.id != id);
            if feeds.is_empty() {
                inner.feeds.remove(&account_id);
            }
        }
    }

    /// Tell the devices of these accounts there is news, apart from the
    /// session that made it.
    pub fn signal_feeds(&self, accounts: &[i64], except_session: Option<i64>, news: FeedNews) {
        let inner = self.lock();
        for account in accounts {
            for feed in inner.feeds.get(account).into_iter().flatten() {
                if Some(feed.session_id) == except_session {
                    continue;
                }
                let flag = match news {
                    FeedNews::Changed => &feed.signal.changed,
                    FeedNews::Invitations => &feed.signal.invitations,
                };
                flag.store(true, Ordering::SeqCst);
                feed.signal.notify.notify_one();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{ACCESS_ADMIN, ACCESS_READ_ONLY, ACCESS_READ_WRITE};

    const ROOM: RoomKey = RoomKey {
        collection_id: 1,
        item_id: 1,
    };

    fn join(hub: &Hub, account: i64, access: i16) -> Joined {
        hub.join(
            ROOM,
            account,
            account * 10,
            format!("user{account}"),
            access,
        )
        .unwrap()
    }

    /// Everything queued for a member so far, as (kind, rest of frame).
    fn drain(joined: &mut Joined) -> Vec<(u8, Vec<u8>)> {
        let mut frames = Vec::new();
        while let Ok(frame) = joined.frames.try_recv() {
            frames.push((frame[0], frame[1..].to_vec()));
        }
        frames
    }

    fn kinds(joined: &mut Joined) -> Vec<u8> {
        drain(joined).into_iter().map(|(kind, _)| kind).collect()
    }

    /// The protocol as it is written down for every side that speaks it.
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

    /// The next frame queued for a member, as its first byte and the rest
    /// read as JSON.
    fn next_control(joined: &mut Joined) -> (u8, serde_json::Value) {
        let frame = joined.frames.try_recv().expect("a frame is waiting");
        let body = serde_json::from_slice(&frame[1..]).expect("a control frame carries JSON");
        (frame[0], body)
    }

    /// The app's room socket and the fake server its tests use have their
    /// own code for this protocol, in another language. What keeps the
    /// three alike is the file they are each held to. This holds the hub
    /// to it: the numbers, and the frames it builds.
    #[test]
    fn hub_speaks_the_room_protocol_as_written_down() {
        let spec = protocol();
        for (name, value) in [
            ("hello", FRAME_HELLO),
            ("welcome", FRAME_WELCOME),
            ("joined", FRAME_JOINED),
            ("left", FRAME_LEFT),
            ("access", FRAME_ACCESS),
        ] {
            assert_eq!(spec["frames"][name], value, "frame {name}");
        }
        for (name, value) in [
            ("update", CLASS_UPDATE),
            ("sync", CLASS_SYNC),
            ("reply", CLASS_REPLY),
            ("presence", CLASS_PRESENCE),
        ] {
            assert_eq!(spec["classes"][name], value, "class {name}");
        }
        assert_eq!(spec["frames"].as_object().unwrap().len(), 5);
        assert_eq!(spec["classes"].as_object().unwrap().len(), 4);
        // A receiver tells a control frame from a relayed one by this.
        let lowest_class = spec["classes"]
            .as_object()
            .unwrap()
            .values()
            .map(|class| class.as_u64().unwrap())
            .min()
            .unwrap();
        for (name, frame) in spec["frames"].as_object().unwrap() {
            assert!(frame.as_u64().unwrap() < lowest_class, "frame {name}");
        }
        for (name, value) in [
            ("readOnly", ACCESS_READ_ONLY),
            ("admin", ACCESS_ADMIN),
            ("readWrite", ACCESS_READ_WRITE),
        ] {
            assert_eq!(spec["accessLevels"][name], value, "access {name}");
        }
        for (name, value) in [
            ("badFrame", CLOSE_BAD_FRAME),
            ("unauthorized", CLOSE_UNAUTHORIZED),
            ("removed", CLOSE_REMOVED),
            ("slow", CLOSE_SLOW),
            ("tooMany", CLOSE_TOO_MANY),
            ("unavailable", CLOSE_UNAVAILABLE),
        ] {
            assert_eq!(spec["closeCodes"][name], value, "close code {name}");
        }
        assert_eq!(spec["senderBytes"], std::mem::size_of::<u32>());

        // The frames. A hub of its own hands out the ids 1 and 2, which is
        // what the examples are written with.
        let examples = &spec["examples"];
        let hub = Hub::default();
        let mut ann = hub
            .join(ROOM, 1, 10, "ann".into(), ACCESS_ADMIN)
            .expect("ann joins");
        drain(&mut ann);
        let mut bob = hub
            .join(ROOM, 2, 20, "bob".into(), ACCESS_READ_ONLY)
            .expect("bob joins");
        assert_eq!(
            next_control(&mut bob),
            (FRAME_WELCOME, examples["welcome"]["body"].clone())
        );
        assert_eq!(
            next_control(&mut ann),
            (FRAME_JOINED, examples["joined"]["body"].clone())
        );

        let relayed = &examples["relayed"];
        assert_eq!(
            hub.relay(
                ROOM,
                ann.id,
                CLASS_UPDATE,
                &bytes_of(&relayed["payload"]),
                None
            ),
            Relay::Sent
        );
        assert_eq!(
            bob.frames.try_recv().expect("the update").to_vec(),
            bytes_of(&relayed["hex"])
        );

        hub.membership_changed(ROOM.collection_id, 2, Some(ACCESS_READ_WRITE));
        assert_eq!(
            next_control(&mut bob),
            (FRAME_ACCESS, examples["access"]["body"].clone())
        );

        hub.leave(ROOM, bob.id);
        assert_eq!(
            next_control(&mut ann),
            (FRAME_LEFT, examples["left"]["body"].clone())
        );
    }

    #[test]
    fn members_learn_who_is_there_and_who_comes_and_goes() {
        let hub = Hub::default();
        let mut first = join(&hub, 1, ACCESS_ADMIN);
        assert_eq!(kinds(&mut first), vec![FRAME_WELCOME]);

        let mut second = join(&hub, 2, ACCESS_READ_WRITE);
        assert_eq!(kinds(&mut second), vec![FRAME_WELCOME]);
        assert_eq!(kinds(&mut first), vec![FRAME_JOINED]);

        hub.leave(ROOM, second.id);
        assert_eq!(kinds(&mut first), vec![FRAME_LEFT]);
        hub.leave(ROOM, first.id);
        assert!(hub.room_memberships().is_empty());
    }

    #[test]
    fn frames_reach_everyone_else_and_name_the_sender() {
        let hub = Hub::default();
        let mut a = join(&hub, 1, ACCESS_ADMIN);
        let mut b = join(&hub, 2, ACCESS_READ_WRITE);
        let mut c = join(&hub, 3, ACCESS_READ_WRITE);
        drain(&mut a);
        drain(&mut b);
        drain(&mut c);

        assert_eq!(
            hub.relay(ROOM, a.id, CLASS_UPDATE, b"edit", None),
            Relay::Sent
        );
        let mut expected = a.id.to_be_bytes().to_vec();
        expected.extend_from_slice(b"edit");
        assert_eq!(drain(&mut b), vec![(CLASS_UPDATE, expected.clone())]);
        assert_eq!(drain(&mut c), vec![(CLASS_UPDATE, expected)]);
        assert!(
            drain(&mut a).is_empty(),
            "the sender got its own frame back"
        );

        // A reply goes to the one member it names.
        hub.relay(ROOM, b.id, CLASS_REPLY, b"state", Some(c.id));
        assert_eq!(kinds(&mut c), vec![CLASS_REPLY]);
        assert!(drain(&mut a).is_empty());
    }

    #[test]
    fn read_only_member_listens_but_cannot_change_the_document() {
        let hub = Hub::default();
        let mut writer = join(&hub, 1, ACCESS_ADMIN);
        let mut reader = join(&hub, 2, ACCESS_READ_ONLY);
        drain(&mut writer);
        drain(&mut reader);

        assert_eq!(
            hub.relay(ROOM, reader.id, CLASS_UPDATE, b"x", None),
            Relay::Denied
        );
        assert_eq!(
            hub.relay(ROOM, reader.id, CLASS_REPLY, b"x", Some(writer.id)),
            Relay::Denied
        );
        assert!(drain(&mut writer).is_empty());

        // It may ask for the state and show its cursor.
        assert_eq!(
            hub.relay(ROOM, reader.id, CLASS_SYNC, b"?", None),
            Relay::Sent
        );
        assert_eq!(
            hub.relay(ROOM, reader.id, CLASS_PRESENCE, b"p", None),
            Relay::Sent
        );
        assert_eq!(kinds(&mut writer), vec![CLASS_SYNC, CLASS_PRESENCE]);

        hub.relay(ROOM, writer.id, CLASS_UPDATE, b"edit", None);
        assert_eq!(kinds(&mut reader), vec![CLASS_UPDATE]);
    }

    #[test]
    fn downgrade_takes_effect_on_the_open_socket() {
        let hub = Hub::default();
        let mut owner = join(&hub, 1, ACCESS_ADMIN);
        let mut member = join(&hub, 2, ACCESS_READ_WRITE);
        drain(&mut owner);
        drain(&mut member);

        hub.membership_changed(ROOM.collection_id, 2, Some(ACCESS_READ_ONLY));
        assert_eq!(kinds(&mut member), vec![FRAME_ACCESS]);
        assert_eq!(
            hub.relay(ROOM, member.id, CLASS_UPDATE, b"x", None),
            Relay::Denied
        );
        // Another collection's change does not touch this room.
        hub.membership_changed(99, 1, None);
        assert_eq!(
            hub.relay(ROOM, owner.id, CLASS_UPDATE, b"x", None),
            Relay::Sent
        );
    }

    #[tokio::test]
    async fn removal_closes_the_socket_and_tells_the_room() {
        let hub = Hub::default();
        let mut owner = join(&hub, 1, ACCESS_ADMIN);
        let member = join(&hub, 2, ACCESS_READ_WRITE);
        drain(&mut owner);

        hub.membership_changed(ROOM.collection_id, 2, None);
        assert_eq!(member.kick.fired().await, CLOSE_REMOVED);
        assert_eq!(kinds(&mut owner), vec![FRAME_LEFT]);
        assert_eq!(
            hub.relay(ROOM, member.id, CLASS_UPDATE, b"late", None),
            Relay::Denied
        );
        assert_eq!(hub.room_memberships(), vec![(1, 1)]);
    }

    #[tokio::test]
    async fn member_that_cannot_keep_up_is_dropped() {
        let hub = Hub::default();
        let sender = join(&hub, 1, ACCESS_ADMIN);
        let stuck = join(&hub, 2, ACCESS_READ_WRITE);
        // Nobody reads `stuck.frames`, so its queue only grows.
        let big = vec![0u8; 1024 * 1024];
        for _ in 0..6 {
            hub.relay(ROOM, sender.id, CLASS_UPDATE, &big, None);
        }
        assert_eq!(stuck.kick.fired().await, CLOSE_SLOW);
        assert_eq!(hub.room_memberships(), vec![(1, 1)]);
    }

    #[test]
    fn large_frame_is_not_mistaken_for_a_slow_reader() {
        let hub = Hub::default();
        let sender = join(&hub, 1, ACCESS_ADMIN);
        let mut reader = join(&hub, 2, ACCESS_READ_WRITE);
        drain(&mut reader);
        // Larger than the whole backlog allowance, and the reader has
        // nothing waiting.
        let state = vec![0u8; 3 * MAX_QUEUED_BYTES];
        hub.relay(ROOM, sender.id, CLASS_REPLY, &state, Some(reader.id));
        let frames = drain(&mut reader);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].0, CLASS_REPLY);
        assert_eq!(hub.room_memberships(), vec![(1, 1), (1, 2)]);
    }

    #[test]
    fn feeds_are_limited_per_session_and_per_account() {
        let hub = Hub::default();
        for _ in 0..MAX_FEEDS_PER_SESSION {
            hub.subscribe_feed(1, 100).unwrap();
        }
        assert_eq!(hub.subscribe_feed(1, 100).err(), Some(CLOSE_TOO_MANY));
        // Another device of the account still gets in, and so does anyone
        // else.
        hub.subscribe_feed(1, 101).unwrap();
        hub.subscribe_feed(2, 200).unwrap();

        let per_session = MAX_FEEDS_PER_SESSION as i64;
        let hub = Hub::default();
        for feed in 0..MAX_FEEDS_PER_ACCOUNT as i64 {
            hub.subscribe_feed(1, 100 + feed / per_session).unwrap();
        }
        assert_eq!(hub.subscribe_feed(1, 999).err(), Some(CLOSE_TOO_MANY));
    }

    #[test]
    fn account_is_limited_in_how_many_sockets_it_holds() {
        let hub = Hub::default();
        let mut held = Vec::new();
        for _ in 0..MAX_ROOM_SOCKETS_PER_ACCOUNT {
            held.push(join(&hub, 1, ACCESS_ADMIN));
        }
        assert_eq!(
            hub.join(ROOM, 1, 10, "user1".into(), ACCESS_ADMIN).err(),
            Some(CLOSE_TOO_MANY)
        );
        // Someone else is not affected.
        join(&hub, 2, ACCESS_ADMIN);
    }

    #[tokio::test]
    async fn ending_a_session_closes_only_what_it_opened() {
        let hub = Hub::default();
        let laptop = hub.join(ROOM, 1, 100, "ann".into(), ACCESS_ADMIN).unwrap();
        let mut phone = hub.join(ROOM, 1, 101, "ann".into(), ACCESS_ADMIN).unwrap();
        let (_, laptop_feed) = hub.subscribe_feed(1, 100).unwrap();
        let (_, phone_feed) = hub.subscribe_feed(1, 101).unwrap();
        drain(&mut phone);

        hub.session_closed(100);
        assert_eq!(laptop.kick.fired().await, CLOSE_UNAUTHORIZED);
        assert_eq!(laptop_feed.close_code(), Some(CLOSE_UNAUTHORIZED));
        assert_eq!(phone_feed.close_code(), None);
        assert_eq!(kinds(&mut phone), vec![FRAME_LEFT]);
        assert_eq!(
            hub.relay(ROOM, phone.id, CLASS_UPDATE, b"x", None),
            Relay::Sent
        );
    }

    #[tokio::test]
    async fn ending_the_other_sessions_spares_the_one_that_asked() {
        let hub = Hub::default();
        let kept = hub.join(ROOM, 1, 100, "ann".into(), ACCESS_ADMIN).unwrap();
        let ended = hub.join(ROOM, 1, 101, "ann".into(), ACCESS_ADMIN).unwrap();
        let mut stranger = hub
            .join(ROOM, 2, 200, "bob".into(), ACCESS_READ_WRITE)
            .unwrap();
        let (_, kept_feed) = hub.subscribe_feed(1, 100).unwrap();
        let (_, ended_feed) = hub.subscribe_feed(1, 101).unwrap();
        let (_, stranger_feed) = hub.subscribe_feed(2, 200).unwrap();
        drain(&mut stranger);

        hub.sessions_closed(1, Some(100));
        assert_eq!(ended.kick.fired().await, CLOSE_UNAUTHORIZED);
        assert_eq!(ended_feed.close_code(), Some(CLOSE_UNAUTHORIZED));
        assert_eq!(kept_feed.close_code(), None);
        assert_eq!(stranger_feed.close_code(), None);
        assert_eq!(kinds(&mut stranger), vec![FRAME_LEFT]);
        assert_eq!(hub.room_memberships(), vec![(1, 1), (1, 2)]);

        // With nothing to keep, the account's last socket goes too.
        hub.sessions_closed(1, None);
        assert_eq!(kept.kick.fired().await, CLOSE_UNAUTHORIZED);
        assert_eq!(kept_feed.close_code(), Some(CLOSE_UNAUTHORIZED));
        assert_eq!(hub.room_memberships(), vec![(1, 2)]);
    }

    #[test]
    fn feed_skips_the_session_that_made_the_change() {
        let hub = Hub::default();
        let (_, writer) = hub.subscribe_feed(1, 10).unwrap();
        let (other_id, other) = hub.subscribe_feed(1, 11).unwrap();
        let (_, stranger) = hub.subscribe_feed(2, 20).unwrap();

        hub.signal_feeds(&[1], Some(10), FeedNews::Changed);
        assert!(!writer.changed.load(Ordering::SeqCst));
        assert!(other.changed.load(Ordering::SeqCst));
        assert!(!stranger.changed.load(Ordering::SeqCst));

        hub.signal_feeds(&[2], None, FeedNews::Invitations);
        assert!(stranger.invitations.load(Ordering::SeqCst));
        assert!(!stranger.changed.load(Ordering::SeqCst));

        hub.unsubscribe_feed(1, other_id);
        other.changed.store(false, Ordering::SeqCst);
        hub.signal_feeds(&[1], None, FeedNews::Changed);
        assert!(!other.changed.load(Ordering::SeqCst));
        assert!(writer.changed.load(Ordering::SeqCst));
    }
}
