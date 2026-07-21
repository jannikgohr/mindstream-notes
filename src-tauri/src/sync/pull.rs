//! Pull half of the sync loop: fetch remote items by stoken and apply
//! them to SQLite.
//!
//! Each `pull_*` entry point wraps a `pull_*_once` pass so a `bad_stoken`
//! can be retried from scratch. The `apply_*` functions are the actual
//! merge logic — CRDT merges for notes, last-write-wins for the rest —
//! and are what the unit tests in `tests.rs` exercise directly.

use super::*;

// ---------- Pull ----------

pub(super) fn pull_folders(db: &Db, im: &ItemManager, report: &mut SyncReport) -> AppResult<()> {
    // Outer retry handles `bad_stoken`: if the etebase server rejects
    // our cached cursor (because the user logged into a different
    // account, or the collection was rebuilt server-side), clear the
    // stoken and replay the whole pull from scratch. One retry is
    // enough — if it still fails after we've reset to None, the
    // server is unhappy about something else and we bubble it up.
    let mut already_retried = false;
    loop {
        match pull_folders_once(db, im, report) {
            Ok(()) => return Ok(()),
            Err(err) if !already_retried && is_bad_stoken_error(&err) => {
                log::warn!(
                    "[sync] bad_stoken on folders pull — resetting cursor and retrying ({err})"
                );
                save_stoken(db, KIND_FOLDERS, None)?;
                already_retried = true;
                continue;
            }
            Err(err) => return Err(err),
        }
    }
}

pub(super) fn pull_folders_once(
    db: &Db,
    im: &ItemManager,
    report: &mut SyncReport,
) -> AppResult<()> {
    let stoken = load_stoken(db, KIND_FOLDERS)?;
    let mut new_stoken = stoken.clone();
    let mut iter_token: Option<String> = None;
    // Buffer of payloads we applied this pull so the repair pass below
    // can re-link any folder we had to orphan to root because its
    // parent hadn't been pulled yet. Etebase doesn't guarantee
    // parent-before-child ordering in the list response, so this is
    // the common case for nested hierarchies on a fresh install.
    let mut applied: Vec<FolderPayload> = Vec::new();
    loop {
        let mut opts = FetchOptions::new();
        opts = opts.stoken(new_stoken.as_deref());
        if let Some(it) = &iter_token {
            opts = opts.iterator(Some(it.as_str()));
        }
        let resp = im
            .list(Some(&opts))
            .map_err(|e| AppError::InvalidArg(format!("list folders: {e}")))?;
        for item in resp.data() {
            match apply_folder(db, item, None, true) {
                Ok(Some(payload)) => applied.push(payload),
                Ok(None) => {}
                Err(err) if is_corrupt_remote_content(&err) => {
                    if mark_local_by_remote_uid_dirty(db, KIND_FOLDERS, item.uid())? {
                        log::warn!(
                            "[sync] marked local folder item {} dirty for remote repair",
                            item.uid()
                        );
                    } else {
                        log::error!(
                            "[sync] corrupt remote folder item {} has no local copy — manual recovery required",
                            item.uid()
                        );
                    }
                    log::error!(
                        "[sync] skipping corrupt remote folder item {}: {err}",
                        item.uid()
                    );
                }
                Err(err) => return Err(err),
            }
            report.folders_pulled += 1;
        }
        new_stoken = resp.stoken().map(str::to_string).or(new_stoken);
        if resp.done() {
            break;
        }
        iter_token = None; // server uses stoken paging via response
    }
    repair_folder_parents(db, &applied)?;
    if new_stoken != stoken {
        save_stoken(db, KIND_FOLDERS, new_stoken.as_deref())?;
    }
    Ok(())
}

pub(super) fn pull_notes(
    db: &Db,
    im: &ItemManager,
    report: &mut SyncReport,
    applied_ids: &mut Vec<String>,
) -> AppResult<()> {
    // Same bad_stoken self-heal pattern as pull_folders — see the
    // comment there.
    let mut already_retried = false;
    loop {
        match pull_notes_once(db, im, report, applied_ids) {
            Ok(()) => return Ok(()),
            Err(err) if !already_retried && is_bad_stoken_error(&err) => {
                log::warn!(
                    "[sync] bad_stoken on notes pull — resetting cursor and retrying ({err})"
                );
                save_stoken(db, KIND_NOTES, None)?;
                already_retried = true;
                continue;
            }
            Err(err) => return Err(err),
        }
    }
}

