//! One-shot recovery commands for items that the pre-fix etebase-rs
//! encoder corrupted via the chunk-dedup-index bug. These are NOT part
//! of normal sync — invoke them explicitly from the dev-tools console:
//!
//! ```js
//! await window.__TAURI__.core.invoke('audit_corrupt_remote_items')
//! await window.__TAURI__.core.invoke('purge_corrupt_remote_note', {
//!   etebaseUid: '<UID from audit>',
//!   noteId: '<logical note_... id, from the orphan log line>',
//! })
//! ```
//!
//! Purge is destructive: it tombstones the named note and every asset
//! whose `owning_note_id` matches, then pushes the tombstones. Once
//! pulled by other devices, those items are gone for good.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use etebase::managers::ItemManager;
use etebase::{Account, FetchOptions, Item};

use crate::auth;
use crate::db::Db;
use crate::error::{AppError, AppResult, CommandResult};

use super::{
    catch_blocking_panic, ensure_collection, load_share_scope_part_uids, scheduler,
    COLLECTION_TYPE_ASSETS, COLLECTION_TYPE_NOTES, KIND_ASSETS, KIND_NOTES,
};

#[derive(Debug, Default, Serialize, Clone)]
pub struct CorruptAudit {
    pub notes: Vec<CorruptItem>,
    pub assets: Vec<CorruptItem>,
}

#[derive(Debug, Serialize, Clone)]
pub struct CorruptItem {
    pub etebase_uid: String,
    pub error: String,
    /// True if the decode error matches the known chunk-index-out-of-range
    /// pattern from the pre-fix encoder bug; false for unrelated failures
    /// (bad MAC, missing content, parse errors, etc).
    pub chunk_index_bug: bool,
}

#[derive(Debug, Default, Serialize, Clone)]
pub struct PurgeReport {
    pub note_uid: String,
    pub note_was_already_deleted: bool,
    pub asset_uids_deleted: Vec<String>,
}

// Minimal mirror of the asset wire format — we only need the FK back to
// the note to decide which assets to tombstone. rmp-serde ignores
// unknown fields, so the rest of AssetPayload (bytes, mime, etc.) is
// silently dropped here.
#[derive(Debug, Deserialize)]
struct AssetPayloadLite {
    owning_note_id: String,
}

/// Walks every note + asset on the server, attempts `.content()` on
/// each, and reports any that fail. Read-only — safe to run any time.
#[tauri::command]
pub async fn audit_corrupt_remote_items(app: AppHandle) -> CommandResult<CorruptAudit> {
    let scheduler_state = app.state::<scheduler::SyncScheduler>();
    let _guard = scheduler_state.acquire_in_flight().await;
    let app_for_blocking = app.clone();
    Ok(
        tauri::async_runtime::spawn_blocking(move || -> Result<CorruptAudit, String> {
            catch_blocking_panic("audit", || {
                let account = auth::try_restore(&app_for_blocking)
                    .map_err(|e| format!("restore session: {e}"))?
                    .ok_or_else(|| "not signed in".to_string())?;
                let db = app_for_blocking.state::<Db>();
                audit_impl(&db, &account).map_err(|e| e.to_string())
            })
        })
        .await
        .map_err(|e| format!("audit task: {e}"))??,
    )
}

fn audit_impl(db: &Db, account: &Account) -> AppResult<CorruptAudit> {
    let cm = account
        .collection_manager()
        .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;
    let share_scope_part_uids = load_share_scope_part_uids(&cm);

    let mut audit = CorruptAudit::default();

    let notes_col = ensure_collection(
        db,
        &cm,
        KIND_NOTES,
        COLLECTION_TYPE_NOTES,
        &share_scope_part_uids,
    )?;
    let notes_im = cm
        .item_manager(&notes_col)
        .map_err(|e| AppError::InvalidArg(format!("item_manager(notes): {e}")))?;
    audit.notes = scan_corrupt(&notes_im, "notes")?;

    let assets_col = ensure_collection(
        db,
        &cm,
        KIND_ASSETS,
        COLLECTION_TYPE_ASSETS,
        &share_scope_part_uids,
    )?;
    let assets_im = cm
        .item_manager(&assets_col)
        .map_err(|e| AppError::InvalidArg(format!("item_manager(assets): {e}")))?;
    audit.assets = scan_corrupt(&assets_im, "assets")?;

    log::info!(
        "[repair] audit complete: {} corrupt note(s), {} corrupt asset(s)",
        audit.notes.len(),
        audit.assets.len(),
    );
    Ok(audit)
}

