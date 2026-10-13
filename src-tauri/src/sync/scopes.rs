//! Syncing shared folders.
//!
//! A shared folder (see `crate::sharing`) is one collection, and its
//! folders, notes and attachments are items in it. Being a member of the
//! collection is what having the folder means, for the owner and for
//! everyone invited alike. A sync visits the shared collections the server
//! says changed and the ones this device has something to send to, and
//! pulls and pushes each. The pull is the vault's own `pull_space`, told
//! which scope the rows belong to.
//!
//! Rows of a shared folder carry its collection's uid as `share_scope_id`.
//! The vault's pull and push leave those rows alone and the ones here take
//! only them, so a row lives in one collection.
//!
//! The work is done in the same phases as the vault's, and `sync::run`
//! runs each phase for the vault and for every shared folder before it
//! starts the next: pull, then deletions, then what is new.
//!
//! All of this is best effort. What goes wrong with a shared folder is
//! logged, never passed on, so a broken share cannot stop the user's own
//! notes from syncing.

use std::collections::HashSet;

use etebase::managers::{CollectionManager, ItemManager};
use etebase::{Collection, CollectionAccessLevel};
use rusqlite::{params, OptionalExtension};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sharing::{
    decode_manifest, open_space, purge_lost_shares, reconcile_revoked_shares, rename_space,
    scope_stoken_key, share_access_level_to_db, ShareAccessLevel, ShareManifest,
};

use super::{
    drain_tombstones, pull_space, push_assets, push_folders, push_notes, save_stoken,
    scopes_to_fetch, scopes_with_local_work, Changes, Held, LimitReached, SpacePull, SyncDelta,
};

/// A shared folder this sync has pulled, and may have to push to.
pub(super) struct OpenScope {
    collection: Collection,
    im: ItemManager,
    access: CollectionAccessLevel,
    root_folder_id: String,
}

impl OpenScope {
    fn scope(&self) -> &str {
        self.collection.uid()
    }

    /// Someone who may only read cannot upload. Pushing anyway fails on the
    /// server and leaves the edited row dirty, so every later sync would
    /// retry the same doomed push. Such a member pulls and never pushes.
    fn writable(&self) -> bool {
        !matches!(self.access, CollectionAccessLevel::ReadOnly)
    }
}

/// The shared folders a sync pulled, for its push phase.
pub(super) struct PulledScopes {
    pub(super) open: Vec<OpenScope>,
    /// Whether every folder that had to be visited was pulled. When one
    /// failed, the account's cursor must stay where it is, so the next sync
    /// is told about that folder again.
    pub(super) complete: bool,
}

/// Pull the shared folders that need it, and drop the ones the account has
/// stopped being a member of. Items a pull could not apply yet go into
/// `held`.
///
/// Which folders need it depends on the list the sync opened with:
///
/// - A list of everything, the first of each run. Every folder is pulled,
///   and a folder this device holds that the list does not have is one the
///   account lost.
/// - A list of what changed. The changed folders are pulled, and so are the
///   ones this device has something to send to: a pull goes before every
///   push. The server names the folders the account lost.
pub(super) fn pull_scopes(
    db: &Db,
    cm: &CollectionManager,
    changes: &Changes,
    delta: &mut SyncDelta,
    self_username: Option<&str>,
    held: &mut Vec<Held>,
) -> AppResult<PulledScopes> {
    let mut pulled = PulledScopes {
        open: Vec::new(),
        complete: true,
    };
    let mut live: HashSet<String> = HashSet::new();
    let mut gone: Vec<String> = changes.removed.clone();

    for collection in &changes.shared {
        if collection.is_deleted() {
            gone.push(collection.uid().to_string());
            continue;
        }
        live.insert(collection.uid().to_string());
        visit_scope(
            db,
            cm,
            collection.clone(),
            delta,
            self_username,
            held,
            &mut pulled,
        );
    }

    if changes.full {
        // The list ran to its end, or `account_changes` would have failed.
        // That matters: a folder is removed here for being absent from it.
        reconcile_revoked_shares(db, &live)?;
        return Ok(pulled);
    }

    // Folders the server did not name, with something to send.
    let changed: Vec<&str> = changes.shared.iter().map(Collection::uid).collect();
    for scope in scopes_to_fetch(&changed, &scopes_with_local_work(db)?) {
        if gone.contains(&scope) {
            continue;
        }
        match open_space(cm, &scope) {
            Ok(Some(collection)) => {
                visit_scope(db, cm, collection, delta, self_username, held, &mut pulled)
            }
            // Gone without the list saying so. Left for the next full list
            // to remove, which does not act on one answer alone.
            Ok(None) => {
                log::warn!("[sync] shared folder {scope} has work to send and is gone");
                pulled.complete = false;
            }
            Err(e) => {
                log::warn!("[sync] shared folder {scope} could not be fetched: {e}");
                pulled.complete = false;
            }
        }
    }

    purge_lost_shares(db, &gone)?;
    Ok(pulled)
}