pub(super) fn pull_notes_once(
    db: &Db,
    im: &ItemManager,
    report: &mut SyncReport,
    applied_ids: &mut Vec<String>,
) -> AppResult<()> {
    let stoken = load_stoken(db, KIND_NOTES)?;
    let mut new_stoken = stoken.clone();
    loop {
        let mut opts = FetchOptions::new();
        opts = opts.stoken(new_stoken.as_deref());
        let resp = im
            .list(Some(&opts))
            .map_err(|e| AppError::InvalidArg(format!("list notes: {e}")))?;
        for item in resp.data() {
            match apply_note(db, item, None, true) {
                Ok(Some(id)) => applied_ids.push(id),
                Ok(None) => {}
                Err(err) if is_corrupt_remote_content(&err) => {
                    if mark_local_by_remote_uid_dirty(db, KIND_NOTES, item.uid())? {
                        log::warn!(
                            "[sync] marked local note item {} dirty for remote repair",
                            item.uid()
                        );
                    } else {
                        log::error!(
                            "[sync] corrupt remote note item {} has no local copy — manual recovery required",
                            item.uid()
                        );
                    }
                    log::error!(
                        "[sync] skipping corrupt remote note item {}: {err}",
                        item.uid()
                    );
                }
                Err(err) => return Err(err),
            }
            report.notes_pulled += 1;
        }
        new_stoken = resp.stoken().map(str::to_string).or(new_stoken);
        if resp.done() {
            break;
        }
    }
    if new_stoken != stoken {
        save_stoken(db, KIND_NOTES, new_stoken.as_deref())?;
    }
    Ok(())
}

/// Pull drawing-asset items from the assets collection into local SQLite.
///
/// Mirrors pull_notes: stoken-paged iteration, apply_asset per item. The
/// one extra wrinkle is that an asset row carries a FK to its owning
/// note — if the note isn't local yet (a race window where the note was
/// created on the remote between our notes pull and this assets pull),
/// apply_asset returns "orphaned" and we set `had_orphans` so we don't
/// advance the stoken. Next sync's notes pull picks up the missing
/// note, then this re-runs from the same stoken and the previously-
/// orphaned assets land cleanly.
pub(super) fn pull_assets(
    db: &Db,
    im: &ItemManager,
    report: &mut SyncReport,
    applied_ids: &mut Vec<String>,
) -> AppResult<()> {
    // Same bad_stoken self-heal pattern as pull_folders.
    let mut already_retried = false;
    loop {
        match pull_assets_once(db, im, report, applied_ids) {
            Ok(()) => return Ok(()),
            Err(err) if !already_retried && is_bad_stoken_error(&err) => {
                log::warn!(
                    "[sync] bad_stoken on assets pull — resetting cursor and retrying ({err})"
                );
                save_stoken(db, KIND_ASSETS, None)?;
                already_retried = true;
                continue;
            }
            Err(err) => return Err(err),
        }
    }
}

pub(super) fn pull_assets_once(
    db: &Db,
    im: &ItemManager,
    report: &mut SyncReport,
    applied_ids: &mut Vec<String>,
) -> AppResult<()> {
    let stoken = load_stoken(db, KIND_ASSETS)?;
    let mut new_stoken = stoken.clone();
    let mut had_orphans = false;
    loop {
        let mut opts = FetchOptions::new();
        opts = opts.stoken(new_stoken.as_deref());
        let resp = im
            .list(Some(&opts))
            .map_err(|e| AppError::InvalidArg(format!("list assets: {e}")))?;
        for item in resp.data() {
            match apply_asset(db, item, None) {
                Ok(ApplyAssetOutcome::Applied(id)) => {
                    report.assets_pulled += 1;
                    applied_ids.push(id);
                }
                Ok(ApplyAssetOutcome::Orphaned) => {
                    had_orphans = true;
                }
                Ok(ApplyAssetOutcome::Skipped) => {}
                Err(err) if is_corrupt_remote_content(&err) => {
                    if mark_local_by_remote_uid_dirty(db, KIND_ASSETS, item.uid())? {
                        log::warn!(
                            "[sync] marked local asset item {} dirty for remote repair",
                            item.uid()
                        );
                    } else {
                        log::error!(
                            "[sync] corrupt remote asset item {} has no local copy — manual recovery required",
                            item.uid()
                        );
                    }
                    log::error!(
                        "[sync] skipping corrupt remote asset item {}: {err}",
                        item.uid()
                    );
                }
                Err(err) => return Err(err),
            }
        }
        new_stoken = resp.stoken().map(str::to_string).or(new_stoken);
        if resp.done() {
            break;
        }
    }
    if !had_orphans && new_stoken != stoken {
        save_stoken(db, KIND_ASSETS, new_stoken.as_deref())?;
    }
    Ok(())
}

