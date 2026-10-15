//! Live rooms: the sockets members of a collection use to edit one item
//! together.
//!
//! A room is a collection and an item. Getting in takes a ticket, which only
//! a member can obtain and which is good for seconds. The socket itself
//! never carries a session token, so the token stays out of the WebView and
//! out of URLs.
//!
//! The server relays ciphertext it cannot read. What it adds is the part the
//! old relays could not do: it knows who each socket is, tells the room, and
//! drops document changes from members who may only read.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::response::Response;
use serde::Serialize;

use crate::auth::AuthUser;
use crate::collections::membership;
use crate::edge::SocketPermit;
use crate::error::{ApiError, ApiResult};
use crate::hub::{
    Joined, RoomKey, CLASS_PRESENCE, CLASS_REPLY, CLASS_SYNC, CLASS_UPDATE, CLOSE_BAD_FRAME,
    CLOSE_REMOVED, CLOSE_UNAUTHORIZED, CLOSE_UNAVAILABLE, FRAME_HELLO,
};
use crate::keys::{Keys, RoomTicket};
use crate::wire::{check_uid, Msgpack};
use crate::AppState;

/// Largest frame a member may send. A document's whole state travels in one
/// frame when someone joins.
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const PING_INTERVAL: Duration = Duration::from_secs(30);
/// A socket that has said nothing for this long, not even a pong, is gone.
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
/// Requests for the document's state make every writer in the room answer
/// with all of it, so a member gets only a few of them.
const SYNC_REQUESTS: u32 = 10;
const SYNC_WINDOW: Duration = Duration::from_secs(10);

/// Joins that keep an item `i` only while neither it nor its collection is
/// marked deleted. Such an item has no room: deleting a shared collection is
/// how its owner stops sharing it, and an open room would carry on what the
/// deletion ended.
const NOT_DELETED: &str = "JOIN revisions cur
         ON cur.item_id = i.id AND cur.uid = i.revision_uid AND NOT cur.deleted
     JOIN items main ON main.collection_id = i.collection_id AND main.is_main
     JOIN revisions main_cur
         ON main_cur.item_id = main.id AND main_cur.uid = main.revision_uid
        AND NOT main_cur.deleted";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketResponse {
    ticket: String,
    expires_in: u64,
    access_level: i16,
}

/// Issue a ticket for the room of one item. Asking is how a client finds
/// out whether it may enter at all.
pub async fn room_ticket(
    State(state): State<AppState>,
    user: AuthUser,
    Path((collection_uid, item_uid)): Path<(String, String)>,
) -> ApiResult<Msgpack<TicketResponse>> {
    check_uid(&item_uid)?;
    let mut conn = state.pool.acquire().await?;
    let collection = membership(&mut conn, user.account_id, &collection_uid, false).await?;
    let item_id: Option<i64> = sqlx::query_scalar(&format!(
        "SELECT i.id FROM items i {NOT_DELETED} WHERE i.collection_id = $1 AND i.uid = $2"
    ))
    .bind(collection.id)
    .bind(&item_uid)
    .fetch_optional(&mut *conn)
    .await?;
    let item_id = item_id.ok_or_else(|| ApiError::not_found("Item"))?;
    Ok(Msgpack(TicketResponse {
        ticket: state.keys.room_ticket(RoomTicket {
            account_id: user.account_id,
            session_id: user.session_id,
            collection_id: collection.id,
            item_id,
        }),
        expires_in: Keys::ROOM_TICKET_TTL_SECS,
        access_level: collection.access_level,
    }))
}

/// A room socket is let in on a ticket it presents once it is open, so
/// until then it is anybody's. The permit is what keeps one address from
/// holding more of them than it may, and it is held until the socket closes.
pub async fn room_socket(
    State(state): State<AppState>,
    permit: SocketPermit,
    upgrade: WebSocketUpgrade,
) -> Response {
    upgrade
        .max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| async move {
            serve(state, socket).await;
            drop(permit);
        })
}

fn close_reason(code: u16) -> &'static str {
    match code {
        crate::hub::CLOSE_BAD_FRAME => "malformed frame",
        crate::hub::CLOSE_UNAUTHORIZED => "not signed in",
        crate::hub::CLOSE_REMOVED => "no longer a member",
        crate::hub::CLOSE_SLOW => "not keeping up",
        crate::hub::CLOSE_TOO_MANY => "too many sockets",
        CLOSE_UNAVAILABLE => "try again later",
        _ => "",
    }
}

async fn close(socket: &mut WebSocket, code: u16) {
    let frame = CloseFrame {
        code,
        reason: close_reason(code).into(),
    };
    let _ = socket.send(Message::Close(Some(frame))).await;
}

/// Whether a ticket's holder may be in its room, from the database as it is
/// now, and with what access and under what name.
///
/// A ticket says what was true when it was issued. The member may have been
/// removed, downgraded or disabled since, or signed out, or the item or its
/// collection deleted.
async fn standing(state: &AppState, ticket: &RoomTicket) -> Result<(i16, String), u16> {
    let row: Option<(i16, String)> = sqlx::query_as(&format!(
        "SELECT m.access_level, a.username
         FROM members m
         JOIN accounts a ON a.id = m.account_id AND NOT a.disabled
         JOIN sessions s ON s.account_id = a.id AND s.id = $4
         JOIN items i ON i.collection_id = m.collection_id AND i.id = $3
         {NOT_DELETED}
         WHERE m.collection_id = $1 AND m.account_id = $2"
    ))
    .bind(ticket.collection_id)
    .bind(ticket.account_id)
    .bind(ticket.item_id)
    .bind(ticket.session_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|err| {
        tracing::error!("could not check a room ticket: {err}");
        CLOSE_UNAVAILABLE
    })?;
    row.ok_or(CLOSE_REMOVED)
}

