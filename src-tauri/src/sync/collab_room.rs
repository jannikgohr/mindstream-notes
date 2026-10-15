//! Live-collab rooms: the `note_room_info` and `note_room_ticket` commands.
//!
//! A room is a note's item on the sync server. The server knows who belongs
//! to the item's collection and with what access, so getting in takes a
//! ticket that only a member can ask for, and the server drops document
//! changes from members who may only read. What is left to do here is name
//! the room, fetch the ticket, and derive the key the frames are encrypted
//! under. The server relays those frames and never sees the key.

use super::*;

/// What the live-collab editor needs to connect to a note's room. `None` in
/// place of the whole record means the note has no room to join yet:
/// typically it has not been pushed (no uid), or carries no per-note key.
#[derive(Debug, Serialize)]
pub struct RoomInfo {
    /// Where the room socket connects: the sync server's own address.
    pub url: String,
    /// The collection and item that name the room on the server. The editor
    /// hands them back to `note_room_ticket` when it has to reconnect.
    pub collection: String,
    pub item: String,
    /// A pass into the room, good for one socket and about half a minute.
    /// It is what goes to the webview in place of the session token.
    pub ticket: String,
    /// 32-byte AES-GCM secret, base64 (URL-safe) so it survives JSON IPC
    /// without ballooning into a number array.
    pub key_b64: String,
}

/// The AES-GCM key a note's room encrypts its frames under, derived with
/// HKDF from the key the note carries. It is not that key itself: one key
/// for what is stored and for what goes over the wire would let a break of
/// either take both.
///
/// The same for a note in the vault and for one in a shared folder. Whoever
/// holds the note holds its room's key, and nothing changes it when a member
/// of the folder is removed. Keeping them out of the room is the server's
/// job, which it does by refusing them the ticket and closing their sockets.
/// A folder once gave its rooms a salt that was changed on removal. It was
/// stored under the folder's own key, which a removed member keeps, so it
/// hid nothing from them that the server did not already withhold.
pub(super) fn room_key(note_uid: &str, note_key: &[u8]) -> Result<[u8; 32], String> {
    let hkdf = Hkdf::<Sha256>::new(None, note_key);
    let mut derived_key = [0_u8; 32];
    let mut info = Vec::with_capacity(LIVE_COLLAB_KEY_INFO.len() + note_uid.len());
    info.extend_from_slice(LIVE_COLLAB_KEY_INFO);
    info.extend_from_slice(note_uid.as_bytes());
    hkdf.expand(&info, &mut derived_key)
        .map_err(|e| format!("derive live-collab key: {e}"))?;
    Ok(derived_key)
}

/// Whether the server's answer means "you may not enter this room", as
/// opposed to "try again". Not a member, the note gone, or the session over:
/// asking again gets the same answer, so the editor stops asking.
pub(super) fn room_entry_refused(error: &EtebaseError) -> bool {
    matches!(
        error,
        EtebaseError::NotFound(_)
            | EtebaseError::Unauthorized(_)
            | EtebaseError::PermissionDenied(_)
    )
}

fn valid_room_uid(uid: &str) -> bool {
    (1..=64).contains(&uid.len())
        && uid
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A fresh ticket for a room the editor already knows, for reconnecting.
/// `None` means the server will not let this account in, and trying again
/// will not change that. An error is worth retrying.
#[tauri::command]
pub async fn note_room_ticket(
    app: AppHandle,
    collection: String,
    item: String,
) -> CommandResult<Option<String>> {
    if !valid_room_uid(&collection) || !valid_room_uid(&item) {
        return Err("note_room_ticket: malformed room".to_string().into());
    }
    if !crate::auth::has_session(&app) {
        return Ok(None);
    }
    Ok(
        tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
            catch_blocking_panic("room_ticket", || {
                let Some(account) =
                    crate::auth::try_restore(&app).map_err(|e| format!("restore session: {e}"))?
                else {
                    return Ok(None);
                };
                match account.mindstream().room_ticket(&collection, &item) {
                    Ok(ticket) => Ok(Some(ticket.ticket().to_string())),
                    Err(e) if room_entry_refused(&e) => Ok(None),
                    Err(e) => Err(format!("room ticket: {e}")),
                }
            })
        })
        .await
        .map_err(|e| format!("note_room_ticket task: {e}"))??,
    )
}

/// The key a note carries, read off the note as the server has it. `None`
/// where there is no room to be had: the collection or the note is gone or
/// cannot be fetched, or the note is from before live sessions and has no
/// key.
fn fetch_note_key(
    account: &Account,
    col_uid: &str,
    note_uid: &str,
) -> Result<Option<Vec<u8>>, String> {
    let cm = account
        .collection_manager()
        .map_err(|e| format!("collection_manager: {e}"))?;
    let col = match cm.fetch(col_uid, None) {
        Ok(c) if !c.is_deleted() => c,
        Ok(_) => return Ok(None),
        Err(e) => {
            log::warn!("[room_info] fetch the note's collection failed: {e}");
            return Ok(None);
        }
    };
    let im = cm
        .item_manager(&col)
        .map_err(|e| format!("item_manager: {e}"))?;
    let item = match im.fetch(note_uid, None) {
        Ok(it) => it,
        Err(e) => {
            log::warn!("[room_info] fetch note item {note_uid} failed: {e}");
            return Ok(None);
        }
    };
    if item.is_deleted() || item.is_missing_content() {
        return Ok(None);
    }
    let raw = item.content().map_err(|e| format!("item content: {e}"))?;
    let payload: NotePayload = match rmp_serde::from_slice(&raw) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[room_info] payload decode failed: {e}");
            return Ok(None);
        }
    };
    // Empty for a note from before live sessions. No room, rather than a
    // key made of nothing.
    Ok(Some(payload.crypto_key).filter(|key| !key.is_empty()))
}