pub(super) enum ApplyAssetOutcome {
    /// Row was written (insert or update). Carries the asset id so the
    /// caller can emit a `sync-completed` event listing what changed —
    /// open editors evict their cached blob URL and re-resolve so
    /// freshly-arrived bytes paint on the open canvas / image instead
    /// of staying broken until the user reopens the note.
    Applied(String),
    /// Asset references a note we don't have yet — keep the stoken at
    /// its previous value so the next sync retries.
    Orphaned,
    /// Delete tombstone or missing-content item — nothing to do, but no
    /// reason to pin the stoken.
    Skipped,
}

pub(super) fn item_type(item: &Item) -> Option<String> {
    item.meta()
        .ok()
        .and_then(|meta| meta.item_type().map(str::to_string))
}

/// Apply one pulled asset item to local SQLite. Returns the outcome so
/// the caller can decide whether to advance the stoken (orphans pin it).
pub(super) fn apply_asset(
    db: &Db,
    item: &Item,
    scope: Option<&str>,
) -> AppResult<ApplyAssetOutcome> {
    if item_type(item)
        .as_deref()
        .is_some_and(|kind| kind != ITEM_TYPE_ASSET)
    {
        return Ok(ApplyAssetOutcome::Skipped);
    }
    if item.is_deleted() {
        db.with_conn(|c| apply_remote_delete(c, "assets", item.uid()))?;
        return Ok(ApplyAssetOutcome::Skipped);
    }
    if item.is_missing_content() {
        return Ok(ApplyAssetOutcome::Skipped);
    }
    let raw = item
        .content()
        .map_err(|e| AppError::InvalidArg(format!("asset content: {e}")))?;
    let payload: AssetPayload = rmp_serde::from_slice(&raw)
        .map_err(|e| AppError::InvalidArg(format!("asset msgpack: {e}")))?;
    let etag = item.etag().to_string();
    let uid = item.uid().to_string();

    db.with_conn_mut(|c| {
        let tx = c.transaction()?;

        // FK gate: skip orphan assets rather than aborting the whole
        // pull. The orphan flag in pull_assets keeps the stoken pinned
        // so we retry on the next sync after the missing note arrives.
        let note_exists: bool = tx
            .query_row(
                "SELECT 1 FROM notes WHERE id = ?1",
                params![payload.owning_note_id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !note_exists {
            log::debug!(
                "[sync] asset {} references missing note {}; deferring",
                payload.id,
                payload.owning_note_id
            );
            tx.commit()?;
            return Ok(ApplyAssetOutcome::Orphaned);
        }

        let exists = tx
            .query_row(
                "SELECT 1 FROM assets WHERE id = ?1",
                params![payload.id],
                |_| Ok(true),
            )
            .optional()?
            .is_some();

        if exists {
            // Asset rows are big blobs, not CRDTs — no merge to do.
            // Last-write-wins: take the remote bytes verbatim and
            // clear dirty so we don't immediately re-push.
            tx.execute(
                "UPDATE assets
                 SET owning_note_id = ?1, mime_type = ?2, bytes = ?3,
                     size = ?4, modified = ?5, etebase_uid = ?6,
                     etebase_etag = ?7, dirty = 0, share_scope_id = ?8
                 WHERE id = ?9",
                params![
                    payload.owning_note_id,
                    payload.mime_type,
                    payload.bytes,
                    payload.size,
                    payload.modified,
                    uid,
                    etag,
                    scope,
                    payload.id,
                ],
            )?;
        } else {
            tx.execute(
                "INSERT INTO assets(id, owning_note_id, mime_type, bytes,
                                    size, created, modified, etebase_uid,
                                    etebase_etag, dirty, share_scope_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10)",
                params![
                    payload.id,
                    payload.owning_note_id,
                    payload.mime_type,
                    payload.bytes,
                    payload.size,
                    payload.created,
                    payload.modified,
                    uid,
                    etag,
                    scope,
                ],
            )?;
        }
        tx.commit()?;
        Ok(ApplyAssetOutcome::Applied(payload.id))
    })
}

// ---------- Signatures pull ----------

pub(super) fn pull_signatures(db: &Db, im: &ItemManager, report: &mut SyncReport) -> AppResult<()> {
    // Same bad_stoken self-heal pattern as pull_folders / pull_assets.
    let mut already_retried = false;
    loop {
        match pull_signatures_once(db, im, report) {
            Ok(()) => return Ok(()),
            Err(err) if !already_retried && is_bad_stoken_error(&err) => {
                log::warn!(
                    "[sync] bad_stoken on signatures pull — resetting cursor and retrying ({err})"
                );
                save_stoken(db, KIND_SIGNATURES, None)?;
                already_retried = true;
                continue;
            }
            Err(err) => return Err(err),
        }
    }
}

pub(super) fn pull_signatures_once(
    db: &Db,
    im: &ItemManager,
    report: &mut SyncReport,
) -> AppResult<()> {
    let stoken = load_stoken(db, KIND_SIGNATURES)?;
    let mut new_stoken = stoken.clone();
    loop {
        let mut opts = FetchOptions::new();
        opts = opts.stoken(new_stoken.as_deref());
        let resp = im
            .list(Some(&opts))
            .map_err(|e| AppError::InvalidArg(format!("list signatures: {e}")))?;
        for item in resp.data() {
            match apply_signature(db, item) {
                Ok(true) => report.signatures_pulled += 1,
                Ok(false) => {}
                Err(err) if is_corrupt_remote_content(&err) => {
                    if mark_local_by_remote_uid_dirty(db, KIND_SIGNATURES, item.uid())? {
                        log::warn!(
                            "[sync] marked local signature item {} dirty for remote repair",
                            item.uid()
                        );
                    } else {
                        log::error!(
                            "[sync] corrupt remote signature item {} has no local copy — manual recovery required",
                            item.uid()
                        );
                    }
                    log::error!(
                        "[sync] skipping corrupt remote signature item {}: {err}",
                        item.uid()
                    );
                }
                Err(err) => return Err(err),
            }
        }
        new_stoken = resp.stoken().map(str::to_string).or(new_stoken);
        if resp.done() {
            break;
        }
    }
    if new_stoken != stoken {
        save_stoken(db, KIND_SIGNATURES, new_stoken.as_deref())?;
    }
    Ok(())
}

/// Apply one pulled signature item to local SQLite. Returns `true` when a
/// row was inserted/updated (so the caller can bump the pulled counter),
/// `false` for deletes and missing-content items. No FK gate — signatures
/// are user-global, so there's nothing to orphan against.
pub(super) fn apply_signature(db: &Db, item: &Item) -> AppResult<bool> {
    if item.is_deleted() {
        db.with_conn(|c| {
            c.execute(
                "DELETE FROM signatures WHERE etebase_uid = ?1",
                params![item.uid()],
            )?;
            Ok(())
        })?;
        return Ok(false);
    }
    if item.is_missing_content() {
        return Ok(false);
    }
    let raw = item
        .content()
        .map_err(|e| AppError::InvalidArg(format!("signature content: {e}")))?;
    let payload: SignaturePayload = rmp_serde::from_slice(&raw)
        .map_err(|e| AppError::InvalidArg(format!("signature msgpack: {e}")))?;
    let etag = item.etag().to_string();
    let uid = item.uid().to_string();

    db.with_conn_mut(|c| {
        let tx = c.transaction()?;
        let exists = tx
            .query_row(
                "SELECT 1 FROM signatures WHERE id = ?1",
                params![payload.id],
                |_| Ok(true),
            )
            .optional()?
            .is_some();
        if exists {
            // Geometry blob, not a CRDT — last-write-wins on the remote copy.
            tx.execute(
                "UPDATE signatures
                 SET data = ?1, modified = ?2, etebase_uid = ?3,
                     etebase_etag = ?4, dirty = 0
                 WHERE id = ?5",
                params![payload.data, payload.modified, uid, etag, payload.id],
            )?;
        } else {
            tx.execute(
                "INSERT INTO signatures(id, data, created, modified,
                                        etebase_uid, etebase_etag, dirty)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
                params![
                    payload.id,
                    payload.data,
                    payload.created,
                    payload.modified,
                    uid,
                    etag,
                ],
            )?;
        }
        tx.commit()?;
        Ok(true)
    })
}

