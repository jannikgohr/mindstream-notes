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
use etebase::{Collection, CollectionAccessLevel, FetchOptions};
use rusqlite::{params, OptionalExtension};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sharing::{
    share_access_level_to_db, ShareAccessLevel, ShareManifest, ShareScopePart,
    COLLECTION_TYPE_SHARE_MANIFEST,
};

use super::{
    apply_asset, apply_folder, apply_note, is_corrupt_remote_content, load_stoken, push_assets,
    push_folders, push_notes, repair_folder_parents, save_stoken, ApplyAssetOutcome, FolderPayload,
    SyncDelta, SyncReport,
};

/// Sync every share scope the account is a member of. Enumerated from the
/// manifest collections; a scope we can't fully reach (e.g. a manifest whose
/// invite was accepted but whose part collections weren't) is skipped.
pub fn sync_scopes(
    db: &Db,
    cm: &CollectionManager,
    delta: &mut SyncDelta,
    self_username: Option<&str>,
) -> AppResult<()> {
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
        if let Err(e) = sync_one_scope(db, cm, &manifest, delta, self_username) {
            log::warn!("[sync] scope {} sync failed: {e}", manifest.share_scope_id);
        }
    }

    // Reconcile shares the owner revoked (deleted the scope collections): purge
    // any local shared-with-me root whose collections are now deleted server-side.
    // Isolated so a failure here can't wedge the rest of the sync.
    if let Err(e) = crate::sharing::reconcile_revoked_shares(db, cm) {
        log::warn!("[sync] revoked-share reconcile failed: {e}");
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

/// The local collection id of the shared root this account holds for `scope`, if
/// any (a row tagged with the scope that isn't shared-by-me; the anchor — carrying
/// `share_id` — is preferred). Best-effort, only used to make the
/// incomplete-scope warning actionable.
fn local_scope_root(db: &Db, scope: &str) -> Option<String> {
    db.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT id FROM collections
                 WHERE share_scope_id = ?1 AND COALESCE(shared_by_me, 0) = 0
                 ORDER BY (share_id IS NULL), id
                 LIMIT 1",
                params![scope],
                |row| row.get::<_, String>(0),
            )
            .optional()?)
    })
    .ok()
    .flatten()
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
    self_username: Option<&str>,
) -> AppResult<()> {
    let scope = manifest.share_scope_id.as_str();
    let (Some(folders_uid), Some(notes_uid), Some(assets_uid)) = (
        part_uid(manifest, ShareScopePart::Folders),
        part_uid(manifest, ShareScopePart::Notes),
        part_uid(manifest, ShareScopePart::Assets),
    ) else {
        // Incomplete manifest — it can never finish syncing. Name the local root
        // (if this account already has one accepted) so the diagnostic is
        // actionable: the fix is to Leave it. Never auto-delete here — a folder
        // mid-first-sync must not be mistaken for an orphan.
        match local_scope_root(db, scope) {
            Some(root_id) => log::warn!(
                "[sync] shared root {root_id} (scope {scope}) is incomplete (manifest missing a required part) and can't sync; use \"Leave shared folder\" to remove it"
            ),
            None => log::warn!(
                "[sync] scope {scope} manifest is missing a required part; skipping"
            ),
        }
        return Ok(());
    };

    record_scope_collab_epoch(db, manifest, delta)?;

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

    // A read-only recipient can't upload into the scope's collections. Pushing
    // anyway fails server-side and leaves the locally-edited row `dirty`, so
    // every later sync retries the doomed push forever. When we only have read
    // access, pull the scope but never push it. The part collections are all
    // invited at the same level, so the folders collection is representative.
    let writable = !matches!(folders_col.access_level(), CollectionAccessLevel::ReadOnly);

    // For view-only shares, any dirty local row is a bug or stale state from a
    // previous bug. Discard those local mutations, rewind this scope's cursors,
    // and let the pull below restore the remote-authoritative content.
    let preserve_dirty_local_edits = writable;
    if !writable {
        let repair = discard_read_only_scope_edits(db, scope)?;
        if repair.total() > 0 {
            reset_scope_stokens(db, scope)?;
            log::warn!(
                "[sync] discarded {} local edit(s) from read-only scope {scope}; forcing remote pull",
                repair.total()
            );
        }
    }

    // Folders first so notes can resolve parents; assets last so their owning
    // notes exist — same ordering rationale as the vault sync.
    let folders_im = cm
        .item_manager(&folders_col)
        .map_err(|e| AppError::InvalidArg(format!("item_manager(scope folders): {e}")))?;
    pull_scope_folders(
        db,
        &folders_im,
        scope,
        &mut delta.report,
        preserve_dirty_local_edits,
    )?;
    // Mark the scope's root folder as shared-with-me so it lands in the "shared
    // with me" view instead of Home. The folder itself arrives via the pull
    // above carrying only placement metadata (name/parent/position) — the share
    // membership (owner, role, share_id) lives in the manifest, so we project it
    // onto the local row here. The owner's *other* device stamps shared_by_me
    // instead so the folder stays in Home; a recipient's row is left alone if it
    // already carries the authoritative shared_by_me = 1.
    project_shared_root(
        db,
        manifest,
        folders_col.access_level(),
        folders_uid,
        self_username,
    )?;
    if writable {
        push_folders(db, &folders_im, &mut delta.report, Some(scope))?;
    }

    let notes_im = cm
        .item_manager(&notes_col)
        .map_err(|e| AppError::InvalidArg(format!("item_manager(scope notes): {e}")))?;
    pull_scope_notes(
        db,
        &notes_im,
        scope,
        &mut delta.report,
        &mut delta.notes_pulled_ids,
        preserve_dirty_local_edits,
    )?;
    if writable {
        push_notes(db, &notes_im, &mut delta.report, Some(scope))?;
    }

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
    if writable {
        push_assets(db, &assets_im, &mut delta.report, Some(scope))?;
    }

    Ok(())
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct ReadOnlyScopeRepair {
    folders_discarded: usize,
    folders_reset: usize,
    notes_discarded: usize,
    notes_reset: usize,
    assets_discarded: usize,
    assets_reset: usize,
    tombstones_discarded: usize,
}

impl ReadOnlyScopeRepair {
    fn total(self) -> usize {
        self.folders_discarded
            + self.folders_reset
            + self.notes_discarded
            + self.notes_reset
            + self.assets_discarded
            + self.assets_reset
            + self.tombstones_discarded
    }
}

fn discard_read_only_scope_edits(db: &Db, scope: &str) -> AppResult<ReadOnlyScopeRepair> {
    db.with_conn_mut(|conn| {
        let tx = conn.transaction()?;

        let tombstones_discarded = tx.execute(
            "DELETE FROM tombstones WHERE share_scope_id = ?1",
            params![scope],
        )?;
        let assets_discarded = tx.execute(
            "DELETE FROM assets
             WHERE share_scope_id = ?1 AND dirty = 1 AND etebase_uid IS NULL",
            params![scope],
        )?;
        let notes_discarded = tx.execute(
            "DELETE FROM notes
             WHERE share_scope_id = ?1 AND dirty = 1 AND etebase_uid IS NULL",
            params![scope],
        )?;
        let folders_discarded = tx.execute(
            "DELETE FROM collections
             WHERE share_scope_id = ?1 AND dirty = 1 AND etebase_uid IS NULL",
            params![scope],
        )?;

        let notes_reset = tx.execute(
            "UPDATE notes
                SET dirty = 0, yrs_state = NULL, tags_state = NULL
              WHERE share_scope_id = ?1 AND dirty = 1",
            params![scope],
        )?;
        let folders_reset = tx.execute(
            "UPDATE collections
                SET dirty = 0
              WHERE share_scope_id = ?1 AND dirty = 1",
            params![scope],
        )?;
        let assets_reset = tx.execute(
            "UPDATE assets
                SET dirty = 0
              WHERE share_scope_id = ?1 AND dirty = 1",
            params![scope],
        )?;

        tx.commit()?;
        Ok(ReadOnlyScopeRepair {
            folders_discarded,
            folders_reset,
            notes_discarded,
            notes_reset,
            assets_discarded,
            assets_reset,
            tombstones_discarded,
        })
    })
}

fn reset_scope_stokens(db: &Db, scope: &str) -> AppResult<()> {
    save_stoken(db, &scope_folders_stoken_key(scope), None)?;
    save_stoken(db, &scope_notes_stoken_key(scope), None)?;
    save_stoken(db, &scope_assets_stoken_key(scope), None)?;
    Ok(())
}

fn scope_folders_stoken_key(scope: &str) -> String {
    format!("scope-folders:{scope}")
}

fn scope_notes_stoken_key(scope: &str) -> String {
    format!("scope-notes:{scope}")
}

fn scope_assets_stoken_key(scope: &str) -> String {
    format!("scope-assets:{scope}")
}

fn scope_collab_epoch_key(scope: &str) -> String {
    format!("scope-collab-epoch:{scope}")
}

fn load_scope_collab_epoch(db: &Db, scope: &str) -> AppResult<Option<u64>> {
    let key = scope_collab_epoch_key(scope);
    db.with_conn(|conn| {
        let raw: Option<String> = conn
            .query_row(
                "SELECT stoken FROM sync_state WHERE kind = ?1",
                params![key],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        Ok(raw.and_then(|value| value.parse::<u64>().ok()))
    })
}

fn save_scope_collab_epoch(db: &Db, scope: &str, epoch: u64) -> AppResult<()> {
    let key = scope_collab_epoch_key(scope);
    let value = epoch.to_string();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO sync_state(kind, stoken)
             VALUES (?1, ?2)
             ON CONFLICT(kind) DO UPDATE SET stoken = excluded.stoken",
            params![key, value],
        )?;
        Ok(())
    })
}

