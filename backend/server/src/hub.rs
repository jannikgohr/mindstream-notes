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

/// A member whose socket has this much waiting to be written is not keeping
/// up. Frames are ciphertext, so nothing can be merged or dropped for them;
/// the socket is closed and the client reconnects and resyncs.
const MAX_QUEUED_BYTES: usize = 4 * 1024 * 1024;
/// Sockets one account may hold across all rooms.
const MAX_ROOM_SOCKETS_PER_ACCOUNT: usize = 64;

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
    fn push(&self, frame: &Bytes) -> bool {
        let queued = self.queued.fetch_add(frame.len(), Ordering::Relaxed) + frame.len();
        queued <= MAX_QUEUED_BYTES && self.frames.send(frame.clone()).is_ok()
    }
}

/// What a device waiting on the change feed has been told since it last
/// looked. Flags, not a queue: "something changed" does not get truer by
/// being said twice.
#[derive(Default)]
pub struct FeedSignal {
    pub changed: AtomicBool,
    pub invitations: AtomicBool,
    pub closed: AtomicBool,
    pub notify: Notify,
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

fn control<T: Serialize>(kind: u8, body: &T) -> Bytes {
    let mut frame = vec![kind];
    frame.extend(rmp_serde::to_vec_named(body).expect("control frames serialise"));
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
                feed.signal.closed.store(true, Ordering::SeqCst);
                feed.signal.notify.notify_one();
                false
            });
        }
        inner.feeds.retain(|_, feeds| !feeds.is_empty());
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

    pub fn subscribe_feed(&self, account_id: i64, session_id: i64) -> (u32, Arc<FeedSignal>) {
        let id = self.next_id();
        let signal = Arc::new(FeedSignal::default());
        self.lock().feeds.entry(account_id).or_default().push(Feed {
            id,
            session_id,
            signal: Arc::clone(&signal),
        });
        (id, signal)
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
    use crate::wire::{ACCESS_ADMIN, ACCESS_READ_WRITE};

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
        for _ in 0..5 {
            hub.relay(ROOM, sender.id, CLASS_UPDATE, &big, None);
        }
        assert_eq!(stuck.kick.fired().await, CLOSE_SLOW);
        assert_eq!(hub.room_memberships(), vec![(1, 1)]);
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
        let (_, laptop_feed) = hub.subscribe_feed(1, 100);
        let (_, phone_feed) = hub.subscribe_feed(1, 101);
        drain(&mut phone);

        hub.session_closed(100);
        assert_eq!(laptop.kick.fired().await, CLOSE_UNAUTHORIZED);
        assert!(laptop_feed.closed.load(Ordering::SeqCst));
        assert!(!phone_feed.closed.load(Ordering::SeqCst));
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
        let (_, kept_feed) = hub.subscribe_feed(1, 100);
        let (_, ended_feed) = hub.subscribe_feed(1, 101);
        let (_, stranger_feed) = hub.subscribe_feed(2, 200);
        drain(&mut stranger);

        hub.sessions_closed(1, Some(100));
        assert_eq!(ended.kick.fired().await, CLOSE_UNAUTHORIZED);
        assert!(ended_feed.closed.load(Ordering::SeqCst));
        assert!(!kept_feed.closed.load(Ordering::SeqCst));
        assert!(!stranger_feed.closed.load(Ordering::SeqCst));
        assert_eq!(kinds(&mut stranger), vec![FRAME_LEFT]);
        assert_eq!(hub.room_memberships(), vec![(1, 1), (1, 2)]);

        // With nothing to keep, the account's last socket goes too.
        hub.sessions_closed(1, None);
        assert_eq!(kept.kick.fired().await, CLOSE_UNAUTHORIZED);
        assert!(kept_feed.closed.load(Ordering::SeqCst));
        assert_eq!(hub.room_memberships(), vec![(1, 2)]);
    }

    #[test]
    fn feed_skips_the_session_that_made_the_change() {
        let hub = Hub::default();
        let (_, writer) = hub.subscribe_feed(1, 10);
        let (other_id, other) = hub.subscribe_feed(1, 11);
        let (_, stranger) = hub.subscribe_feed(2, 20);

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
