//! Live-collab room derivation and the `note_room_info` command.
//!
//! Everything here is about turning a note's Etebase identity + per-note
//! key into the relay room id, the symmetric frame key, and the P-256
//! join keypair — plus publishing/reading the writer keys that authorize
//! a shared scope's members to send write frames.

use super::*;

/// Room metadata the live-collab editor needs to connect. Returned by
/// `note_room_info`. `None` for the whole record means "this note can't
/// join a room yet" — typically because it hasn't been pushed to etebase
/// (no UID), or no per-note key exists locally (note was created on this
/// device and never synced).
#[derive(Debug, Serialize)]
pub struct RoomInfo {
    /// The relay room, and simultaneously the public half of the join
    /// keypair: base64 of the P-256 SPKI DER derived from the room secret.
    /// Naming the room after a *public* key is what lets the relay
    /// authenticate joins without holding any secret of its own — see
    /// [`derive_collab_join_keypair`].
    pub room_id: String,
    /// 32-byte AES-GCM secret, base64 (URL-safe) so it survives JSON IPC
    /// without ballooning into a number array.
    pub key_b64: String,
    /// Version label from the share manifest. Zero means no scoped collab salt
    /// was applied, preserving legacy room credentials.
    pub collab_epoch: u64,
    /// Present for salted shared-folder rooms. Clients combine this public-key
    /// registry with their local private key to sign/verify write frames.
    pub writer_auth: Option<RoomWriterAuth>,
    /// Private half of the join keypair (PKCS#8 DER, base64) — the client
    /// signs the relay's challenge nonce with it to prove it can derive the
    /// room secret. Handed to the webview rather than kept in Rust because
    /// re-deriving it costs an Etebase round-trip, which a reconnect loop
    /// would turn into a fetch storm. It is strictly less sensitive than
    /// `key_b64`, which is in the same payload and decrypts content; this one
    /// only opens the door to a room whose traffic is already ciphertext.
    pub join_private_key_pkcs8_b64: String,
}

