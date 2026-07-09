//! Per-scope sync.
//!
//! A shared folder scope (see `crate::sharing`) routes its folders, notes and
//! assets into three dedicated Etebase collections instead of the vault-wide
//! ones. Membership in the scope's `mindstream.share_manifest` collection is
//! how both the owner and every recipient discover the scope, so this walks the
//! manifest collections the account can see, decodes each, and pulls/pushes the
//! three part collections with `share_scope_id` routing.
//!
//! Scoped rows carry `share_scope_id` locally (migration 18); the vault
//! pull/push paths exclude them, and the loaders/appliers here supply the scope
//! so a row only ever lives in one collection ("one home").
//!
//! This whole module is best-effort: `sync_scopes` is called after the vault
//! sync and any error it returns is logged, never propagated, so a broken share
//! can't wedge the user's own vault sync.

use etebase::managers::CollectionManager;
use etebase::{Collection, FetchOptions};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sharing::{ShareManifest, ShareScopePart, COLLECTION_TYPE_SHARE_MANIFEST};

use super::{
    apply_asset, apply_folder, apply_note, is_corrupt_remote_content, load_stoken, push_assets,
    push_folders, push_notes, repair_folder_parents, save_stoken, ApplyAssetOutcome, FolderPayload,
    SyncDelta, SyncReport,
};

/// Sync every share scope the account is a member of. Enumerated from the
/// manifest collections; a scope we can't fully reach (e.g. a manifest whose
/// invite was accepted but whose part collections weren't) is skipped.
pub fn sync_scopes(db: &Db, cm: &CollectionManager, delta: &mut SyncDelta) -> AppResult<()> {
    let list = cm
        .list(COLLECTION_TYPE_SHARE_MANIFEST, None)
        .map_err(|e| AppError::InvalidArg(format!("list manifest collections: {e}")))?;
    for manifest_col in list.data() {
        if manifest_col.is_deleted() {
            continue;
        }
        let manifest = match decode_manifest(manifest_col) {
            Ok(manifest) => manifest,
            Err(e) => {
                log::warn!(
                    "[sync] scope manifest {} decode failed: {e}",
                    manifest_col.uid()
                );
                continue;
            }
        };
        if let Err(e) = sync_one_scope(db, cm, &manifest, delta) {
            log::warn!("[sync] scope {} sync failed: {e}", manifest.share_scope_id);
        }
    }
    Ok(())
}

fn decode_manifest(col: &Collection) -> AppResult<ShareManifest> {
    let raw = col
        .content()
        .map_err(|e| AppError::InvalidArg(format!("manifest content: {e}")))?;
    serde_json::from_slice(&raw)
        .map_err(|e| AppError::InvalidArg(format!("decode manifest json: {e}")))
}

fn part_uid(manifest: &ShareManifest, part: ShareScopePart) -> Option<&str> {
    manifest
        .collections
        .iter()
        .find(|collection| collection.part == part)
        .map(|collection| collection.collection_uid.as_str())
}

fn sync_one_scope(
    db: &Db,
    cm: &CollectionManager,
    manifest: &ShareManifest,
    delta: &mut SyncDelta,
) -> AppResult<()> {
    let scope = manifest.share_scope_id.as_str();
    let (Some(folders_uid), Some(notes_uid), Some(assets_uid)) = (
        part_uid(manifest, ShareScopePart::Folders),
        part_uid(manifest, ShareScopePart::Notes),
        part_uid(manifest, ShareScopePart::Assets),
    ) else {
        log::warn!("[sync] scope {scope} manifest is missing a required part; skipping");
        return Ok(());
    };

    // Fetch the part collections. Any failure (not a member yet — a manifest
    // accepted but bundle not) means the scope isn't ready; skip it quietly.
    let (Ok(folders_col), Ok(notes_col), Ok(assets_col)) = (
        cm.fetch(folders_uid, None),
        cm.fetch(notes_uid, None),
        cm.fetch(assets_uid, None),
    ) else {
        log::debug!("[sync] scope {scope} part collections not reachable yet; skipping");
        return Ok(());
    };

    // Folders first so notes can resolve parents; assets last so their owning
    // notes exist — same ordering rationale as the vault sync.
    let folders_im = cm
        .item_manager(&folders_col)
        .map_err(|e| AppError::InvalidArg(format!("item_manager(scope folders): {e}")))?;
    pull_scope_folders(db, &folders_im, scope, &mut delta.report)?;
    push_folders(db, &folders_im, &mut delta.report, Some(scope))?;

    let notes_im = cm
        .item_manager(&notes_col)
        .map_err(|e| AppError::InvalidArg(format!("item_manager(scope notes): {e}")))?;
    pull_scope_notes(
        db,
        &notes_im,
        scope,
        &mut delta.report,
        &mut delta.notes_pulled_ids,
    )?;
    push_notes(db, &notes_im, &mut delta.report, Some(scope))?;

    let assets_im = cm
        .item_manager(&assets_col)
        .map_err(|e| AppError::InvalidArg(format!("item_manager(scope assets): {e}")))?;
    pull_scope_assets(
        db,
        &assets_im,
        scope,
        &mut delta.report,
        &mut delta.assets_pulled_ids,
    )?;
    push_assets(db, &assets_im, &mut delta.report, Some(scope))?;

    Ok(())
}

