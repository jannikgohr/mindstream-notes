//! Rust-side live-collab provider for native ink notes.
//!
//! The wire protocol intentionally mirrors `src/lib/sync/collab-provider.ts`:
//! a dumb WebSocket relay broadcasts encrypted binary frames, while the app
//! handles Yrs sync-step messages locally. Keeping this in Rust lets native
//! ink avoid shipping every stroke update through JS or WASM just to reach
//! the collab room.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::net::IpAddr;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use futures_util::future::{select, Either};
use futures_util::{FutureExt, SinkExt, StreamExt};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

const FRAME_SYNC_STEP_1: u8 = 0x00;
const FRAME_SYNC_STEP_2: u8 = 0x01;
const FRAME_AWARENESS: u8 = 0x02;
const IV_LEN: usize = 12;

const RECONNECT_INITIAL_MS: u64 = 1_000;
const RECONNECT_MAX_MS: u64 = 30_000;

pub const COLLAB_STATUS_EVENT: &str = "drawing:collab_status";

#[derive(Serialize, Clone, Debug)]
pub struct CollabStatusEvent {
    pub note_id: String,
    pub configured: bool,
    pub online: bool,
}

enum ProviderCommand {
    LocalUpdate(Vec<u8>),
    Stop,
}

struct ProviderHandle {
    tx: mpsc::UnboundedSender<ProviderCommand>,
}

static PROVIDERS: OnceLock<Mutex<HashMap<String, ProviderHandle>>> = OnceLock::new();

fn providers() -> &'static Mutex<HashMap<String, ProviderHandle>> {
    PROVIDERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn frame_name(ty: u8) -> String {
    match ty {
        FRAME_SYNC_STEP_1 => "sync_step_1".to_string(),
        FRAME_SYNC_STEP_2 => "sync_step_2".to_string(),
        FRAME_AWARENESS => "awareness".to_string(),
        other => format!("unknown(0x{other:02x})"),
    }
}

pub fn start(
    app: AppHandle,
    note_id: String,
    url: String,
    room_id: String,
    key_bytes: Vec<u8>,
) -> Result<(), String> {
    if key_bytes.len() != 32 {
        return Err(format!(
            "drawing collab key must be 32 bytes, got {}",
            key_bytes.len()
        ));
    }
    let mut key = [0_u8; 32];
    key.copy_from_slice(&key_bytes);

    stop(&app, &note_id);
    log::info!("[drawing.collab] init note={note_id} room=resolved key=present url=configured");
    if endpoint_kind(&url) == EndpointKind::Loopback {
        log::warn!(
            "[drawing.collab] relay endpoint is loopback note={note_id}; Android cannot reach a desktop relay through localhost/127.0.0.1"
        );
    }

    let (tx, rx) = mpsc::unbounded_channel();
    {
        let mut map = providers()
            .lock()
            .map_err(|_| "drawing collab provider lock poisoned".to_string())?;
        map.insert(note_id.clone(), ProviderHandle { tx });
    }

    emit_status(&app, &note_id, true, false);
    tauri::async_runtime::spawn(provider_loop(app, note_id, url, room_id, key, rx));
    Ok(())
}

pub fn stop(app: &AppHandle, note_id: &str) {
    let handle = providers()
        .lock()
        .ok()
        .and_then(|mut map| map.remove(note_id));
    if let Some(handle) = handle {
        log::info!("[drawing.collab] stop note={note_id}");
        let _ = handle.tx.send(ProviderCommand::Stop);
    }
    emit_status(app, note_id, false, false);
}

pub fn broadcast_update(note_id: &str, update: Vec<u8>) {
    if update.is_empty() {
        return;
    }
    let tx = providers()
        .lock()
        .ok()
        .and_then(|map| map.get(note_id).map(|handle| handle.tx.clone()));
    if let Some(tx) = tx {
        log::debug!(
            "[drawing.collab] enqueue local update note={note_id} payload={}B",
            update.len()
        );
        let _ = tx.send(ProviderCommand::LocalUpdate(update));
    } else {
        log::debug!(
            "[drawing.collab] send dropped (provider not running) note={note_id} payload={}B",
            update.len()
        );
    }
}

