//! Changes that open sockets have to hear about.
//!
//! A handler publishes an event inside the transaction that makes the change.
//! Postgres delivers it when, and only if, that transaction commits, to every
//! process listening. So an event never announces something that was rolled
//! back, a second server process hears what the first one did, and so does
//! the server when the change came from the admin command line.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sqlx::postgres::PgListener;
use sqlx::PgConnection;

use crate::auth;
use crate::hub::{FeedNews, CLOSE_UNAVAILABLE};
use crate::AppState;

const CHANNEL: &str = "mindstream_events";
/// How long sockets may stay open while nothing can check that they still
/// should be. An event that ends a session or a membership is what closes a
/// socket, and for as long as events cannot be heard or the database cannot
/// be asked, a socket's right to be open is only as good as it was when
/// last checked.
const UNCHECKED_GRACE: Duration = Duration::from_secs(60);
/// How often every socket is checked against the database whether or not an
/// event said to. Nothing is known to need it. It bounds what a lost event
/// can cost to minutes.
const RECHECK_EVERY: Duration = Duration::from_secs(300);
const RETRY: Duration = Duration::from_secs(2);

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    /// Items or members of a collection changed. `session` made the change
    /// and has no need to be told.
    Changed {
        collection: i64,
        session: Option<i64>,
    },
    /// An account's access to a collection changed, or ended when `access`
    /// is absent.
    Membership {
        collection: i64,
        account: i64,
        access: Option<i16>,
    },
    /// An invitation to or from the account appeared or went away.
    Invitation { account: i64 },
    /// The account was disabled or deleted.
    AccountClosed { account: i64 },
    /// One session ended: a logout, or a device signed out from another.
    SessionClosed { session: i64 },
    /// Every session of the account ended, apart from `keep`.
    SessionsClosed { account: i64, keep: Option<i64> },
    /// The collection was deleted.
    CollectionClosed { collection: i64 },
}

/// Queue an event for delivery when the surrounding transaction commits.
pub async fn publish(conn: &mut PgConnection, event: &Event) -> Result<(), sqlx::Error> {
    let payload = serde_json::to_string(event).expect("events serialise");
    sqlx::query("SELECT pg_notify($1, $2)")
        .bind(CHANNEL)
        .bind(payload)
        .execute(conn)
        .await?;
    Ok(())
}

/// Announce that an account is going away: its own sockets close, and so do
/// the rooms of every collection it owns, for the other members too. Call
/// before the rows are deleted, while the memberships can still be read.
pub async fn publish_account_closing(
    conn: &mut PgConnection,
    account_id: i64,
) -> Result<(), sqlx::Error> {
    let owned: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT m.collection_id, m.account_id FROM members m
         JOIN collections c ON c.id = m.collection_id
         WHERE c.owner_id = $1 AND m.account_id <> $1",
    )
    .bind(account_id)
    .fetch_all(&mut *conn)
    .await?;
    for (collection, account) in owned {
        let lost = Event::Membership {
            collection,
            account,
            access: None,
        };
        publish(conn, &lost).await?;
    }
    let collections: Vec<i64> =
        sqlx::query_scalar("SELECT id FROM collections WHERE owner_id = $1")
            .bind(account_id)
            .fetch_all(&mut *conn)
            .await?;
    for collection in collections {
        publish(conn, &Event::CollectionClosed { collection }).await?;
    }
    publish(
        conn,
        &Event::AccountClosed {
            account: account_id,
        },
    )
    .await
}

async fn apply(state: &AppState, event: Event) -> Result<(), sqlx::Error> {
    match event {
        Event::Changed {
            collection,
            session,
        } => {
            let members: Vec<i64> =
                sqlx::query_scalar("SELECT account_id FROM members WHERE collection_id = $1")
                    .bind(collection)
                    .fetch_all(&state.pool)
                    .await?;
            state.hub.signal_feeds(&members, session, FeedNews::Changed);
        }
        Event::Membership {
            collection,
            account,
            access,
        } => {
            state.hub.membership_changed(collection, account, access);
            // Gaining or losing a collection is a change to sync, too.
            state.hub.signal_feeds(&[account], None, FeedNews::Changed);
        }
        Event::Invitation { account } => {
            state
                .hub
                .signal_feeds(&[account], None, FeedNews::Invitations);
        }
        Event::AccountClosed { account } => state.hub.account_closed(account),
        Event::SessionClosed { session } => state.hub.session_closed(session),
        Event::SessionsClosed { account, keep } => state.hub.sessions_closed(account, keep),
        Event::CollectionClosed { collection } => state.hub.collection_closed(collection),
    }
    Ok(())
}

/// Events may have been missed while the connection was down. The ones
/// that matter are the ones that take something away: check every socket
/// against the database, and close those whose session has ended, whose
/// account is disabled, or whose member no longer belongs in the room.
pub(crate) async fn revalidate(state: &AppState) -> Result<(), sqlx::Error> {
    let open = state.hub.open_sessions();
    if !open.is_empty() {
        let standing = auth::standing_sessions(&state.pool, &open).await?;
        for session in open {
            if !standing.contains(&session) {
                state.hub.session_closed(session);
            }
        }
    }
    for (collection, account) in state.hub.room_memberships() {
        let access: Option<i16> = sqlx::query_scalar(
            "SELECT m.access_level FROM members m
             JOIN accounts a ON a.id = m.account_id AND NOT a.disabled
             WHERE m.collection_id = $1 AND m.account_id = $2",
        )
        .bind(collection)
        .bind(account)
        .fetch_optional(&state.pool)
        .await?;
        state.hub.membership_changed(collection, account, access);
    }
    Ok(())
}