fn scan_corrupt(im: &ItemManager, kind: &str) -> AppResult<Vec<CorruptItem>> {
    let mut corrupt = Vec::new();
    let mut stoken: Option<String> = None;
    let mut page = 0usize;
    let mut total_seen = 0usize;
    let mut total_checked = 0usize;
    loop {
        let mut opts = FetchOptions::new();
        opts = opts.stoken(stoken.as_deref());
        let resp = im
            .list(Some(&opts))
            .map_err(|e| AppError::InvalidArg(format!("list {kind}: {e}")))?;
        let page_count = resp.data().len();
        log::info!(
            "[repair] {kind} page {} → {page_count} item(s), done={}, stoken={:?}",
            page,
            resp.done(),
            resp.stoken()
        );
        for item in resp.data() {
            total_seen += 1;
            if item.is_deleted() {
                log::debug!("[repair] {kind} {} skipped (deleted)", item.uid());
                continue;
            }
            // Refetch by UID so we get an owned item, then download any
            // missing chunks. List responses don't always inline chunk
            // payloads — and we need the full content to trigger the
            // bug we're looking for.
            let mut owned = match im.fetch(item.uid(), None) {
                Ok(o) => o,
                Err(e) => {
                    log::warn!("[repair] {kind} {} fetch failed: {e}", item.uid());
                    corrupt.push(CorruptItem {
                        etebase_uid: item.uid().to_string(),
                        error: format!("fetch failed: {e}"),
                        chunk_index_bug: false,
                    });
                    continue;
                }
            };
            if owned.is_deleted() {
                continue;
            }
            if owned.is_missing_content() {
                if let Err(e) = im.download_content(&mut owned) {
                    log::warn!(
                        "[repair] {kind} {} download_content failed: {e}",
                        owned.uid()
                    );
                    let error = e.to_string();
                    let chunk_index_bug = error.contains("Chunk index out of");
                    corrupt.push(CorruptItem {
                        etebase_uid: owned.uid().to_string(),
                        error,
                        chunk_index_bug,
                    });
                    continue;
                }
            }
            total_checked += 1;
            match owned.content() {
                Ok(_) => {
                    log::debug!("[repair] {kind} {} ok", owned.uid());
                }
                Err(e) => {
                    let error = e.to_string();
                    let chunk_index_bug = error.contains("Chunk index out of");
                    log::warn!(
                        "[repair] {kind} {} failed to decode ({}): {error}",
                        owned.uid(),
                        if chunk_index_bug {
                            "chunk-index bug"
                        } else {
                            "other"
                        }
                    );
                    corrupt.push(CorruptItem {
                        etebase_uid: owned.uid().to_string(),
                        error,
                        chunk_index_bug,
                    });
                }
            }
        }
        stoken = resp.stoken().map(str::to_string).or(stoken);
        page += 1;
        if resp.done() {
            break;
        }
    }
    log::info!(
        "[repair] {kind} scan finished: {total_seen} item(s) seen, {total_checked} content-checked, {} corrupt",
        corrupt.len()
    );
    Ok(corrupt)
}

/// Destructive. Tombstones the named note and every asset that
/// references it via `owning_note_id`. Refuses to delete a note whose
/// content decodes cleanly, so a typo in `etebaseUid` can't nuke a
/// healthy item.
#[tauri::command]
pub async fn purge_corrupt_remote_note(
    app: AppHandle,
    etebase_uid: String,
    note_id: String,
) -> CommandResult<PurgeReport> {
    let scheduler_state = app.state::<scheduler::SyncScheduler>();
    let _guard = scheduler_state.acquire_in_flight().await;
    let app_for_blocking = app.clone();
    Ok(
        tauri::async_runtime::spawn_blocking(move || -> Result<PurgeReport, String> {
            catch_blocking_panic("purge", || {
                let account = auth::try_restore(&app_for_blocking)
                    .map_err(|e| format!("restore session: {e}"))?
                    .ok_or_else(|| "not signed in".to_string())?;
                let db = app_for_blocking.state::<Db>();
                purge_impl(&db, &account, &etebase_uid, &note_id).map_err(|e| e.to_string())
            })
        })
        .await
        .map_err(|e| format!("purge task: {e}"))??,
    )
}