fn record_scope_collab_epoch(
    db: &Db,
    manifest: &ShareManifest,
    delta: &mut SyncDelta,
) -> AppResult<()> {
    if manifest.collab_salt.is_empty() {
        return Ok(());
    }

    let scope = manifest.share_scope_id.as_str();
    let previous = load_scope_collab_epoch(db, scope)?;
    if previous == Some(manifest.collab_epoch) {
        return Ok(());
    }

    save_scope_collab_epoch(db, scope, manifest.collab_epoch)?;
    delta
        .collab_credentials_changed_note_ids
        .extend(crate::collab_events::note_ids_for_share_scope(db, scope)?);
    Ok(())
}

/// Project the manifest's share membership onto the local root folder row so a
/// recipient's shared folder shows up under "shared with me" (the frontend keys
/// that off `shared_role` / `share_id`) rather than in their private Home tree.
///
/// The scope pull only carries a folder's placement metadata, never the share
/// membership, so without this a freshly pulled shared root has no `shared_role`
/// and is indistinguishable from a personal folder.
///
/// Two distinct cases, keyed on whether the syncing account is the scope owner:
///
/// - **Owner's own device.** `shared_by_me = 1` is stamped only on the device
///   that initiated the share (`record_outgoing_share`); the owner's *other*
///   devices pull the same scope but arrive with `shared_by_me = 0`, so the
///   recipient projection would mis-file the folder under "shared with me". We
///   instead mirror the `shared_by_me = 1` stamp here, keeping the folder in
///   Home with the shared-by-me badge — `collectionIsSharedWithMe`
///   short-circuits to false whenever `shared_by_me` is set.
///
/// - **Recipient's device.** Stamp the share membership. The
///   `COALESCE(shared_by_me, 0) = 0` guard is retained here so a row that
///   already carries an authoritative `shared_by_me = 1` (e.g. the owner's first
///   device) is never downgraded.
fn project_shared_root(
    db: &Db,
    manifest: &ShareManifest,
    access_level: CollectionAccessLevel,
    folders_uid: &str,
    self_username: Option<&str>,
) -> AppResult<()> {
    let role_db = share_access_level_to_db(ShareAccessLevel::from(access_level));
    let owner_device =
        manifest.owner_username.is_some() && manifest.owner_username.as_deref() == self_username;
    db.with_conn(|conn| {
        if owner_device {
            conn.execute(
                "UPDATE collections
                    SET shared_owner = ?1, shared_role = ?2, share_id = ?3,
                        shared_by_me = 1
                  WHERE id = ?4",
                params![
                    manifest.owner_username,
                    role_db,
                    folders_uid,
                    manifest.root_folder_id,
                ],
            )?;
        } else {
            conn.execute(
                "UPDATE collections
                    SET shared_owner = ?1, shared_role = ?2, share_id = ?3
                  WHERE id = ?4 AND COALESCE(shared_by_me, 0) = 0",
                params![
                    manifest.owner_username,
                    role_db,
                    folders_uid,
                    manifest.root_folder_id,
                ],
            )?;
        }
        Ok(())
    })
}