/// Close the rooms of items that are marked deleted, or whose collection is.
/// With `collection`, only that collection's rooms are looked at.
pub(crate) async fn close_deleted_rooms(
    state: &AppState,
    collection: Option<i64>,
) -> Result<(), sqlx::Error> {
    let rooms: Vec<RoomKey> = state
        .hub
        .open_rooms()
        .into_iter()
        .filter(|key| collection.is_none_or(|id| key.collection_id == id))
        .collect();
    if rooms.is_empty() {
        return Ok(());
    }
    let items: Vec<i64> = rooms.iter().map(|key| key.item_id).collect();
    let live: HashSet<i64> = sqlx::query_scalar(&format!(
        "SELECT i.id FROM items i {NOT_DELETED} WHERE i.id = ANY($1)"
    ))
    .bind(&items)
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .collect();
    for key in rooms {
        if !live.contains(&key.item_id) {
            state.hub.room_closed(key);
        }
    }
    Ok(())
}

/// Wait for the ticket and decide whether its holder may enter and with
/// what access.
async fn admit(state: &AppState, socket: &mut WebSocket) -> Result<(RoomTicket, String, i16), u16> {
    let hello = match tokio::time::timeout(HELLO_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(Message::Binary(frame)))) if frame.first() == Some(&FRAME_HELLO) => frame,
        _ => return Err(CLOSE_UNAUTHORIZED),
    };
    let ticket = std::str::from_utf8(&hello[1..])
        .ok()
        .and_then(|token| state.keys.verify_room_ticket(token))
        .ok_or(CLOSE_UNAUTHORIZED)?;
    let (access, username) = standing(state, &ticket).await?;
    Ok((ticket, username, access))
}

async fn serve(state: AppState, mut socket: WebSocket) {
    let (ticket, username, access) = match admit(&state, &mut socket).await {
        Ok(admitted) => admitted,
        Err(code) => return close(&mut socket, code).await,
    };
    let key = RoomKey {
        collection_id: ticket.collection_id,
        item_id: ticket.item_id,
    };
    let Joined {
        id,
        mut frames,
        queued,
        kick,
    } = match state
        .hub
        .join(key, ticket.account_id, ticket.session_id, username, access)
    {
        Ok(joined) => joined,
        Err(code) => return close(&mut socket, code).await,
    };

    // Being let in and being in the room are two moments. A member removed,
    // or a session ended, between them is announced by an event that finds
    // no socket to close, and the socket would then stay for good. So the
    // question is asked again now that the socket can be found: whatever
    // changes from here on reaches it as an event.
    match standing(&state, &ticket).await {
        Ok((now, _)) if now == access => {}
        Ok((now, _)) => {
            state
                .hub
                .membership_changed(key.collection_id, ticket.account_id, Some(now))
        }
        Err(code) => {
            state.hub.leave(key, id);
            return close(&mut socket, code).await;
        }
    }

    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.tick().await;
    let mut last_heard = Instant::now();
    let mut sync_window = Instant::now();
    let mut sync_requests = 0u32;

    let code = loop {
        tokio::select! {
            // Checked first so a removed member's socket closes ahead of
            // whatever is still queued for it.
            biased;
            code = kick.fired() => break Some(code),
            frame = frames.recv() => {
                let Some(frame) = frame else { break None };
                queued.fetch_sub(frame.len(), std::sync::atomic::Ordering::Relaxed);
                if socket.send(Message::Binary(frame)).await.is_err() {
                    break None;
                }
            }
            incoming = socket.recv() => {
                let frame = match incoming {
                    Some(Ok(Message::Binary(frame))) => frame,
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {
                        last_heard = Instant::now();
                        continue;
                    }
                    Some(Ok(Message::Text(_))) => break Some(CLOSE_BAD_FRAME),
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break None,
                };
                last_heard = Instant::now();
                let Some((&class, payload)) = frame.split_first() else {
                    break Some(CLOSE_BAD_FRAME);
                };
                match class {
                    CLASS_UPDATE | CLASS_PRESENCE => {
                        state.hub.relay(key, id, class, payload, None);
                    }
                    CLASS_SYNC => {
                        if sync_window.elapsed() > SYNC_WINDOW {
                            sync_window = Instant::now();
                            sync_requests = 0;
                        }
                        sync_requests += 1;
                        if sync_requests <= SYNC_REQUESTS {
                            state.hub.relay(key, id, class, payload, None);
                        }
                    }
                    CLASS_REPLY => {
                        let Some((target, payload)) = payload.split_first_chunk::<4>() else {
                            break Some(CLOSE_BAD_FRAME);
                        };
                        let target = u32::from_be_bytes(*target);
                        state.hub.relay(key, id, class, payload, Some(target));
                    }
                    _ => break Some(CLOSE_BAD_FRAME),
                }
            }
            _ = ping.tick() => {
                if last_heard.elapsed() > IDLE_TIMEOUT
                    || socket.send(Message::Ping(Default::default())).await.is_err()
                {
                    break None;
                }
            }
        }
    };

    state.hub.leave(key, id);
    if let Some(code) = code {
        close(&mut socket, code).await;
    }
}
