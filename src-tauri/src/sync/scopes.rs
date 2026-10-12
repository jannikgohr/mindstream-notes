//! Syncing shared folders.
//!
//! A shared folder (see `crate::sharing`) is one collection, and its
//! folders, notes and attachments are items in it. Being a member of the
//! collection is what having the folder means, for the owner and for
//! everyone invited alike, so this lists the shared collections the account
//! belongs to and pulls and pushes each one. The pull is the vault's own
//! `pull_space`, told which scope the rows belong to.
//!
//! Rows of a shared folder carry its collection's uid as `share_scope_id`.
//! The vault's pull and push leave those rows alone and the ones here take
//! only them, so a row lives in one collection.
//!
//! All of this is best effort. `sync_scopes` runs inside the vault's sync
//! and what it returns is logged, never passed on, so a broken share cannot
//! stop the user's own notes from syncing.

use std::collections::HashSet;

use etebase::managers::CollectionManager;
use etebase::{Collection, CollectionAccessLevel, FetchOptions};
use rusqlite::{params, OptionalExtension};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sharing::{
    decode_manifest, reconcile_revoked_shares, rename_space, scope_collab_epoch_key,
    scope_stoken_key, share_access_level_to_db, ShareAccessLevel, ShareManifest,
    COLLECTION_TYPE_SHARED,
};

use super::{pull_space, push_assets, push_folders, push_notes, save_stoken, SpacePull, SyncDelta};

/// Sync every shared folder the account is a member of, then drop the ones
/// it has stopped being a member of.
pub fn sync_scopes(
    db: &Db,
    cm: &CollectionManager,
    delta: &mut SyncDelta,
    self_username: Option<&str>,
) -> AppResult<()> {
    // The whole list or nothing. What is missing from it is removed from
    // this device below, so a list that stopped early must not be used.
    let collections = list_shared_collections(cm)?;

    let mut live: HashSet<String> = HashSet::new();
    for collection in &collections {
        if collection.is_deleted() {
            continue;
        }
        live.insert(collection.uid().to_string());
        if let Err(e) = sync_one_scope(db, cm, collection, delta, self_username) {
            log::warn!("[sync] shared folder {} sync failed: {e}", collection.uid());
        }
    }

    reconcile_revoked_shares(db, &live)
}

/// Every shared collection the account belongs to.
fn list_shared_collections(cm: &CollectionManager) -> AppResult<Vec<Collection>> {
    let mut collections = Vec::new();
    let mut stoken: Option<String> = None;
    loop {
        let options = FetchOptions::new().limit(100).stoken(stoken.as_deref());
        let page = cm
            .list(COLLECTION_TYPE_SHARED, Some(&options))
            .map_err(|e| AppError::InvalidArg(format!("list shared folders: {e}")))?;
        collections.extend(page.data().iter().cloned());
        if page.done() {
            return Ok(collections);
        }
        match page.stoken() {
            Some(next) => stoken = Some(next.to_string()),
            // Not done and nowhere to go on from: the list is not whole.
            None => {
                return Err(AppError::InvalidArg(
                    "list shared folders: the server ended the list without finishing it".into(),
                ))
            }
        }
    }
}

