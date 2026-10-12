//! The change feed: one socket per device on which the server says "sync
//! now".
//!
//! It carries no data. A device that hears there is news runs the same sync
//! it would have run on its next timer tick, only sooner. Missing a message
//! therefore costs time and never correctness, and the timer stays as the
//! fallback.

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use serde::Serialize;

use crate::auth::{self, AuthUser};
use crate::hub::{CLOSE_UNAUTHORIZED, CLOSE_UNAVAILABLE};
use crate::{AppState, PROTOCOL_LEVEL};

const PING_INTERVAL: Duration = Duration::from_secs(30);
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
/// A burst of changes, such as a bulk push arriving page by page, is told as
/// one piece of news.
const SETTLE: Duration = Duration::from_millis(150);

#[derive(Serialize)]
struct Hello {
    protocol: u32,
}

#[derive(Serialize)]
struct News {
    /// A collection the account belongs to changed, or it gained or lost one.
    changed: bool,
    /// An invitation to or from the account appeared or went away.
    invitations: bool,
}

fn binary<T: Serialize>(body: &T) -> Message {
    Message::Binary(
        rmp_serde::to_vec_named(body)
            .expect("feed messages serialise")
            .into(),
    )
}

/// The device authenticates with its session token in the usual header. It
/// is the app's backend that opens this socket, not the WebView, so it can.
pub async fn feed_socket(
    State(state): State<AppState>,
    user: AuthUser,
    upgrade: WebSocketUpgrade,
) -> Response {
    upgrade.on_upgrade(move |socket| serve(state, user, socket))
}

async fn serve(state: AppState, user: AuthUser, mut socket: WebSocket) {
    let (id, signal) = state.hub.subscribe_feed(user.account_id, user.session_id);
    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.tick().await;
    let mut last_heard = Instant::now();

    let close_with = 'serving: {
        // The session was good when the request came in. If it ended before
        // the line above put this socket where events can find it, nothing
        // would ever close it. Ask again now that they can.
        match auth::standing_sessions(&state.pool, &[user.session_id]).await {
            Ok(standing) if standing.contains(&user.session_id) => {}
            Ok(_) => break 'serving Some(CLOSE_UNAUTHORIZED),
            Err(err) => {
                tracing::error!("could not check a feed's session: {err}");
                break 'serving Some(CLOSE_UNAVAILABLE);
            }
        }
        let hello = Hello {
            protocol: PROTOCOL_LEVEL,
        };
        if socket.send(binary(&hello)).await.is_err() {
            break 'serving None;
        }
        loop {
            tokio::select! {
                _ = signal.notify.notified() => {
                    if let Some(code) = signal.close_code() {
                        break 'serving Some(code);
                    }
                    tokio::time::sleep(SETTLE).await;
                    let news = News {
                        changed: signal.changed.swap(false, Ordering::SeqCst),
                        invitations: signal.invitations.swap(false, Ordering::SeqCst),
                    };
                    if (news.changed || news.invitations)
                        && socket.send(binary(&news)).await.is_err()
                    {
                        break 'serving None;
                    }
                }
                incoming = socket.recv() => match incoming {
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break 'serving None,
                    Some(Ok(_)) => last_heard = Instant::now(),
                },
                _ = ping.tick() => {
                    if last_heard.elapsed() > IDLE_TIMEOUT
                        || socket.send(Message::Ping(Default::default())).await.is_err()
                    {
                        break 'serving None;
                    }
                }
            }
        }
    };

    state.hub.unsubscribe_feed(user.account_id, id);
    if let Some(code) = close_with {
        let reason = if code == CLOSE_UNAUTHORIZED {
            "not signed in"
        } else {
            "try again later"
        };
        let frame = CloseFrame {
            code,
            reason: reason.into(),
        };
        let _ = socket.send(Message::Close(Some(frame))).await;
    }
}
