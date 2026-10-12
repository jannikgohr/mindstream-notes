//! The change feed: a socket on which the server says "sync now".
//!
//! Without it a device learns of a change made elsewhere at its next
//! scheduled sync. With it the server says so at once, and this module turns
//! that into the sync the scheduler would have run anyway, only sooner. The
//! feed carries no data, so a missed message costs time and never
//! correctness, and the schedule stays as the fallback.
//!
//! The socket is opened here, on the Rust side, because it is opened with
//! the session token. The WebView never sees it.

use std::time::Duration;

use etebase::FeedEndpoint;
use futures_util::StreamExt;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::{Error as SocketError, Message};

use crate::auth;

use super::catch_blocking_panic;
use super::scheduler::SyncScheduler;

/// How often to look again while there is nothing to listen for: signed
/// out, or scheduled sync turned off.
const IDLE_POLL: Duration = Duration::from_secs(5);
const RETRY_INITIAL: Duration = Duration::from_secs(2);
/// A server without a feed, or one that is down, is asked again this often
/// at most.
const RETRY_MAX: Duration = Duration::from_secs(300);
/// The server pings every 30 seconds. Silence for this long means the
/// connection is dead, whatever the socket says.
const SILENCE_LIMIT: Duration = Duration::from_secs(90);
/// The newest feed protocol this client understands.
const FEED_PROTOCOL: u32 = 1;
/// The code the server closes a socket with when its session has ended.
const CLOSE_SESSION_ENDED: u16 = 4401;

/// What the server says on the feed. Its first message carries only the
/// protocol level, every later one only the two flags.
#[derive(Deserialize, Debug, Default, PartialEq, Eq)]
pub(super) struct FeedMessage {
    #[serde(default)]
    pub(super) protocol: Option<u32>,
    /// A collection the account belongs to changed, or it gained or lost one.
    #[serde(default)]
    pub(super) changed: bool,
    /// An invitation to or from the account appeared or went away.
    #[serde(default)]
    pub(super) invitations: bool,
}

impl FeedMessage {
    pub(super) fn decode(bytes: &[u8]) -> Option<Self> {
        rmp_serde::from_slice(bytes).ok()
    }

    /// Either kind of news is fetched by a sync.
    pub(super) fn worth_a_sync(&self) -> bool {
        self.changed || self.invitations
    }
}

/// How long to wait before connecting again after `failures` attempts in a
/// row that never got as far as listening.
pub(super) fn retry_delay(failures: u32) -> Duration {
    RETRY_INITIAL
        .saturating_mul(2u32.saturating_pow(failures.min(16)))
        .min(RETRY_MAX)
}

/// Listen for as long as the app runs. Called once during `setup`.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut failures = 0u32;
        loop {
            let listening_makes_sense =
                app.state::<SyncScheduler>().is_enabled() && auth::has_session(&app);
            if !listening_makes_sense {
                failures = 0;
                tokio::time::sleep(IDLE_POLL).await;
                continue;
            }
            match listen(&app).await {
                // It was connected, and now is not. Try again soon.
                Ok(()) => failures = 0,
                Err(err) => {
                    // Usually the server being unreachable, which the sync
                    // itself reports to the user. Not worth more than this.
                    log::debug!("[feed] not connected: {err}");
                    failures = failures.saturating_add(1);
                }
            }
            tokio::time::sleep(retry_delay(failures)).await;
        }
    });
}

async fn endpoint(app: &AppHandle) -> Result<Option<FeedEndpoint>, String> {
    let app = app.clone();
    // Restoring the session reads the keyring and constructs the etebase
    // client, both blocking.
    tauri::async_runtime::spawn_blocking(move || {
        catch_blocking_panic("feed", || {
            let Some(account) =
                auth::try_restore(&app).map_err(|e| format!("restore session: {e}"))?
            else {
                return Ok(None);
            };
            account
                .mindstream()
                .feed_endpoint()
                .map(Some)
                .map_err(|e| format!("feed endpoint: {e}"))
        })
    })
    .await
    .map_err(|e| format!("feed task: {e}"))?
}

/// Connect and pass on what the server says until the connection ends.
/// `Err` means it never got as far as listening.
async fn listen(app: &AppHandle) -> Result<(), String> {
    let Some(endpoint) = endpoint(app).await? else {
        return Ok(());
    };
    let mut request = endpoint
        .url()
        .into_client_request()
        .map_err(|e| format!("feed address: {e}"))?;
    request.headers_mut().insert(
        AUTHORIZATION,
        endpoint
            .authorization()
            .parse()
            .map_err(|_| "session token is not a valid header".to_string())?,
    );
    let scheduler = app.state::<SyncScheduler>();
    let mut socket = match tokio_tungstenite::connect_async(request).await {
        Ok((socket, _)) => socket,
        Err(SocketError::Http(response)) if response.status() == StatusCode::UNAUTHORIZED => {
            // The server no longer knows this session. A sync finds out
            // the same and signs the device out, which is not this
            // module's call to make.
            scheduler.request_sync();
            return Err("the server refused the session".to_string());
        }
        Err(e) => return Err(format!("connect: {e}")),
    };
    log::info!("[feed] listening");

    // Whatever changed while nobody was listening.
    scheduler.request_sync();

    loop {
        let message = match tokio::time::timeout(SILENCE_LIMIT, socket.next()).await {
            Err(_) => {
                log::info!("[feed] the server went quiet; connecting again");
                return Ok(());
            }
            Ok(None) | Ok(Some(Err(_))) => return Ok(()),
            Ok(Some(Ok(message))) => message,
        };
        match message {
            Message::Binary(bytes) => {
                let Some(news) = FeedMessage::decode(&bytes) else {
                    continue;
                };
                if news.protocol.is_some_and(|level| level > FEED_PROTOCOL) {
                    log::warn!(
                        "[feed] the server speaks a newer feed protocol than this app knows"
                    );
                }
                if news.invitations {
                    // Nothing to sync for an invitation that waits. The
                    // notifications list them again.
                    let event = crate::app_events::AppEvent::InvitationsChanged.as_str();
                    if let Err(err) = app.emit(event, ()) {
                        log::warn!("[feed] failed to emit {event}: {err}");
                    }
                }
                if news.worth_a_sync() {
                    log::debug!(
                        "[feed] news (changed={}, invitations={}); syncing now",
                        news.changed,
                        news.invitations
                    );
                    scheduler.request_sync();
                }
            }
            Message::Close(frame) => {
                if frame.is_some_and(|frame| u16::from(frame.code) == CLOSE_SESSION_ENDED) {
                    // Signed out from another device, most likely. Let a
                    // sync confirm it and sign this device out.
                    scheduler.request_sync();
                }
                return Ok(());
            }
            // Pings are answered by the library. They are also what brings
            // the loop round to the check below at least every half minute.
            _ => {}
        }
        // Signed out, or sync turned off, while connected.
        if !scheduler.is_enabled() || !auth::has_session(app) {
            return Ok(());
        }
    }
}