fn sync_one_scope(
    db: &Db,
    cm: &CollectionManager,
    collection: &Collection,
    delta: &mut SyncDelta,
    self_username: Option<&str>,
) -> AppResult<()> {
    let scope = collection.uid();
    let manifest = decode_manifest(collection)?;
    record_scope_collab_epoch(db, scope, &manifest, delta)?;

    // Someone who may only read cannot upload. Pushing anyway fails on the
    // server and leaves the edited row dirty, so every later sync would
    // retry the same doomed push. Such a member pulls and never pushes.
    let access = collection.access_level();
    let writable = !matches!(access, CollectionAccessLevel::ReadOnly);

    // In a folder that is read-only here, a dirty row is a bug or what is
    // left of one. Drop those edits, rewind the cursor, and let the pull
    // below put the server's content back.
    if !writable {
        let repair = discard_read_only_scope_edits(db, scope)?;
        if repair.total() > 0 {
            save_stoken(db, &scope_stoken_key(scope), None)?;
            log::warn!(
                "[sync] discarded {} local edit(s) from read-only shared folder {scope}; pulling it afresh",
                repair.total()
            );
        }
    }

    let im = cm
        .item_manager(collection)
        .map_err(|e| AppError::InvalidArg(format!("item_manager(shared folder): {e}")))?;
    let stoken_key = scope_stoken_key(scope);
    let space = SpacePull {
        scope: Some(scope),
        stoken_key: &stoken_key,
        preserve_dirty_local_edits: writable,
    };
    pull_space(db, &im, &space, delta)?;

    // The pull brings the root folder like any other, with a name and a
    // place and nothing that says it is shared. That it is, by whom and
    // with what rights is the collection's to say, so it is written onto
    // the row here.
    project_shared_root(db, scope, &manifest, access, self_username)?;

    if writable {
        // Folders first, so nobody pulls a note whose folder the server has
        // not been told about.
        push_folders(db, &im, &mut delta.report, Some(scope))?;
        push_notes(db, &im, &mut delta.report, Some(scope))?;
        push_assets(db, &im, &mut delta.report, Some(scope))?;
    }

    // An invitation shows the collection's name, so it follows the root
    // folder's. Only an admin may change it.
    if matches!(access, CollectionAccessLevel::Admin) {
        if let Some(name) = local_root_name(db, &manifest.root_folder_id)? {
            if let Err(e) = rename_space(cm, collection, &name) {
                log::warn!("[sync] could not rename shared folder {scope}: {e}");
            }
        }
    }

    Ok(())
}

fn local_root_name(db: &Db, root_folder_id: &str) -> AppResult<Option<String>> {
    db.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT name FROM collections WHERE id = ?1",
                params![root_folder_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?)
    })
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

/// Remember the folder's collab epoch, and when it is not the one seen
/// last, name the folder's notes so their live sessions reconnect with the
/// new key material.
fn record_scope_collab_epoch(
    db: &Db,
    scope: &str,
    manifest: &ShareManifest,
    delta: &mut SyncDelta,
) -> AppResult<()> {
    if manifest.collab_salt.is_empty() {
        return Ok(());
    }
    if load_scope_collab_epoch(db, scope)? == Some(manifest.collab_epoch) {
        return Ok(());
    }
    save_scope_collab_epoch(db, scope, manifest.collab_epoch)?;
    delta
        .collab_credentials_changed_note_ids
        .extend(crate::collab_events::note_ids_for_share_scope(db, scope)?);
    Ok(())
}

/// Write what the collection says about the share onto the local root
/// folder, so the folder shows as shared. The frontend files a folder under
/// "shared with me" by `shared_role` and `share_id`, and a root that was
/// only pulled has neither.
///
/// There are two cases, told apart by who the folder's owner is:
///
/// - **A device of the owner.** `shared_by_me` is set on the device the
///   folder was shared from. The owner's other devices pull the same folder
///   and would file it under "shared with me". They get the same stamp
///   here, which keeps the folder in Home with the shared badge.
///
/// - **Anyone else's device.** The share's owner, this account's role and
///   the collection are stamped. A row that already says `shared_by_me` is
///   left as it is.
fn project_shared_root(
    db: &Db,
    scope: &str,
    manifest: &ShareManifest,
    access_level: CollectionAccessLevel,
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
                  WHERE id = ?4 AND share_scope_id = ?3",
                params![
                    manifest.owner_username,
                    role_db,
                    scope,
                    manifest.root_folder_id,
                ],
            )?;
        } else {
            conn.execute(
                "UPDATE collections
                    SET shared_owner = ?1, shared_role = ?2, share_id = ?3
                  WHERE id = ?4 AND share_scope_id = ?3
                    AND COALESCE(shared_by_me, 0) = 0",
                params![
                    manifest.owner_username,
                    role_db,
                    scope,
                    manifest.root_folder_id,
                ],
            )?;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests;