/// Apply one pulled folder item to the local DB.
///
/// Returns `Some(payload)` if we wrote a row (so `pull_folders` can
/// queue it for the repair pass), `None` for deletes and missing-
/// content items where there's nothing to re-link.
pub(super) fn apply_folder(
    db: &Db,
    item: &Item,
    scope: Option<&str>,
    preserve_dirty_local_edits: bool,
) -> AppResult<Option<FolderPayload>> {
    if item.is_deleted() {
        // Server-side delete: drop our row if we have one matched by uid,
        // unless it has unpushed edits — see `apply_remote_delete`.
        db.with_conn(|c| apply_remote_delete(c, "collections", item.uid()))?;
        return Ok(None);
    }
    if item.is_missing_content() {
        return Ok(None);
    }
    let raw = item
        .content()
        .map_err(|e| AppError::InvalidArg(format!("folder content: {e}")))?;
    let payload: FolderPayload = rmp_serde::from_slice(&raw)
        .map_err(|e| AppError::InvalidArg(format!("folder msgpack: {e}")))?;
    let etag = item.etag().to_string();
    apply_folder_payload(
        db,
        payload,
        item.uid(),
        &etag,
        scope,
        preserve_dirty_local_edits,
    )
}

/// Apply a decoded folder payload to local SQLite. Split out from
/// `apply_folder` so the local-vs-remote metadata logic can be unit-tested
/// without constructing an etebase `Item`.
pub(super) fn apply_folder_payload(
    db: &Db,
    payload: FolderPayload,
    uid: &str,
    etag: &str,
    scope: Option<&str>,
    preserve_dirty_local_edits: bool,
) -> AppResult<Option<FolderPayload>> {
    let now = Utc::now().to_rfc3339();

    // Folder metadata (parent / name / position) is last-write-wins, not a
    // CRDT. When the local row has unpushed edits (dirty), a pull must NOT
    // overwrite that metadata with the remote's older copy — otherwise an
    // offline rename / move / reorder silently reverts. Mirrors the note
    // metadata-preservation path in `apply_note_payload`.
    let existing: Option<(i64, String, String)> = db.with_conn(|c| {
        Ok(c.query_row(
            "SELECT dirty, created, modified FROM collections WHERE id = ?1",
            params![payload.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?)
    })?;
    let keep_local_meta =
        preserve_dirty_local_edits && matches!(existing, Some((dirty, _, _)) if dirty != 0);
    let remote_created = payload
        .created
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or(&now);
    let remote_modified = payload
        .modified
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            existing
                .as_ref()
                .map(|(_, _, modified)| modified.as_str())
                .unwrap_or(&now)
        });

    db.with_conn(|c| {
        // Defensive: if the payload's parent folder isn't in collections
        // yet (subfolder arrived before its parent in this pull, or the
        // server orphaned it), store NULL for now. `repair_folder_parents`
        // re-links us once the parent lands later in the same pull.
        // Without this, the INSERT would hit a FOREIGN KEY violation and
        // abort the entire sync.
        let resolved_parent = resolve_parent_id(c, payload.parent_folder_id.as_deref())?;
        match existing {
            Some(_) if keep_local_meta => {
                // Keep the local metadata; only (re)stamp the server identity
                // and scope, forcing dirty=1 so the next push reconciles. This
                // is what makes an offline rename survive a re-home: the row is
                // reclaimed into its scope without losing the local name.
                c.execute(
                    "UPDATE collections
                     SET etebase_uid = ?1, etebase_etag = ?2, dirty = 1, share_scope_id = ?3
                     WHERE id = ?4",
                    params![uid, etag, scope, payload.id],
                )?;
            }
            Some(_) => {
                c.execute(
                    "UPDATE collections
                     SET parent_collection_id = ?1, name = ?2, position = ?3,
                         created = ?4, modified = ?5, etebase_uid = ?6,
                         etebase_etag = ?7, dirty = 0, share_scope_id = ?8
                     WHERE id = ?9",
                    params![
                        resolved_parent,
                        payload.name,
                        payload.position,
                        remote_created,
                        remote_modified,
                        uid,
                        etag,
                        scope,
                        payload.id,
                    ],
                )?;
            }
            None => {
                c.execute(
                    "INSERT INTO collections (id, parent_collection_id, name, position,
                                               created, modified, etebase_uid, etebase_etag, dirty,
                                               share_scope_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9)",
                    params![
                        payload.id,
                        resolved_parent,
                        payload.name,
                        payload.position,
                        remote_created,
                        remote_modified,
                        uid,
                        etag,
                        scope,
                    ],
                )?;
            }
        }
        Ok(())
    })?;

    // When we preserved local metadata, the local parent is authoritative —
    // return None so `repair_folder_parents` won't reattach it from the remote
    // payload (a folder moved to root offline must stay at root).
    if keep_local_meta {
        Ok(None)
    } else {
        Ok(Some(payload))
    }
}