/// Keeps track of whether the open sockets can still be vouched for.
#[derive(Default)]
struct Watch {
    /// Since when the sockets have gone unchecked with events possibly lost.
    unchecked_since: Option<Instant>,
}

impl Watch {
    /// Whether sockets have gone unchecked for longer than they may.
    fn overdue(&self, now: Instant) -> bool {
        self.unchecked_since
            .is_some_and(|since| now.duration_since(since) >= UNCHECKED_GRACE)
    }

    /// Events may have been lost and the sockets could not be checked. Past
    /// the grace period every socket is closed: a client reconnects and is
    /// let in again on what the database says by then, while a socket left
    /// open would keep an authority nobody can confirm.
    fn failed(&mut self, state: &AppState) {
        let now = Instant::now();
        self.unchecked_since.get_or_insert(now);
        if self.overdue(now) {
            tracing::warn!("sockets have gone unchecked for too long; closing them all");
            state.hub.close_all(CLOSE_UNAVAILABLE);
        }
    }

    /// Check every socket against the database after events may have been
    /// lost.
    async fn recheck(&mut self, state: &AppState) {
        match revalidate(state).await {
            Ok(()) => self.unchecked_since = None,
            Err(err) => {
                tracing::warn!("could not recheck the open sockets: {err}");
                self.failed(state);
            }
        }
    }
}

/// Listen for events for as long as the process runs.
pub fn listen(state: AppState) {
    let periodic = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(RECHECK_EVERY);
        tick.tick().await;
        loop {
            tick.tick().await;
            if let Err(err) = revalidate(&periodic).await {
                tracing::warn!("could not recheck the open sockets: {err}");
            }
        }
    });

    tokio::spawn(async move {
        let mut watch = Watch::default();
        loop {
            let mut listener = match PgListener::connect_with(&state.pool).await {
                Ok(listener) => listener,
                Err(err) => {
                    tracing::warn!("cannot listen for events yet: {err}");
                    // No events until this works, so ask the database instead.
                    watch.recheck(&state).await;
                    tokio::time::sleep(RETRY).await;
                    continue;
                }
            };
            if let Err(err) = listener.listen(CHANNEL).await {
                tracing::warn!("cannot subscribe to events: {err}");
                watch.recheck(&state).await;
                tokio::time::sleep(RETRY).await;
                continue;
            }
            // Anything published before this point was not heard.
            watch.recheck(&state).await;
            loop {
                match listener.try_recv().await {
                    Ok(Some(notification)) => {
                        match serde_json::from_str::<Event>(notification.payload()) {
                            Ok(event) => {
                                if let Err(err) = apply(&state, event).await {
                                    tracing::warn!("could not act on an event: {err}");
                                }
                            }
                            Err(err) => tracing::warn!("unreadable event: {err}"),
                        }
                    }
                    // The connection dropped and is re-established on the
                    // next call. Whatever was published in between is gone.
                    Ok(None) => watch.recheck(&state).await,
                    Err(err) => {
                        tracing::warn!("event listener failed: {err}");
                        watch.recheck(&state).await;
                        tokio::time::sleep(RETRY).await;
                        break;
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sockets_are_only_given_up_on_after_the_grace_period() {
        let start = Instant::now();
        let mut watch = Watch::default();
        // Checked a moment ago: nothing to act on, however late it is.
        assert!(!watch.overdue(start + UNCHECKED_GRACE * 10));

        watch.unchecked_since = Some(start);
        assert!(!watch.overdue(start));
        assert!(!watch.overdue(start + UNCHECKED_GRACE - Duration::from_secs(1)));
        assert!(watch.overdue(start + UNCHECKED_GRACE));
    }

    #[test]
    fn events_survive_the_trip_through_a_notification() {
        let events = [
            Event::Changed {
                collection: 4,
                session: Some(9),
            },
            Event::Changed {
                collection: 4,
                session: None,
            },
            Event::Membership {
                collection: 4,
                account: 2,
                access: None,
            },
            Event::Membership {
                collection: 4,
                account: 2,
                access: Some(0),
            },
            Event::Invitation { account: 2 },
            Event::AccountClosed { account: 2 },
            Event::SessionClosed { session: 7 },
            Event::SessionsClosed {
                account: 2,
                keep: Some(7),
            },
            Event::SessionsClosed {
                account: 2,
                keep: None,
            },
            Event::CollectionClosed { collection: 4 },
        ];
        for event in events {
            let payload = serde_json::to_string(&event).unwrap();
            assert!(payload.len() < 200, "{payload}");
            assert_eq!(serde_json::from_str::<Event>(&payload).unwrap(), event);
        }
    }
}