#[tauri::command]
pub async fn note_room_info(
    app: AppHandle,
    db: tauri::State<'_, Db>,
    id: String,
) -> CommandResult<Option<RoomInfo>> {
    // Live collab needs the sync server: no session, no room.
    if !crate::auth::has_session(&app) {
        return Ok(None);
    }

    // Read the local breadcrumbs: the note's item uid, its share scope if it
    // has one, and the vault's collection uid. The note's key is read below,
    // from what the last sync kept, or from the server when nothing is kept.
    let lookups = db
        .with_conn(|c| {
            let note_lookup: Option<(Option<String>, Option<String>)> = c
                .query_row(
                    "SELECT etebase_uid, share_scope_id FROM notes WHERE id = ?1",
                    params![&id],
                    |r| {
                        Ok((
                            r.get::<_, Option<String>>(0)?,
                            r.get::<_, Option<String>>(1)?,
                        ))
                    },
                )
                .optional()?;
            let col_uid: Option<String> = c
                .query_row(
                    "SELECT etebase_collection_uid FROM sync_state WHERE kind = ?1",
                    params![KIND_VAULT],
                    |r| r.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten();
            Ok::<_, AppError>((note_lookup, col_uid))
        })
        .map_err(|e| e.to_string())?;

    let Some((Some(note_uid), share_scope_id)) = lookups.0 else {
        return Ok(None);
    };
    let vault_col_uid = lookups.1;

    // Restore the account + fetch the item inside spawn_blocking. The
    // etebase SDK is sync-over-reqwest::blocking, which constructs a
    // private tokio runtime per call; dropping that runtime back on the
    // async worker panics — same trap as etebase_login/_logout. The
    // closure returns only plain strings so no etebase-owned value escapes
    // the blocking pool.
    let app_for_blocking = app.clone();
    let note_id = id;
    Ok(
        tauri::async_runtime::spawn_blocking(move || -> Result<Option<RoomInfo>, String> {
            catch_blocking_panic("room_info", || {
                let account = match crate::auth::try_restore(&app_for_blocking)
                    .map_err(|e| format!("restore session: {e}"))?
                {
                    Some(a) => a,
                    None => return Ok(None),
                };
                // The collection the note is an item of: the vault, or for a
                // note in a shared folder the folder's collection, whose uid
                // is the scope.
                let Some(col_uid) = share_scope_id.clone().or(vault_col_uid) else {
                    return Ok(None);
                };

                // The note's key, from what the last sync kept. Then the
                // ticket below is the only request. A key that is not kept,
                // or that this session cannot open, is fetched as it always
                // was, and kept for next time.
                let db = app_for_blocking.state::<Db>();
                let seal = crate::auth::room_key_seal(&app_for_blocking);
                let kept = match &seal {
                    Some(seal) => db
                        .with_conn(|conn| room_keys::load(conn, seal, &note_id))
                        .map_err(|e| format!("read the kept room key: {e}"))?,
                    None => None,
                };
                let note_key = match kept {
                    Some(key) => key,
                    None => {
                        let Some(key) = fetch_note_key(&account, &col_uid, &note_uid)? else {
                            return Ok(None);
                        };
                        if let Some(seal) = &seal {
                            if let Err(err) =
                                db.with_conn(|conn| room_keys::store(conn, seal, &note_id, &key))
                            {
                                log::warn!("[room_info] could not keep the room key: {err}");
                            }
                        }
                        key
                    }
                };
                let key = room_key(&note_uid, &note_key)?;

                // A member who may only read gets a ticket like anyone else.
                // The server lets them watch and drops what they send.
                let rooms = account.mindstream();
                let ticket = match rooms.room_ticket(&col_uid, &note_uid) {
                    Ok(ticket) => ticket,
                    Err(e) if room_entry_refused(&e) => return Ok(None),
                    Err(e) => {
                        // Most likely a server without rooms, or one that is
                        // unreachable. The editor works without live collab.
                        log::warn!("[room_info] room ticket for {note_uid} failed: {e}");
                        return Ok(None);
                    }
                };
                Ok(Some(RoomInfo {
                    url: rooms.room_url().map_err(|e| format!("room url: {e}"))?,
                    collection: col_uid,
                    item: note_uid,
                    ticket: ticket.ticket().to_string(),
                    key_b64: etebase::utils::to_base64(&key)
                        .map_err(|e| format!("encode key: {e}"))?,
                }))
            })
        })
        .await
        .map_err(|e| format!("note_room_info task: {e}"))??,
    )
}
