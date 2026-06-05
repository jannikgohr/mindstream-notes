//! Rust-side live-collab provider for native ink notes.
//!
//! The wire protocol intentionally mirrors `src/lib/sync/collab-provider.ts`:
//! a dumb WebSocket relay broadcasts encrypted binary frames, while the app
//! handles Yrs sync-step messages locally. Keeping this in Rust lets native
//! ink avoid shipping every stroke update through JS or WASM just to reach
//! the collab room.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use futures_util::future::{select, Either};
use futures_util::{FutureExt, SinkExt, StreamExt};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

const FRAME_SYNC_STEP_1: u8 = 0x00;
const FRAME_SYNC_STEP_2: u8 = 0x01;
const FRAME_AWARENESS: u8 = 0x02;
const IV_LEN: usize = 12;

const RECONNECT_INITIAL_MS: u64 = 1_000;
const RECONNECT_MAX_MS: u64 = 30_000;

pub const COLLAB_STATUS_EVENT: &str = "drawing:collab_status";

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
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
        let _ = tx.send(ProviderCommand::LocalUpdate(update));
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

    loop {
        let connect_url = format!("{}?room={}", url, urlencoding::encode(&room_id));
        match tokio_tungstenite::connect_async(&connect_url).await {
            Ok((ws, _)) => {
                reconnect_attempt = 0;
                emit_status(&app, &note_id, true, true);
                log::info!("[drawing.collab] open note={note_id} room={room_id}");

                let (mut write, mut read) = ws.split();
                if let Some(sv) = crate::drawing::render::get_state_vector_for_note(&note_id) {
                    if let Ok(frame) = encrypt_frame(&cipher, FRAME_SYNC_STEP_1, &sv) {
                        let _ = write.send(Message::Binary(frame.into())).await;
                    }
                }

                loop {
                    match select(rx.recv().boxed(), read.next().boxed()).await {
                        Either::Left((Some(cmd), _)) => match cmd {
                            ProviderCommand::LocalUpdate(update) => {
                                match encrypt_frame(&cipher, FRAME_SYNC_STEP_2, &update) {
                                    Ok(frame) => {
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
                log::warn!("[drawing.collab] connect failed note={note_id}: {err}");
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
    let Some((ty, payload)) = decrypt_frame(cipher, frame) else {
        log::warn!("[drawing.collab] decrypt failed note={note_id}");
        return;
    };
    match ty {
        FRAME_SYNC_STEP_1 => {
            if let Some(diff) = crate::drawing::render::encode_diff_for_note(note_id, &payload) {
                match encrypt_frame(cipher, FRAME_SYNC_STEP_2, &diff) {
                    Ok(frame) => {
                        if let Err(err) = write.send(Message::Binary(frame.into())).await {
                            log::warn!("[drawing.collab] sync reply failed note={note_id}: {err}");
                        }
                    }
                    Err(err) => log::warn!("[drawing.collab] encrypt sync reply failed: {err}"),
                }
            }
        }
        FRAME_SYNC_STEP_2 => {
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
