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
use rusqlite::params;

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

    // A read-only recipient can't upload into the scope's collections. Pushing
    // anyway fails server-side and leaves the locally-edited row `dirty`, so
    // every later sync retries the doomed push forever. When we only have read
    // access, pull the scope but never push it. The part collections are all
    // invited at the same level, so the folders collection is representative.
    let writable = !matches!(folders_col.access_level(), CollectionAccessLevel::ReadOnly);

    // Folders first so notes can resolve parents; assets last so their owning
    // notes exist — same ordering rationale as the vault sync.
    let folders_im = cm
        .item_manager(&folders_col)
        .map_err(|e| AppError::InvalidArg(format!("item_manager(scope folders): {e}")))?;
    pull_scope_folders(db, &folders_im, scope, &mut delta.report)?;
    // Mark the scope's root folder as shared-with-me so it lands in the "shared
    // with me" view instead of Home. The folder itself arrives via the pull
    // above carrying only placement metadata (name/parent/position) — the share
    // membership (owner, role, share_id) lives in the manifest, so we project it
    // onto the local row here. Guarded to skip the owner's own row (shared_by_me
    // = 1), whose stamp is authoritative.
    project_shared_root(db, manifest, folders_col.access_level(), folders_uid)?;
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

/// Project the manifest's share membership onto the local root folder row so a
/// recipient's shared folder shows up under "shared with me" (the frontend keys
/// that off `shared_role` / `share_id`) rather than in their private Home tree.
///
/// The scope pull only carries a folder's placement metadata, never the share
/// membership, so without this a freshly pulled shared root has no `shared_role`
/// and is indistinguishable from a personal folder. Idempotent, and the
/// `shared_by_me = 0` guard leaves the *owner's* own root (which carries the
/// authoritative `shared_by_me = 1` stamp) untouched when the owner syncs their
/// own scope.
fn project_shared_root(
    db: &Db,
    manifest: &ShareManifest,
    access_level: CollectionAccessLevel,
    folders_uid: &str,
) -> AppResult<()> {
    let role_db = share_access_level_to_db(ShareAccessLevel::from(access_level));
    db.with_conn(|conn| {
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
        Ok(())
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory_for_tests;

    fn manifest(root_folder_id: &str, owner: Option<&str>) -> ShareManifest {
        ShareManifest {
            schema: 1,
            share_scope_id: "scope_1".into(),
            name: "Shared".into(),
            root_folder_id: root_folder_id.into(),
            owner_username: owner.map(str::to_string),
            collections: Vec::new(),
        }
    }

    #[test]
    fn project_shared_root_marks_recipient_root_as_shared() {
        // A folder pulled from the scope carries only placement metadata; the
        // projection stamps the manifest's share membership so it lands in
        // "shared with me" rather than Home.
        let db = open_memory_for_tests();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO collections(id, parent_collection_id, name, position,
                                         created, modified, dirty, share_scope_id)
                 VALUES ('folder_root', NULL, 'Shared', 0, 't', 't', 0, 'scope_1')",
                [],
            )?;
            Ok(())
        })
        .unwrap();

        project_shared_root(
            &db,
            &manifest("folder_root", Some("alice")),
            CollectionAccessLevel::ReadOnly,
            "folders_uid",
        )
        .unwrap();

        let (owner, role, share_id, by_me): (Option<String>, Option<String>, Option<String>, i64) =
            db.with_conn(|c| {
                Ok(c.query_row(
                    "SELECT shared_owner, shared_role, share_id, shared_by_me
                       FROM collections WHERE id = 'folder_root'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )?)
            })
            .unwrap();
        assert_eq!(owner.as_deref(), Some("alice"));
        assert_eq!(role.as_deref(), Some("read_only"));
        assert_eq!(share_id.as_deref(), Some("folders_uid"));
        assert_eq!(by_me, 0);
    }

    #[test]
    fn project_shared_root_leaves_owner_row_untouched() {
        // The owner runs scope sync on their own scope too. Their root already
        // carries the authoritative shared_by_me=1 stamp and must not be
        // downgraded to a shared-with-me projection.
        let db = open_memory_for_tests();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO collections(id, parent_collection_id, name, position,
                                         created, modified, dirty, share_scope_id,
                                         shared_by_me, shared_role, shared_owner)
                 VALUES ('folder_root', NULL, 'Shared', 0, 't', 't', 0, 'scope_1',
                         1, 'admin', 'alice')",
                [],
            )?;
            Ok(())
        })
        .unwrap();

        project_shared_root(
            &db,
            &manifest("folder_root", Some("bob")),
            CollectionAccessLevel::ReadOnly,
            "folders_uid",
        )
        .unwrap();

        let (owner, role, by_me): (Option<String>, Option<String>, i64) = db
            .with_conn(|c| {
                Ok(c.query_row(
                    "SELECT shared_owner, shared_role, shared_by_me
                       FROM collections WHERE id = 'folder_root'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?)
            })
            .unwrap();
        assert_eq!(by_me, 1, "owner's shared_by_me stamp is preserved");
        assert_eq!(owner.as_deref(), Some("alice"), "owner metadata untouched");
        assert_eq!(role.as_deref(), Some("admin"));
    }
}