async fn provider_loop(
    app: AppHandle,
    note_id: String,
    url: String,
    room_id: String,
    key: [u8; 32],
    mut rx: mpsc::UnboundedReceiver<ProviderCommand>,
) {
    let cipher = Aes256Gcm::new_from_slice(&key).expect("32-byte key");
    let mut reconnect_attempt = 0_u32;
    let connect_url = room_url(&url, &room_id);
    let endpoint = endpoint_kind(&url);

    loop {
        match tokio_tungstenite::connect_async(&connect_url).await {
            Ok((ws, _)) => {
                reconnect_attempt = 0;
                emit_status(&app, &note_id, true, true);
                log::info!("[drawing.collab] open note={note_id}");

                let (mut write, mut read) = ws.split();
                if let Some(sv) = crate::drawing::render::get_state_vector_for_note(&note_id) {
                    if let Ok(frame) = encrypt_frame(&cipher, FRAME_SYNC_STEP_1, &sv) {
                        log::debug!(
                            "[drawing.collab] send sync_step_1 note={note_id} payload={}B frame={}B",
                            sv.len(),
                            frame.len()
                        );
                        let _ = write.send(Message::Binary(frame.into())).await;
                    }
                } else {
                    log::warn!(
                        "[drawing.collab] no state vector for note={note_id}; initial sync skipped"
                    );
                }

                loop {
                    match select(rx.recv().boxed(), read.next().boxed()).await {
                        Either::Left((Some(cmd), _)) => match cmd {
                            ProviderCommand::LocalUpdate(update) => {
                                match encrypt_frame(&cipher, FRAME_SYNC_STEP_2, &update) {
                                    Ok(frame) => {
                                        log::debug!(
                                            "[drawing.collab] send sync_step_2 note={note_id} payload={}B frame={}B",
                                            update.len(),
                                            frame.len()
                                        );
                                        if write.send(Message::Binary(frame.into())).await.is_err()
                                        {
                                            break;
                                        }
                                    }
                                    Err(err) => {
                                        log::warn!("[drawing.collab] encrypt failed: {err}")
                                    }
                                }
                            }
                            ProviderCommand::Stop => {
                                let _ = write.close().await;
                                emit_status(&app, &note_id, false, false);
                                return;
                            }
                        },
                        Either::Left((None, _)) => return,
                        Either::Right((Some(Ok(Message::Binary(frame))), _)) => {
                            handle_frame(&app, &note_id, &cipher, &mut write, &frame).await;
                        }
                        Either::Right((Some(Ok(Message::Close(_))) | None, _)) => break,
                        Either::Right((Some(Ok(_)), _)) => {}
                        Either::Right((Some(Err(err)), _)) => {
                            log::warn!("[drawing.collab] socket read failed note={note_id}: {err}");
                            break;
                        }
                    }
                }
                emit_status(&app, &note_id, true, false);
            }
            Err(err) => {
                log::warn!(
                    "[drawing.collab] connect failed note={note_id} endpoint={} reason={}",
                    endpoint.label(),
                    connect_failure_reason(&err)
                );
                emit_status(&app, &note_id, true, false);
            }
        }

        let delay = (RECONNECT_INITIAL_MS.saturating_mul(2_u64.saturating_pow(reconnect_attempt)))
            .min(RECONNECT_MAX_MS);
        reconnect_attempt = reconnect_attempt.saturating_add(1);
        match select(
            tokio::time::sleep(Duration::from_millis(delay)).boxed(),
            rx.recv().boxed(),
        )
        .await
        {
            Either::Left((_, _)) => {}
            Either::Right((Some(cmd), _)) => match cmd {
                ProviderCommand::Stop => {
                    emit_status(&app, &note_id, false, false);
                    return;
                }
                ProviderCommand::LocalUpdate(update) => {
                    log::debug!(
                        "[drawing.collab] queued update dropped while offline note={note_id} bytes={}",
                        update.len()
                    );
                }
            },
            Either::Right((None, _)) => return,
        }
    }
}