/// Returns the parent id unchanged if a collection with that id exists
/// locally, or `None` if it's missing — used by `apply_folder`/`apply_note`
/// during pull so a dangling `parent_folder_id` on the server doesn't
/// abort the sync with `FOREIGN KEY constraint failed`. The original
/// payload value is preserved by `pull_folders` so the repair pass can
/// reattach folders once the parent arrives.
pub(super) fn resolve_parent_id(
    conn: &Connection,
    parent: Option<&str>,
) -> rusqlite::Result<Option<String>> {
    let Some(p) = parent else {
        return Ok(None);
    };
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM collections WHERE id = ?1",
            params![p],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if exists {
        Ok(Some(p.to_string()))
    } else {
        log::warn!("[sync] parent collection {p} not present locally; orphaning to root");
        Ok(None)
    }
}

/// After all folders in this pull have been applied, walk the buffered
/// payloads and reattach any row we had to nullify because its parent
/// wasn't yet known. We only touch rows whose parent is currently NULL
/// to avoid clobbering a user-initiated move that ran concurrently —
/// since folder upserts in this pull set parent to NULL only when the
/// parent was missing at apply time, NULL here unambiguously means
/// "we orphaned this one".
pub(super) fn repair_folder_parents(db: &Db, applied: &[FolderPayload]) -> AppResult<()> {
    if applied.is_empty() {
        return Ok(());
    }
    db.with_conn_mut(|c| {
        let tx = c.transaction()?;
        for p in applied {
            let Some(parent) = &p.parent_folder_id else {
                continue;
            };
            tx.execute(
                "UPDATE collections SET parent_collection_id = ?1
                 WHERE id = ?2
                   AND parent_collection_id IS NULL
                   AND EXISTS (SELECT 1 FROM collections WHERE id = ?1)",
                params![parent, p.id],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
}

/// Local note fields read before applying a pulled item: yrs_state + schema
/// drive the CRDT body merge, and the rest is the last-write-wins metadata we
/// must preserve when the row is locally dirty so a pull can't clobber an
/// unpushed trash / move / rename / favourite change.
pub(super) struct LocalNoteState {
    pub(super) yrs_state: Vec<u8>,
    pub(super) dirty: i64,
    pub(super) schema: i64,
    pub(super) created: String,
    pub(super) modified: String,
    pub(super) parent_collection_id: Option<String>,
    pub(super) trashed_at: Option<String>,
    pub(super) title: String,
    pub(super) body: String,
    pub(super) position: i64,
    pub(super) favourite: i64,
    pub(super) note_kind: String,
    pub(super) tags_state: Vec<u8>,
}

/// Apply one pulled note item. Returns Some(note_id) when a row was
/// written (insert or update) so the caller can include it in the
/// `sync-completed` event payload — open editors merge the new
/// yrs_state into their live Y.Doc instead of going stale. Returns None
/// for deletes (no live editor to refresh) and missing-content items.
pub(super) fn apply_note(
    db: &Db,
    item: &Item,
    scope: Option<&str>,
    preserve_dirty_local_edits: bool,
) -> AppResult<Option<String>> {
    if item.is_deleted() {
        db.with_conn(|c| apply_remote_delete(c, "notes", item.uid()))?;
        return Ok(None);
    }
    if item.is_missing_content() {
        return Ok(None);
    }
    let raw = item
        .content()
        .map_err(|e| AppError::InvalidArg(format!("note content: {e}")))?;
    let payload: NotePayload = rmp_serde::from_slice(&raw)
        .map_err(|e| AppError::InvalidArg(format!("note msgpack: {e}")))?;
    let etag = item.etag().to_string();
    apply_note_payload(
        db,
        &payload,
        item.uid(),
        &etag,
        scope,
        preserve_dirty_local_edits,
    )
}

/// Apply a decoded note payload to local SQLite. Split out from `apply_note`
/// so the local-vs-remote metadata logic can be unit-tested without
/// constructing an etebase `Item`.
pub(super) fn apply_note_payload(
    db: &Db,
    payload: &NotePayload,
    uid: &str,
    etag: &str,
    scope: Option<&str>,
    preserve_dirty_local_edits: bool,
) -> AppResult<Option<String>> {
    db.with_conn_mut(|c| {
        let tx = c.transaction()?;

        // Existing local row, if any. We need yrs_state + schema to merge the
        // body, plus the LWW metadata to preserve when the row is dirty.
        let existing: Option<LocalNoteState> = tx
            .query_row(
                "SELECT yrs_state, dirty, payload_schema, created, modified,
                        parent_collection_id, trashed_at, title, body, position,
                        favourite, note_kind, tags_state
                 FROM notes WHERE id = ?1",
                params![payload.id],
                |r| {
                    Ok(LocalNoteState {
                        yrs_state: r.get::<_, Option<Vec<u8>>>(0)?.unwrap_or_default(),
                        dirty: r.get(1)?,
                        schema: r.get(2)?,
                        created: r.get(3)?,
                        modified: r.get(4)?,
                        parent_collection_id: r.get(5)?,
                        trashed_at: r.get(6)?,
                        title: r.get(7)?,
                        body: r.get(8)?,
                        position: r.get(9)?,
                        favourite: r.get(10)?,
                        note_kind: r.get(11)?,
                        tags_state: r.get::<_, Option<Vec<u8>>>(12)?.unwrap_or_default(),
                    })
                },
            )
            .optional()?;
        let local_tags = if existing.is_some() {
            load_tags_for_note(&tx, &payload.id)?
        } else {
            Vec::new()
        };

        let incoming_schema = payload.schema as i64;
        let remote_authoritative = !preserve_dirty_local_edits;
        let (merged_state, dirty_after) = match &existing {
            // View-only/read-only shares must discard any local state. Those
            // local edits should be impossible in the UI; if they appear, the
            // server copy is the only source we are allowed to keep.
            Some(_) if remote_authoritative => (payload.yrs_state.clone(), 0),
            // Same-schema CRDT merge: this is the common case once both
            // devices are on the same payload version.
            Some(local) if !local.yrs_state.is_empty() && local.schema == incoming_schema => {
                let merged = yrs_doc::merge_remote(&local.yrs_state, &payload.yrs_state);
                // If we had unpushed local edits, the merge contains both sides —
                // keep dirty=1 so the next push uploads the merged state and lets
                // the *server* converge with anyone else's offline edits.
                (merged, local.dirty)
            }
            // Either no local state, or the schema changed under us
            // (legacy v1 row got a v2 push from another device, or vice
            // versa). Take the remote bytes wholesale — yrs can't merge
            // across formats. Local body becomes whatever the new schema
            // dictates below.
            _ => (payload.yrs_state.clone(), 0),
        };

        // Metadata (parent / trashed_at / title / position / favourite /
        // note_kind) is last-write-wins, not a CRDT. When the local row has
        // unpushed changes (dirty), a pull must NOT overwrite that metadata
        // with the remote's older copy — otherwise a note trashed (or moved /
        // renamed) locally but not yet pushed silently reverts on the next
        // pull, e.g. the full re-pull triggered by a bad_stoken reset. Keep
        // the local metadata and force dirty=1 so the next push reconciles the
        // server. The body above is still CRDT-merged regardless.
        let keep_local_meta =
            preserve_dirty_local_edits && existing.as_ref().is_some_and(|l| l.dirty != 0);
        // For v2 payloads the remote ships the rendered markdown alongside
        // the prosemirror state — Rust can't render markdown from XmlFragment.
        // If this row has unpushed local edits, keep the local rendered body
        // through the pull-before-push cycle; otherwise the next push would
        // upload the stale remote body even though the merged Yjs state still
        // contains the local edit. For v1 we still have the Rust-side Y.Text →
        // markdown helper.
        let body = if payload.schema >= 2 {
            if keep_local_meta {
                existing
                    .as_ref()
                    .map(|local| local.body.clone())
                    .unwrap_or_else(|| payload.body.clone())
            } else {
                payload.body.clone()
            }
        } else {
            yrs_doc::to_markdown(&merged_state)
        };
        // payload.crypto_key is intentionally ignored on pull — the
        // crypto_key column no longer exists locally. The editor fetches
        // the current key directly from the etebase Item each time it
        // opens a note (see note_room_info), so the server stays the
        // sole authority and nothing sensitive lands on disk.
        let now = Utc::now().to_rfc3339();
        let final_created = if keep_local_meta {
            existing
                .as_ref()
                .map(|l| l.created.clone())
                .unwrap_or_else(|| {
                    payload
                        .created
                        .clone()
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| now.clone())
                })
        } else {
            payload
                .created
                .clone()
                .filter(|value| !value.is_empty())
                .or_else(|| existing.as_ref().map(|l| l.created.clone()))
                .unwrap_or_else(|| now.clone())
        };
        let final_modified = if keep_local_meta {
            existing
                .as_ref()
                .map(|l| l.modified.clone())
                .unwrap_or_else(|| {
                    payload
                        .modified
                        .clone()
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| now.clone())
                })
        } else {
            payload
                .modified
                .clone()
                .filter(|value| !value.is_empty())
                .or_else(|| existing.as_ref().map(|l| l.modified.clone()))
                .unwrap_or_else(|| now.clone())
        };

        // Pick each metadata field from local (when dirty) or remote. For the
        // remote parent, resolve_parent_id does the defensive nullification of
        // a dangling reference (see its doc) so one bad parent can't abort the
        // pull with a FOREIGN KEY violation; a kept-local parent is already a
        // valid local id, so it needs no resolving.
        let final_parent = if keep_local_meta {
            existing
                .as_ref()
                .and_then(|l| l.parent_collection_id.clone())
        } else {
            resolve_parent_id(&tx, payload.parent_folder_id.as_deref())?
        };
        let final_title = if keep_local_meta {
            existing
                .as_ref()
                .map(|l| l.title.clone())
                .unwrap_or_default()
        } else {
            payload.title.clone()
        };
        let final_position = if keep_local_meta {
            existing.as_ref().map_or(0, |l| l.position)
        } else {
            payload.position
        };
        let final_trashed_at = if keep_local_meta {
            existing.as_ref().and_then(|l| l.trashed_at.clone())
        } else {
            payload.trashed_at.clone()
        };
        let final_favourite = if keep_local_meta {
            existing.as_ref().map_or(0, |l| l.favourite)
        } else {
            payload.favourite as i64
        };
        let final_note_kind = if keep_local_meta {
            existing
                .as_ref()
                .map(|l| l.note_kind.clone())
                .unwrap_or_default()
        } else {
            payload.note_kind.clone()
        };
        let (final_tags_state, final_tags) = if remote_authoritative {
            tags_crdt::merge_or_resolve(&[], &[], &payload.tags_state, &payload.tags, false)
        } else {
            match &existing {
            Some(local) => tags_crdt::merge_or_resolve(
                &local.tags_state,
                &local_tags,
                &payload.tags_state,
                &payload.tags,
                keep_local_meta,
            ),
            None => {
                tags_crdt::merge_or_resolve(&[], &[], &payload.tags_state, &payload.tags, false)
            }
            }
        };
        // Keep dirty=1 when we preserved local metadata so the next push sends
        // it to the server; otherwise follow the body-merge's dirty decision.
        let tags_need_push = payload.tags_state.is_empty() || final_tags != payload.tags;
        let final_dirty = if keep_local_meta || (preserve_dirty_local_edits && tags_need_push) {
            1
        } else {
            dirty_after
        };

        let exists = existing.is_some();
        if exists {
            tx.execute(
                "UPDATE notes
                 SET parent_collection_id = ?1, title = ?2, body = ?3, position = ?4,
                     created = ?5, modified = ?6, trashed_at = ?7, yrs_state = ?8,
                     etebase_uid = ?9, etebase_etag = ?10, dirty = ?11,
                     payload_schema = ?12, favourite = ?13, note_kind = ?14,
                     tags_state = ?15, share_scope_id = ?16
                 WHERE id = ?17",
                params![
                    final_parent,
                    final_title,
                    body,
                    final_position,
                    final_created,
                    final_modified,
                    final_trashed_at,
                    merged_state,
                    uid,
                    etag,
                    final_dirty,
                    incoming_schema,
                    final_favourite,
                    final_note_kind,
                    final_tags_state,
                    scope,
                    payload.id,
                ],
            )?;
        } else {
            tx.execute(
                "INSERT INTO notes (id, parent_collection_id, title, body, position,
                                    created, modified, trashed_at, yrs_state,
                                    etebase_uid, etebase_etag, dirty,
                                    payload_schema, favourite, note_kind, tags_state,
                                    share_scope_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
                params![
                    payload.id,
                    final_parent,
                    final_title,
                    body,
                    final_position,
                    final_created,
                    final_modified,
                    final_trashed_at,
                    merged_state,
                    uid,
                    etag,
                    final_dirty,
                    incoming_schema,
                    final_favourite,
                    final_note_kind,
                    final_tags_state,
                    scope,
                ],
            )?;
        }

        // Refresh the query-friendly projection from the CRDT-visible tags.
        tx.execute(
            "DELETE FROM note_tags WHERE note_id = ?1",
            params![payload.id],
        )?;
        let mut stmt = tx.prepare("INSERT INTO note_tags(note_id, tag) VALUES (?1, ?2)")?;
        for tag in &final_tags {
            stmt.execute(params![payload.id, tag])?;
        }
        drop(stmt);

        tx.commit()?;
        Ok(Some(payload.id.clone()))
    })
}