fn pull_scope_folders(
    db: &Db,
    im: &etebase::managers::ItemManager,
    scope: &str,
    report: &mut SyncReport,
    preserve_dirty_local_edits: bool,
) -> AppResult<()> {
    let stoken_key = scope_folders_stoken_key(scope);
    let stoken = load_stoken(db, &stoken_key)?;
    let mut new_stoken = stoken.clone();
    let mut applied: Vec<FolderPayload> = Vec::new();
    loop {
        let opts = FetchOptions::new().stoken(new_stoken.as_deref());
        let resp = im
            .list(Some(&opts))
            .map_err(|e| AppError::InvalidArg(format!("list scope folders: {e}")))?;
        for item in resp.data() {
            match apply_folder(db, item, Some(scope), preserve_dirty_local_edits) {
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
    preserve_dirty_local_edits: bool,
) -> AppResult<()> {
    let stoken_key = scope_notes_stoken_key(scope);
    let stoken = load_stoken(db, &stoken_key)?;
    let mut new_stoken = stoken.clone();
    loop {
        let opts = FetchOptions::new().stoken(new_stoken.as_deref());
        let resp = im
            .list(Some(&opts))
            .map_err(|e| AppError::InvalidArg(format!("list scope notes: {e}")))?;
        for item in resp.data() {
            match apply_note(db, item, Some(scope), preserve_dirty_local_edits) {
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
    let stoken_key = scope_assets_stoken_key(scope);
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

#[cfg(test)]
mod tests;