async fn handle_frame<S>(
    app: &AppHandle,
    note_id: &str,
    cipher: &Aes256Gcm,
    write: &mut S,
    frame: &[u8],
) where
    S: SinkExt<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::fmt::Display,
{
    let ty_for_log = frame.first().copied().unwrap_or(0xff);
    let Some((ty, payload)) = decrypt_frame(cipher, frame) else {
        log::warn!(
            "[drawing.collab] decrypt failed type={} frame={}B note={note_id} - likely a key mismatch between devices",
            frame_name(ty_for_log),
            frame.len()
        );
        return;
    };
    log::debug!(
        "[drawing.collab] recv {} note={note_id} payload={}B frame={}B",
        frame_name(ty),
        payload.len(),
        frame.len()
    );
    match ty {
        FRAME_SYNC_STEP_1 => {
            if let Some(diff) = crate::drawing::render::encode_diff_for_note(note_id, &payload) {
                match encrypt_frame(cipher, FRAME_SYNC_STEP_2, &diff) {
                    Ok(frame) => {
                        log::debug!(
                            "[drawing.collab] send sync_step_2 note={note_id} payload={}B frame={}B",
                            diff.len(),
                            frame.len()
                        );
                        if let Err(err) = write.send(Message::Binary(frame.into())).await {
                            log::warn!("[drawing.collab] sync reply failed note={note_id}: {err}");
                        }
                    }
                    Err(err) => log::warn!("[drawing.collab] encrypt sync reply failed: {err}"),
                }
            } else {
                log::warn!(
                    "[drawing.collab] invalid state vector in sync_step_1 note={note_id} payload={}B",
                    payload.len()
                );
            }
        }
        FRAME_SYNC_STEP_2 => {
            log::debug!(
                "[drawing.collab] apply remote update note={note_id} payload={}B",
                payload.len()
            );
            crate::drawing::render::apply_remote_update(note_id.to_string(), payload.to_vec());
        }
        FRAME_AWARENESS => {
            // Ink notes don't expose remote cursors yet; keep the frame
            // type reserved so the provider remains protocol-compatible.
            let _ = app;
        }
        other => log::warn!("[drawing.collab] unknown frame type 0x{other:02x}"),
    }
}

fn encrypt_frame(cipher: &Aes256Gcm, ty: u8, payload: &[u8]) -> Result<Vec<u8>, String> {
    let mut iv = [0_u8; IV_LEN];
    getrandom::fill(&mut iv).map_err(|e| format!("iv: {e}"))?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&iv), payload)
        .map_err(|e| format!("aes-gcm: {e}"))?;
    let mut frame = Vec::with_capacity(1 + IV_LEN + ciphertext.len());
    frame.push(ty);
    frame.extend_from_slice(&iv);
    frame.extend_from_slice(&ciphertext);
    Ok(frame)
}

fn decrypt_frame(cipher: &Aes256Gcm, frame: &[u8]) -> Option<(u8, Vec<u8>)> {
    if frame.len() < 1 + IV_LEN {
        return None;
    }
    let ty = frame[0];
    let iv = &frame[1..1 + IV_LEN];
    let ciphertext = &frame[1 + IV_LEN..];
    let payload = cipher.decrypt(Nonce::from_slice(iv), ciphertext).ok()?;
    Some((ty, payload))
}

fn room_url(url: &str, room_id: &str) -> String {
    let url = websocket_url(url);
    let separator = if url.contains('?') {
        if url.ends_with('?') || url.ends_with('&') {
            ""
        } else {
            "&"
        }
    } else {
        "?"
    };
    format!("{url}{separator}room={}", urlencoding::encode(room_id))
}