fn visit_scope(
    db: &Db,
    cm: &CollectionManager,
    collection: Collection,
    delta: &mut SyncDelta,
    self_username: Option<&str>,
    held: &mut Vec<Held>,
    pulled: &mut PulledScopes,
) {
    let uid = collection.uid().to_string();
    match pull_one_scope(db, cm, collection, delta, self_username, held) {
        Ok(scope) => pulled.open.push(scope),
        Err(e) => {
            log::warn!("[sync] shared folder {uid} pull failed: {e}");
            pulled.complete = false;
        }
    }
}

fn pull_one_scope(
    db: &Db,
    cm: &CollectionManager,
    collection: Collection,
    delta: &mut SyncDelta,
    self_username: Option<&str>,
    held: &mut Vec<Held>,
) -> AppResult<OpenScope> {
    let manifest = decode_manifest(&collection)?;
    let im = cm
        .item_manager(&collection)
        .map_err(|e| AppError::InvalidArg(format!("item_manager(shared folder): {e}")))?;
    let open = OpenScope {
        access: collection.access_level(),
        root_folder_id: manifest.root_folder_id.clone(),
        collection,
        im,
    };
    let scope = open.scope();

    // In a folder that is read-only here, a dirty row is a bug or what is
    // left of one. Drop those edits, rewind the cursor, and let the pull
    // below put the server's content back.
    if !open.writable() {
        let repair = discard_read_only_scope_edits(db, scope)?;
        if repair.total() > 0 {
            save_stoken(db, &scope_stoken_key(scope), None)?;
            log::warn!(
                "[sync] discarded {} local edit(s) from read-only shared folder {scope}; pulling it afresh",
                repair.total()
            );
        }
    }

    let stoken_key = scope_stoken_key(scope);
    let space = SpacePull {
        scope: Some(scope),
        stoken_key: &stoken_key,
        preserve_dirty_local_edits: open.writable(),
    };
    held.extend(pull_space(db, &open.im, &space, delta)?);

    // The pull brings the root folder like any other, with a name and a
    // place and nothing that says it is shared. That it is, by whom and
    // with what rights is the collection's to say, so it is written onto
    // the row here.
    project_shared_root(db, scope, &manifest, open.access, self_username)?;
    Ok(open)
}

/// Push the deletions queued for each shared folder this device may write
/// to. Runs for every folder before anything new is pushed to any, see
/// `sync::run`. A folder that fails is logged and the others go on.
pub(super) fn drain_scope_tombstones(db: &Db, scopes: &[OpenScope]) {
    for open in scopes.iter().filter(|open| open.writable()) {
        for kind in ["folder", "note", "asset"] {
            if let Err(e) = drain_tombstones(db, &open.im, kind, Some(open.scope())) {
                log::warn!(
                    "[sync] shared folder {}: deleting {kind}s failed: {e}",
                    open.scope()
                );
            }
        }
    }
}

/// Push what changed locally in each shared folder this device may write
/// to. A folder that fails is logged and the others go on.
pub(super) fn push_scopes(
    db: &Db,
    cm: &CollectionManager,
    scopes: &[OpenScope],
    delta: &mut SyncDelta,
) {
    for open in scopes {
        if let Err(e) = push_one_scope(db, cm, open, delta) {
            log::warn!("[sync] shared folder {} push failed: {e}", open.scope());
            // The one failure the user can do something about, or ask the
            // folder's owner to.
            if let Some(reason) = e.limit() {
                delta
                    .limits
                    .push(LimitReached::in_folder(db, &open.root_folder_id, reason));
            }
        }
    }
}

fn push_one_scope(
    db: &Db,
    cm: &CollectionManager,
    open: &OpenScope,
    delta: &mut SyncDelta,
) -> AppResult<()> {
    let scope = open.scope();
    if open.writable() {
        // Folders first, so nobody pulls a note whose folder the server has
        // not been told about.
        push_folders(db, &open.im, &mut delta.report, Some(scope))?;
        push_notes(db, &open.im, &mut delta.report, Some(scope))?;
        push_assets(db, &open.im, &mut delta.report, Some(scope))?;
    }

    // An invitation shows the collection's name, so it follows the root
    // folder's. Only an admin may change it.
    if matches!(open.access, CollectionAccessLevel::Admin) {
        if let Some(name) = local_root_name(db, &open.root_folder_id)? {
            rename_space(cm, &open.collection, &name)?;
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
