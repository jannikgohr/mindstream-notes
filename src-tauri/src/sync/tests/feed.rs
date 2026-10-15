//! What the change feed listener makes of the server's messages.

use std::time::Duration;

use serde::Serialize;

use super::super::feed::{retry_delay, FeedMessage};

#[derive(Serialize)]
struct Hello {
    protocol: u32,
}

#[derive(Serialize)]
struct News {
    changed: bool,
    invitations: bool,
}

fn encoded<T: Serialize>(message: &T) -> Vec<u8> {
    // Named fields, as the server sends them.
    rmp_serde::to_vec_named(message).unwrap()
}

#[test]
fn greeting_is_not_news() {
    let hello = FeedMessage::decode(&encoded(&Hello { protocol: 1 })).unwrap();
    assert_eq!(hello.protocol, Some(1));
    assert!(!hello.worth_a_sync());
}

#[test]
fn either_kind_of_news_is_worth_a_sync() {
    let news = |changed, invitations| {
        FeedMessage::decode(&encoded(&News {
            changed,
            invitations,
        }))
        .unwrap()
    };
    assert!(news(true, false).worth_a_sync());
    assert!(news(false, true).worth_a_sync());
    assert!(news(true, true).worth_a_sync());
    // The server does not send this, but it would mean nothing to do.
    assert!(!news(false, false).worth_a_sync());
    assert_eq!(news(true, false).protocol, None);
}

/// A later server may say more. What this app does not know it ignores.
#[test]
fn unknown_fields_are_ignored_and_garbage_is_dropped() {
    #[derive(Serialize)]
    struct Newer {
        changed: bool,
        invitations: bool,
        collections: Vec<String>,
    }
    let newer = FeedMessage::decode(&encoded(&Newer {
        changed: true,
        invitations: false,
        collections: vec!["abc".into()],
    }))
    .unwrap();
    assert!(newer.worth_a_sync());

    assert_eq!(FeedMessage::decode(b"not msgpack at all"), None);
    assert_eq!(FeedMessage::decode(&[]), None);
}

#[test]
fn reconnecting_backs_off_and_stops_growing() {
    // After a connection that worked, try again soon.
    assert_eq!(retry_delay(0), Duration::from_secs(2));
    assert_eq!(retry_delay(1), Duration::from_secs(4));
    assert_eq!(retry_delay(3), Duration::from_secs(16));
    // A server without a feed is asked every five minutes, not for ever
    // less often and not in a tight loop.
    assert_eq!(retry_delay(8), Duration::from_secs(300));
    assert_eq!(retry_delay(u32::MAX), Duration::from_secs(300));
    let delays: Vec<Duration> = (0..12).map(retry_delay).collect();
    assert!(delays.windows(2).all(|pair| pair[0] <= pair[1]));
}