fn websocket_url(url: &str) -> String {
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("http://") {
        format!("ws://{}", &url["http://".len()..])
    } else if lower.starts_with("https://") {
        format!("wss://{}", &url["https://".len()..])
    } else {
        url.to_string()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EndpointKind {
    Loopback,
    PrivateLan,
    PublicOrHostname,
    Invalid,
}

impl EndpointKind {
    fn label(self) -> &'static str {
        match self {
            Self::Loopback => "loopback",
            Self::PrivateLan => "private_lan",
            Self::PublicOrHostname => "configured",
            Self::Invalid => "invalid",
        }
    }
}

fn endpoint_kind(url: &str) -> EndpointKind {
    let Some(host) = websocket_host(url) else {
        return EndpointKind::Invalid;
    };
    let normalized = host.trim_end_matches('.').to_ascii_lowercase();
    if normalized == "localhost" || normalized.ends_with(".localhost") {
        return EndpointKind::Loopback;
    }
    match normalized.parse::<IpAddr>() {
        Ok(ip) if ip.is_loopback() => EndpointKind::Loopback,
        Ok(IpAddr::V4(ip)) if ip.is_private() || ip.is_link_local() => EndpointKind::PrivateLan,
        Ok(IpAddr::V6(ip)) if is_private_ipv6(&ip) => EndpointKind::PrivateLan,
        Ok(_) | Err(_) => EndpointKind::PublicOrHostname,
    }
}

fn websocket_host(url: &str) -> Option<&str> {
    let (scheme, rest) = url.split_once("://")?;
    if !matches!(
        scheme.to_ascii_lowercase().as_str(),
        "ws" | "wss" | "http" | "https"
    ) {
        return None;
    }
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(rest)
        .rsplit_once('@')
        .map_or_else(
            || rest.split(['/', '?', '#']).next().unwrap_or(rest),
            |(_, host)| host,
        );
    if let Some(bracketed) = authority.strip_prefix('[') {
        return bracketed.split_once(']').map(|(host, _)| host);
    }
    let host = authority
        .rsplit_once(':')
        .map_or(authority, |(host, port)| {
            if port.chars().all(|ch| ch.is_ascii_digit()) {
                host
            } else {
                authority
            }
        });
    (!host.is_empty()).then_some(host)
}

fn is_private_ipv6(ip: &std::net::Ipv6Addr) -> bool {
    let first = ip.segments()[0];
    // fc00::/7 unique local, fe80::/10 link local.
    (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
}

fn connect_failure_reason(err: &WsError) -> String {
    match err {
        WsError::Io(err) => match err.kind() {
            ErrorKind::ConnectionRefused => "connection_refused".to_string(),
            ErrorKind::ConnectionReset => "connection_reset".to_string(),
            ErrorKind::ConnectionAborted => "connection_aborted".to_string(),
            ErrorKind::NotConnected => "not_connected".to_string(),
            ErrorKind::AddrInUse => "addr_in_use".to_string(),
            ErrorKind::AddrNotAvailable => "addr_not_available".to_string(),
            ErrorKind::TimedOut => "timed_out".to_string(),
            ErrorKind::Interrupted => "interrupted".to_string(),
            ErrorKind::Unsupported => "unsupported".to_string(),
            ErrorKind::UnexpectedEof => "unexpected_eof".to_string(),
            _ => err
                .raw_os_error()
                .map_or_else(|| "io".to_string(), |code| format!("io_os_{code}")),
        },
        WsError::Tls(_) => "tls".to_string(),
        WsError::Url(_) => "url".to_string(),
        WsError::Http(response) => format!("http_{}", response.status().as_u16()),
        WsError::HttpFormat(_) => "http_format".to_string(),
        WsError::Protocol(_) => "protocol".to_string(),
        WsError::Capacity(_) => "capacity".to_string(),
        WsError::Utf8(_) => "utf8".to_string(),
        WsError::ConnectionClosed => "closed".to_string(),
        WsError::AlreadyClosed => "already_closed".to_string(),
        WsError::WriteBufferFull(_) => "write_buffer_full".to_string(),
        WsError::AttackAttempt => "attack_attempt".to_string(),
    }
}

fn emit_status(app: &AppHandle, note_id: &str, configured: bool, online: bool) {
    let event = CollabStatusEvent {
        note_id: note_id.to_string(),
        configured,
        online,
    };
    if let Err(err) = app.emit(COLLAB_STATUS_EVENT, &event) {
        log::warn!("[drawing.collab] emit {COLLAB_STATUS_EVENT} failed: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::{endpoint_kind, room_url, EndpointKind};

    #[test]
    fn room_url_preserves_existing_query() {
        assert_eq!(
            room_url("wss://relay.example/ws", "room one"),
            "wss://relay.example/ws?room=room%20one"
        );
        assert_eq!(
            room_url("wss://relay.example/ws?token=abc", "room one"),
            "wss://relay.example/ws?token=abc&room=room%20one"
        );
        assert_eq!(
            room_url("wss://relay.example/ws?", "room one"),
            "wss://relay.example/ws?room=room%20one"
        );
        assert_eq!(
            room_url("http://192.168.1.10:1234/ws", "room one"),
            "ws://192.168.1.10:1234/ws?room=room%20one"
        );
        assert_eq!(
            room_url("https://relay.example/ws", "room one"),
            "wss://relay.example/ws?room=room%20one"
        );
    }

    #[test]
    fn endpoint_kind_does_not_expose_endpoint_values() {
        assert_eq!(endpoint_kind("ws://localhost:1234"), EndpointKind::Loopback);
        assert_eq!(
            endpoint_kind("http://localhost:1234"),
            EndpointKind::Loopback
        );
        assert_eq!(endpoint_kind("ws://127.0.0.1:1234"), EndpointKind::Loopback);
        assert_eq!(
            endpoint_kind("ws://10.0.2.2:1234"),
            EndpointKind::PrivateLan
        );
        assert_eq!(
            endpoint_kind("wss://relay.example/ws"),
            EndpointKind::PublicOrHostname
        );
        assert_eq!(
            endpoint_kind("https://relay.example/ws"),
            EndpointKind::PublicOrHostname
        );
        assert_eq!(
            endpoint_kind("ftp://relay.example/ws"),
            EndpointKind::Invalid
        );
    }
}