fn purge_impl(
    db: &Db,
    account: &Account,
    etebase_uid: &str,
    note_id: &str,
) -> AppResult<PurgeReport> {
    let cm = account
        .collection_manager()
        .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;
    let share_scope_part_uids = load_share_scope_part_uids(&cm);

    // --- Note: verify corrupt, then tombstone. ---
    let notes_col = ensure_collection(
        db,
        &cm,
        KIND_NOTES,
        COLLECTION_TYPE_NOTES,
        &share_scope_part_uids,
    )?;
    let notes_im = cm
        .item_manager(&notes_col)
        .map_err(|e| AppError::InvalidArg(format!("item_manager(notes): {e}")))?;

    let mut note_item = notes_im
        .fetch(etebase_uid, None)
        .map_err(|e| AppError::InvalidArg(format!("fetch note {etebase_uid}: {e}")))?;

    let note_was_already_deleted = note_item.is_deleted();
    if note_was_already_deleted {
        log::warn!(
            "[repair] note {etebase_uid} already deleted server-side; only the orphaned assets need cleanup"
        );
    } else {
        match note_item.content() {
            Ok(_) => {
                return Err(AppError::InvalidArg(format!(
                    "refusing to purge {etebase_uid}: content decoded cleanly (not corrupt)"
                )));
            }
            Err(e) => {
                let msg = e.to_string();
                if !msg.contains("Chunk index out of") {
                    return Err(AppError::InvalidArg(format!(
                        "refusing to purge {etebase_uid}: unexpected decode error \"{msg}\" (not the chunk-index bug)"
                    )));
                }
                log::warn!("[repair] confirmed {etebase_uid} corrupt: {msg}");
            }
        }
        note_item
            .delete()
            .map_err(|e| AppError::InvalidArg(format!("mark deleted {etebase_uid}: {e}")))?;
        let pending = [note_item];
        notes_im
            .transaction(pending.iter(), None)
            .map_err(|e| AppError::InvalidArg(format!("push note tombstone {etebase_uid}: {e}")))?;
        log::warn!("[repair] tombstoned corrupt note {etebase_uid}");
    }

    // --- Orphaned assets: scan to find matches, then tombstone in batch. ---
    let assets_col = ensure_collection(
        db,
        &cm,
        KIND_ASSETS,
        COLLECTION_TYPE_ASSETS,
        &share_scope_part_uids,
    )?;
    let assets_im = cm
        .item_manager(&assets_col)
        .map_err(|e| AppError::InvalidArg(format!("item_manager(assets): {e}")))?;

    let matching_uids = find_assets_for_note(&assets_im, note_id)?;

    let mut items: Vec<Item> = Vec::with_capacity(matching_uids.len());
    for uid in &matching_uids {
        let mut item = assets_im
            .fetch(uid, None)
            .map_err(|e| AppError::InvalidArg(format!("fetch asset {uid}: {e}")))?;
        if !item.is_deleted() {
            item.delete()
                .map_err(|e| AppError::InvalidArg(format!("mark deleted {uid}: {e}")))?;
        }
        items.push(item);
    }
    if !items.is_empty() {
        assets_im
            .transaction(items.iter(), None)
            .map_err(|e| AppError::InvalidArg(format!("push asset tombstones: {e}")))?;
        log::warn!(
            "[repair] tombstoned {} asset(s) orphaned by {note_id}",
            items.len()
        );
    } else {
        log::info!("[repair] no assets matched owning_note_id={note_id}");
    }

    Ok(PurgeReport {
        note_uid: etebase_uid.to_string(),
        note_was_already_deleted,
        asset_uids_deleted: matching_uids,
    })
}

fn find_assets_for_note(im: &ItemManager, note_id: &str) -> AppResult<Vec<String>> {
    let mut matching = Vec::new();
    let mut stoken: Option<String> = None;
    loop {
        let mut opts = FetchOptions::new();
        opts = opts.stoken(stoken.as_deref());
        let resp = im
            .list(Some(&opts))
            .map_err(|e| AppError::InvalidArg(format!("list assets: {e}")))?;
        for item in resp.data() {
            if item.is_deleted() {
                continue;
            }
            // Same refetch + download-content pattern as scan_corrupt:
            // list may inline payloads only partially.
            let mut owned = match im.fetch(item.uid(), None) {
                Ok(o) => o,
                Err(e) => {
                    log::warn!("[repair] asset {} fetch failed: {e}", item.uid());
                    continue;
                }
            };
            if owned.is_deleted() {
                continue;
            }
            if owned.is_missing_content() {
                if let Err(e) = im.download_content(&mut owned) {
                    log::warn!(
                        "[repair] asset {} download_content failed: {e}",
                        owned.uid()
                    );
                    continue;
                }
            }
            let bytes = match owned.content() {
                Ok(b) => b,
                Err(e) => {
                    log::warn!(
                        "[repair] skipping asset {} during scan (decode failed): {e}",
                        owned.uid()
                    );
                    continue;
                }
            };
            let payload: AssetPayloadLite = match rmp_serde::from_slice(&bytes) {
                Ok(p) => p,
                Err(e) => {
                    log::warn!(
                        "[repair] skipping asset {} during scan (bad payload): {e}",
                        owned.uid()
                    );
                    continue;
                }
            };
            if payload.owning_note_id == note_id {
                matching.push(owned.uid().to_string());
            }
        }
        stoken = resp.stoken().map(str::to_string).or(stoken);
        if resp.done() {
            break;
        }
    }
    Ok(matching)
}