fn pull_scope_folders(
    db: &Db,
    im: &etebase::managers::ItemManager,
    scope: &str,
    report: &mut SyncReport,
) -> AppResult<()> {
    let stoken_key = format!("scope-folders:{scope}");
    let stoken = load_stoken(db, &stoken_key)?;
    let mut new_stoken = stoken.clone();
    let mut applied: Vec<FolderPayload> = Vec::new();
    loop {
        let opts = FetchOptions::new().stoken(new_stoken.as_deref());
        let resp = im
            .list(Some(&opts))
            .map_err(|e| AppError::InvalidArg(format!("list scope folders: {e}")))?;
        for item in resp.data() {
            match apply_folder(db, item, Some(scope)) {
                Ok(Some(payload)) => applied.push(payload),
                Ok(None) => {}
                Err(err) if is_corrupt_remote_content(&err) => {
                    log::error!("[sync] skipping corrupt scope folder {}: {err}", item.uid());
                }
                Err(err) => return Err(err),
            }
            report.folders_pulled += 1;
        }
        new_stoken = resp.stoken().map(str::to_string).or(new_stoken);
        if resp.done() {
            break;
        }
    }
    // Reattach any child whose parent hadn't arrived yet within this scope.
    repair_folder_parents(db, &applied)?;
    if new_stoken != stoken {
        save_stoken(db, &stoken_key, new_stoken.as_deref())?;
    }
    Ok(())
}

fn pull_scope_notes(
    db: &Db,
    im: &etebase::managers::ItemManager,
    scope: &str,
    report: &mut SyncReport,
    applied_ids: &mut Vec<String>,
) -> AppResult<()> {
    let stoken_key = format!("scope-notes:{scope}");
    let stoken = load_stoken(db, &stoken_key)?;
    let mut new_stoken = stoken.clone();
    loop {
        let opts = FetchOptions::new().stoken(new_stoken.as_deref());
        let resp = im
            .list(Some(&opts))
            .map_err(|e| AppError::InvalidArg(format!("list scope notes: {e}")))?;
        for item in resp.data() {
            match apply_note(db, item, Some(scope)) {
                Ok(Some(id)) => applied_ids.push(id),
                Ok(None) => {}
                Err(err) if is_corrupt_remote_content(&err) => {
                    log::error!("[sync] skipping corrupt scope note {}: {err}", item.uid());
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
        save_stoken(db, &stoken_key, new_stoken.as_deref())?;
    }
    Ok(())
}

fn pull_scope_assets(
    db: &Db,
    im: &etebase::managers::ItemManager,
    scope: &str,
    report: &mut SyncReport,
    applied_ids: &mut Vec<String>,
) -> AppResult<()> {
    let stoken_key = format!("scope-assets:{scope}");
    let stoken = load_stoken(db, &stoken_key)?;
    let mut new_stoken = stoken.clone();
    // An asset whose owning note hasn't been applied yet pins the stoken so the
    // next sync retries once the note lands — mirrors the vault assets pull.
    let mut had_orphans = false;
    loop {
        let opts = FetchOptions::new().stoken(new_stoken.as_deref());
        let resp = im
            .list(Some(&opts))
            .map_err(|e| AppError::InvalidArg(format!("list scope assets: {e}")))?;
        for item in resp.data() {
            match apply_asset(db, item, Some(scope)) {
                Ok(ApplyAssetOutcome::Applied(id)) => {
                    report.assets_pulled += 1;
                    applied_ids.push(id);
                }
                Ok(ApplyAssetOutcome::Orphaned) => had_orphans = true,
                Ok(ApplyAssetOutcome::Skipped) => {}
                Err(err) if is_corrupt_remote_content(&err) => {
                    log::error!("[sync] skipping corrupt scope asset {}: {err}", item.uid());
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
        save_stoken(db, &stoken_key, new_stoken.as_deref())?;
    }
    Ok(())
}