#[derive(Debug, Serialize)]
pub struct RoomWriterAuth {
    pub authorized_writers: Vec<RoomAuthorizedWriter>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RoomAuthorizedWriter {
    pub username: String,
    pub public_key_b64: String,
}

/// Deterministically derive the room's join keypair from the same secret the
/// room id comes from, returning `(spki_b64, pkcs8_b64)`.
///
/// The public half *becomes* the room id. That inversion is the whole trick:
/// the relay can verify a signature against the room id it was handed in the
/// URL, so it authenticates membership while holding no secret, no per-room
/// state, and no knowledge of Etebase identities. Every member derives the
/// same keypair, so this proves "I can derive this room's secret" — it says
/// nothing about *which* member, and deliberately does not replace the
/// per-writer frame signatures that carry authorship.
///
/// An HKDF block can land outside the valid scalar range `[1, n-1]`. The odds
/// are ~2^-32, but a room that failed to derive would be silently unjoinable,
/// so we counter-retry into the info string rather than erroring out.
pub(super) fn derive_collab_join_keypair(
    note_uid: &str,
    note_key: &[u8],
    salt: Option<&[u8]>,
    collab_epoch: u64,
) -> Result<(String, String), String> {
    let hkdf = Hkdf::<Sha256>::new(salt, note_key);
    let mut info = Vec::with_capacity(
        LIVE_COLLAB_JOIN_INFO.len() + std::mem::size_of::<u64>() + note_uid.len() + 1,
    );
    info.extend_from_slice(LIVE_COLLAB_JOIN_INFO);
    info.extend_from_slice(&collab_epoch.to_be_bytes());
    info.extend_from_slice(note_uid.as_bytes());
    info.push(0);
    let counter_at = info.len() - 1;

    for counter in 0_u8..=u8::MAX {
        info[counter_at] = counter;
        let mut okm = [0_u8; 32];
        hkdf.expand(&info, &mut okm)
            .map_err(|e| format!("derive join key: {e}"))?;
        let Ok(secret) = p256::SecretKey::from_slice(&okm) else {
            continue;
        };
        let pkcs8 = secret
            .to_pkcs8_der()
            .map_err(|e| format!("encode join private key: {e}"))?;
        let spki = secret
            .public_key()
            .to_public_key_der()
            .map_err(|e| format!("encode join public key: {e}"))?;
        return Ok((
            BASE64_STANDARD.encode(spki.as_bytes()),
            BASE64_STANDARD.encode(pkcs8.as_bytes()),
        ));
    }
    Err("derive join key: no valid scalar in 256 attempts".into())
}

/// HKDF the per-room AES-GCM wire key. `salt` is the share manifest's collab
/// salt for a scoped room, `None` for a personal one — either way the key that
/// goes on the wire is domain-separated from the Etebase item key it derives
/// from.
pub(super) fn derive_live_collab_key(
    note_uid: &str,
    note_key: &[u8],
    salt: Option<&[u8]>,
    collab_epoch: u64,
) -> Result<[u8; 32], String> {
    let hkdf = Hkdf::<Sha256>::new(salt, note_key);
    let mut derived_key = [0_u8; 32];
    let mut info = Vec::with_capacity(
        LIVE_COLLAB_KEY_INFO.len() + std::mem::size_of::<u64>() + note_uid.len(),
    );
    info.extend_from_slice(LIVE_COLLAB_KEY_INFO);
    info.extend_from_slice(&collab_epoch.to_be_bytes());
    info.extend_from_slice(note_uid.as_bytes());
    hkdf.expand(&info, &mut derived_key)
        .map_err(|e| format!("derive live-collab key: {e}"))?;
    Ok(derived_key)
}

pub(super) fn derive_live_collab_room(
    note_uid: &str,
    note_key: &[u8],
    scope: Option<&ShareScopeCollabInfo>,
) -> Result<RoomInfo, String> {
    // Unscoped (personal) notes have no manifest salt, so the note key is the
    // only secret available to bind the room to. They still get a derived join
    // keypair — which also stops the room id from being the Etebase item UID,
    // a value the server operator already stores in plaintext.
    let Some(scope) = scope.filter(|scope| !scope.collab_salt.is_empty()) else {
        let (room_id, join_private_key_pkcs8_b64) =
            derive_collab_join_keypair(note_uid, note_key, None, 0)?;
        // Derive the wire key rather than handing over the Etebase item key
        // itself. Reusing one key for at-rest storage and for AES-GCM on the
        // wire means a compromise of either context compromises both; the
        // scoped path below has always done this properly.
        let derived_key = derive_live_collab_key(note_uid, note_key, None, 0)?;
        return Ok(RoomInfo {
            room_id,
            key_b64: etebase::utils::to_base64(&derived_key)
                .map_err(|e| format!("encode key: {e}"))?,
            collab_epoch: 0,
            writer_auth: None,
            join_private_key_pkcs8_b64,
        });
    };

    let derived_key = derive_live_collab_key(
        note_uid,
        note_key,
        Some(&scope.collab_salt),
        scope.collab_epoch,
    )?;

    let (room_id, join_private_key_pkcs8_b64) = derive_collab_join_keypair(
        note_uid,
        note_key,
        Some(&scope.collab_salt),
        scope.collab_epoch,
    )?;

    Ok(RoomInfo {
        room_id,
        key_b64: etebase::utils::to_base64(&derived_key).map_err(|e| format!("encode key: {e}"))?,
        collab_epoch: scope.collab_epoch,
        writer_auth: None,
        join_private_key_pkcs8_b64,
    })
}

pub(super) fn can_receive_live_collab_room(
    access_level: CollectionAccessLevel,
    scoped_room: bool,
) -> bool {
    !scoped_room || !matches!(access_level, CollectionAccessLevel::ReadOnly)
}

pub(super) fn valid_collab_writer_public_key(public_key_b64: &str) -> bool {
    let Ok(bytes) = BASE64_STANDARD.decode(public_key_b64) else {
        return false;
    };
    bytes.len() == P256_SPKI_DER_LEN && bytes.starts_with(P256_SPKI_DER_PREFIX)
}

pub(super) fn collab_writer_key_payload(item: &Item) -> AppResult<Option<CollabWriterKeyPayload>> {
    if item.is_deleted() || item.is_missing_content() {
        return Ok(None);
    }
    if item_type(item).as_deref() != Some(ITEM_TYPE_COLLAB_WRITER_KEY) {
        return Ok(None);
    }
    let raw = item
        .content()
        .map_err(|e| AppError::InvalidArg(format!("writer key content: {e}")))?;
    let payload = serde_json::from_slice::<CollabWriterKeyPayload>(&raw)
        .map_err(|e| AppError::InvalidArg(format!("writer key json: {e}")))?;
    Ok(Some(payload))
}

pub(super) fn writable_member_usernames(
    collection: &Collection,
    cm: &CollectionManager,
) -> AppResult<HashSet<String>> {
    let member_manager = cm
        .member_manager(collection)
        .map_err(|e| AppError::InvalidArg(format!("member_manager(writer auth): {e}")))?;
    let mut writers = HashSet::new();
    let mut iterator: Option<String> = None;
    loop {
        let options = FetchOptions::new().limit(100).iterator(iterator.as_deref());
        let page = member_manager
            .list(Some(&options))
            .map_err(|e| AppError::InvalidArg(format!("list writer members: {e}")))?;
        for member in page.data() {
            if !matches!(member.access_level(), CollectionAccessLevel::ReadOnly) {
                writers.insert(member.username().to_string());
            }
        }
        if page.done() {
            break;
        }
        match page.iterator().map(str::to_string) {
            Some(next) => iterator = Some(next),
            None => break,
        }
    }
    Ok(writers)
}

pub(super) fn list_collab_writer_keys(
    im: &ItemManager,
    share_scope_id: &str,
    collab_epoch: u64,
) -> AppResult<Vec<RoomAuthorizedWriter>> {
    let mut writers = Vec::new();
    let mut seen = HashSet::new();
    let mut stoken: Option<String> = None;
    loop {
        let opts = FetchOptions::new().stoken(stoken.as_deref());
        let resp = im
            .list(Some(&opts))
            .map_err(|e| AppError::InvalidArg(format!("list writer keys: {e}")))?;
        for item in resp.data() {
            let Some(payload) = collab_writer_key_payload(item)? else {
                continue;
            };
            if payload.share_scope_id == share_scope_id && payload.collab_epoch == collab_epoch {
                let Some(username) = payload.username else {
                    continue;
                };
                if seen.insert((username.clone(), payload.public_key_b64.clone())) {
                    writers.push(RoomAuthorizedWriter {
                        username,
                        public_key_b64: payload.public_key_b64,
                    });
                }
            }
        }
        stoken = resp.stoken().map(str::to_string).or(stoken);
        if resp.done() {
            break;
        }
    }
    writers.sort_by(|a, b| {
        a.username
            .cmp(&b.username)
            .then_with(|| a.public_key_b64.cmp(&b.public_key_b64))
    });
    Ok(writers)
}

pub(super) fn filter_writable_collab_writers(
    writers: Vec<RoomAuthorizedWriter>,
    writable_usernames: &HashSet<String>,
) -> Vec<RoomAuthorizedWriter> {
    writers
        .into_iter()
        .filter(|writer| writable_usernames.contains(&writer.username))
        .collect()
}

pub(super) fn publish_collab_writer_key(
    im: &ItemManager,
    share_scope_id: &str,
    collab_epoch: u64,
    public_key_b64: &str,
    username: Option<&str>,
) -> AppResult<()> {
    if !valid_collab_writer_public_key(public_key_b64) {
        return Ok(());
    }
    let Some(username) = username else {
        return Ok(());
    };
    let existing = list_collab_writer_keys(im, share_scope_id, collab_epoch)?;
    if existing
        .iter()
        .any(|writer| writer.username == username && writer.public_key_b64 == public_key_b64)
    {
        return Ok(());
    }

    let payload = CollabWriterKeyPayload {
        schema: 1,
        share_scope_id: share_scope_id.to_string(),
        collab_epoch,
        public_key_b64: public_key_b64.to_string(),
        username: Some(username.to_string()),
    };
    let bytes = serde_json::to_vec(&payload)
        .map_err(|e| AppError::InvalidArg(format!("encode writer key: {e}")))?;
    let key_hint: String = public_key_b64
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(12)
        .collect();
    let mut meta = ItemMetadata::new();
    meta.set_item_type(Some(ITEM_TYPE_COLLAB_WRITER_KEY))
        .set_name(Some(format!("collab-writer-key:{key_hint}")))
        .set_mtime(Some(now_unix_ms()));
    let item = im
        .create(&meta, &bytes)
        .map_err(|e| AppError::InvalidArg(format!("create writer key item: {e}")))?;
    im.transaction([item].iter(), None)
        .map_err(|e| AppError::InvalidArg(format!("transaction writer key: {e}")))?;
    Ok(())
}

#[tauri::command]
pub async fn note_room_info(
    app: AppHandle,
    db: tauri::State<'_, Db>,
    id: String,
    writer_public_key_b64: Option<String>,
) -> Result<Option<RoomInfo>, String> {
    // Live collab is etebase-gated: no session ⇒ no room.
    if !crate::auth::has_session(&app) {
        return Ok(None);
    }

    // Read just the local breadcrumbs we need: the note item UID, its optional
    // share scope, and the cached vault notes-collection UID. The actual key
    // lives only on the etebase server now; we resolve it on demand below.
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
                    params![KIND_NOTES],
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
    // closure returns just the encoded key + room id so no etebase-
    // owned value escapes the blocking pool.
    let app_for_blocking = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<RoomInfo>, String> {
        catch_blocking_panic("room_info", || {
            let writer_public_key_b64 = writer_public_key_b64
                .map(|key| key.trim().to_string())
                .filter(|key| valid_collab_writer_public_key(key));
            let username = crate::auth::read_session_info(&app_for_blocking)
                .ok()
                .flatten()
                .map(|info| info.username);
            let account = match crate::auth::try_restore(&app_for_blocking)
                .map_err(|e| format!("restore session: {e}"))?
            {
                Some(a) => a,
                None => return Ok(None),
            };
            let cm = account
                .collection_manager()
                .map_err(|e| format!("collection_manager: {e}"))?;
            let (col_uid, scope_collab) = match share_scope_id.as_deref() {
                Some(scope_id) => {
                    let scope_collab = match share_scope_collab_info(&cm, scope_id)
                        .map_err(|e| format!("share scope collab info: {e}"))?
                    {
                        Some(info) => info,
                        None => return Ok(None),
                    };
                    (
                        scope_collab.notes_collection_uid.clone(),
                        Some(scope_collab),
                    )
                }
                None => {
                    let Some(col_uid) = vault_col_uid else {
                        return Ok(None);
                    };
                    (col_uid, None)
                }
            };
            let scope_id_for_auth = share_scope_id.clone();
            let col = match cm.fetch(&col_uid, None) {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("[room_info] fetch notes collection failed: {e}");
                    return Ok(None);
                }
            };
            if !can_receive_live_collab_room(col.access_level(), scope_collab.is_some()) {
                return Ok(None);
            }
            let im = cm
                .item_manager(&col)
                .map_err(|e| format!("item_manager: {e}"))?;
            let item = match im.fetch(&note_uid, None) {
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
            if payload.crypto_key.is_empty() {
                // Legacy v1 payload, or a peer pushed before live collab was
                // wired up. Surface as "no room available" rather than
                // encoding zero bytes.
                return Ok(None);
            }
            let mut room =
                derive_live_collab_room(&note_uid, &payload.crypto_key, scope_collab.as_ref())?;
            if let (Some(scope_id), Some(scope)) =
                (scope_id_for_auth.as_deref(), scope_collab.as_ref())
            {
                let mut authorized_writers = Vec::new();
                match cm.fetch(&scope.assets_collection_uid, None) {
                    Ok(assets_col) => {
                        match cm.item_manager(&assets_col) {
                            Ok(assets_im) => {
                                let writable = !matches!(
                                    assets_col.access_level(),
                                    CollectionAccessLevel::ReadOnly
                                );
                                if writable {
                                    if let Some(key) = writer_public_key_b64.as_deref() {
                                        if let Err(e) = publish_collab_writer_key(
                                            &assets_im,
                                            scope_id,
                                            scope.collab_epoch,
                                            key,
                                            username.as_deref(),
                                        ) {
                                            log::warn!(
                                                "[room_info] publish writer key for scope {scope_id} failed: {e}"
                                            );
                                        }
                                    }
                                }
                                let writable_usernames =
                                    match writable_member_usernames(&assets_col, &cm) {
                                        Ok(usernames) => usernames,
                                        Err(e) => {
                                            log::warn!(
                                                "[room_info] list writable members for scope {scope_id} failed: {e}"
                                            );
                                            HashSet::new()
                                        }
                                    };
                                match list_collab_writer_keys(
                                    &assets_im,
                                    scope_id,
                                    scope.collab_epoch,
                                ) {
                                    Ok(keys) => {
                                        authorized_writers = filter_writable_collab_writers(
                                            keys,
                                            &writable_usernames,
                                        );
                                    }
                                    Err(e) => log::warn!(
                                        "[room_info] list writer keys for scope {scope_id} failed: {e}"
                                    ),
                                }
                            }
                            Err(e) => {
                                log::warn!("[room_info] item_manager(scope assets): {e}");
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("[room_info] fetch scope assets collection failed: {e}");
                    }
                }
                room.writer_auth = Some(RoomWriterAuth {
                    authorized_writers,
                });
            }
            Ok(Some(room))
        })
    })
    .await
    .map_err(|e| format!("note_room_info task: {e}"))?
}
