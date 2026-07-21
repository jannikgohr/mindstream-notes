//! Undoing a share: leaving one that was shared with you, stopping one
//! you own, and reconciling scopes the server revoked behind our back.
//!
//! All three converge on the same local cleanup — purge the scope's rows,
//! then relinquish or delete the remote collections best-effort.

use super::*;

/// A collection's local share metadata:
/// `(share_scope_id, share_id, shared_role, shared_by_me)`.
pub(super) type ShareMetadataRow = (Option<String>, Option<String>, Option<String>, bool);

/// Leave a folder that was shared *with* the current user. Unlike
/// `decline_share_bundle` (which undoes a not-yet-accepted invite), this operates
/// on an accepted share that already lives in the tree: it relinquishes
/// membership of the scope's manifest + part collections server-side and purges
/// the locally-pulled scoped rows so the folder disappears. The owner and other
/// members are unaffected; the user can be re-invited later.
#[tauri::command]
pub async fn leave_shared_collection(app: AppHandle, collection_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = restore_required(&app)?;
        let db = app.state::<Db>();

        // Read the row's share metadata. `share_scope_id` is the ideal handle,
        // but a broken/dev-era share can lack it while still carrying `share_id`
        // (the folders collection uid) or `shared_role` — those still mark it as
        // shared *with* us and must remain removable. A share we own
        // (`shared_by_me`) is managed from the owner side, not "left".
        let row: Option<ShareMetadataRow> = db.with_conn(|conn| {
            Ok(conn
                .query_row(
                    "SELECT share_scope_id, share_id, shared_role,
                                COALESCE(shared_by_me, 0)
                         FROM collections WHERE id = ?1",
                    params![collection_id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, i64>(3)? != 0,
                        ))
                    },
                )
                .optional()?)
        })?;

        let Some((scope_id, share_id, shared_role, shared_by_me)) = row else {
            return Err(AppError::NotFound(format!("collection {collection_id}")));
        };
        if shared_by_me {
            return Err(AppError::InvalidArg(
                "you own this shared folder — manage it from sharing settings instead of leaving"
                    .into(),
            ));
        }
        if scope_id.is_none() && share_id.is_none() && shared_role.is_none() {
            return Err(AppError::InvalidArg(format!(
                "collection {collection_id} is not a shared folder"
            )));
        }

        // Relinquish server-side membership best-effort — every failure here is
        // non-fatal because the local purge below is what actually removes the
        // folder. Prefer the full scope (manifest + 3 parts); if the scope can't
        // be resolved (incomplete/deleted server-side), fall back to leaving the
        // folders collection directly by its uid (`share_id`).
        let cm = account
            .collection_manager()
            .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;
        let mut left_via_scope = false;
        if let Some(scope) = scope_id.as_deref() {
            match find_existing_scope(&cm, scope) {
                Ok(Some(resolved)) => {
                    for col in [
                        &resolved.manifest,
                        &resolved.folders,
                        &resolved.notes,
                        &resolved.assets,
                    ] {
                        leave_collection_best_effort(&cm, col.uid(), Some(scope));
                    }
                    left_via_scope = true;
                }
                Ok(None) => log::warn!(
                    "[sharing] scope {scope} manifest not found server-side; purging locally only"
                ),
                Err(e) => {
                    log::warn!("[sharing] resolve scope {scope} to leave: {e}; purging locally")
                }
            }
        }
        if !left_via_scope {
            if let Some(uid) = share_id.as_deref() {
                leave_collection_best_effort(&cm, uid, scope_id.as_deref());
            }
        }

        // Always purge locally so the folder disappears in every case. The
        // scope-keyed purge clears the pulled rows + cursors when a scope exists;
        // the subtree purge (by collection id) is the safety net for a broken /
        // NULL-scope share so it's removable regardless.
        if let Some(scope) = scope_id.as_deref() {
            purge_local_scope(&db, scope)?;
        }
        purge_local_subtree(&db, &collection_id)?;

        Ok::<(), AppError>(())
    })
    .await
    .map_err(|e| format!("leave shared collection task: {e}"))?
    .map_err(Into::into)
}

/// Delete every locally-pulled row for `scope` — the shared subtree
/// (collections/notes/assets), its tombstones, and the per-part sync cursors — so
/// a left scope stops rendering and can't be re-pushed. Mirrors the delete set of
/// `sync::scopes::discard_read_only_scope_edits` but unconditional (leaving drops
/// remote-authoritative rows too, not just dirty local edits).
pub(crate) fn purge_local_scope(db: &Db, scope: &str) -> AppResult<()> {
    db.with_conn_mut(|conn| {
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM assets WHERE share_scope_id = ?1",
            params![scope],
        )?;
        tx.execute(
            "DELETE FROM notes WHERE share_scope_id = ?1",
            params![scope],
        )?;
        tx.execute(
            "DELETE FROM collections WHERE share_scope_id = ?1",
            params![scope],
        )?;
        tx.execute(
            "DELETE FROM tombstones WHERE share_scope_id = ?1",
            params![scope],
        )?;
        tx.execute(
            "DELETE FROM sync_state WHERE kind IN (?1, ?2, ?3)",
            params![
                format!("scope-folders:{scope}"),
                format!("scope-notes:{scope}"),
                format!("scope-assets:{scope}"),
            ],
        )?;
        tx.commit()?;
        Ok(())
    })
}

/// Best-effort delete of an already-fetched collection (owner revoke). Marks it
/// deleted and uploads the tombstone; every failure is logged and swallowed — the
/// owner's folder is already personal locally, so a failed server revoke is not
/// fatal (recipients reconcile once the delete does land).
pub(super) fn delete_collection_best_effort(
    cm: &CollectionManager,
    mut col: Collection,
    scope_label: &str,
) {
    if col.is_deleted() {
        return;
    }
    if let Err(e) = col.delete() {
        log::warn!(
            "[sharing] mark {} deleted (scope {scope_label}): {e}",
            col.uid()
        );
        return;
    }
    if let Err(e) = cm.upload(&col, None) {
        log::warn!(
            "[sharing] upload delete of {} (scope {scope_label}): {e}",
            col.uid()
        );
    }
}

/// Best-effort `member.leave()` on one collection by uid. Any failure (fetch,
/// member-manager, or the leave itself) is logged and swallowed — the caller
/// relies on the local purge, not this, to actually remove the folder.
pub(super) fn leave_collection_best_effort(cm: &CollectionManager, uid: &str, scope: Option<&str>) {
    let scope_label = scope.unwrap_or("-");
    let col = match cm.fetch(uid, None) {
        Ok(col) if !col.is_deleted() => col,
        Ok(_) => return,
        Err(e) => {
            log::warn!("[sharing] fetch {uid} to leave (scope {scope_label}): {e}");
            return;
        }
    };
    match cm.member_manager(&col) {
        Ok(mm) => {
            if let Err(e) = mm.leave() {
                log::warn!("[sharing] leave collection {uid} (scope {scope_label}): {e}");
            }
        }
        Err(e) => log::warn!("[sharing] member_manager for {uid} (scope {scope_label}): {e}"),
    }
}

/// Delete a folder subtree locally: the root collection, its descendant
/// collections, their notes and assets, and any tombstones queued for those
/// rows. The reconciliation safety net for a shared root whose scope can't be
/// resolved (a broken / incomplete / NULL-scope share) so "Leave" always removes
/// it, independent of `share_scope_id` or FK-cascade behaviour.
pub(super) fn purge_local_subtree(db: &Db, root_id: &str) -> AppResult<()> {
    const SUBTREE_CTE: &str = "WITH RECURSIVE subtree(id) AS (
            SELECT ?1
            UNION ALL
            SELECT c.id FROM collections c JOIN subtree s ON c.parent_collection_id = s.id
        )";
    db.with_conn_mut(|conn| {
        let tx = conn.transaction()?;
        // Tombstones keyed by the etebase_uid of a row about to vanish, so a
        // stale delete doesn't linger after the rows are gone.
        tx.execute(
            &format!("{SUBTREE_CTE} DELETE FROM tombstones WHERE etebase_uid IN (SELECT etebase_uid FROM collections WHERE id IN (SELECT id FROM subtree) AND etebase_uid IS NOT NULL)"),
            params![root_id],
        )?;
        tx.execute(
            &format!("{SUBTREE_CTE} DELETE FROM tombstones WHERE etebase_uid IN (SELECT etebase_uid FROM notes WHERE parent_collection_id IN (SELECT id FROM subtree) AND etebase_uid IS NOT NULL)"),
            params![root_id],
        )?;
        // Rows child-first so an FK check can't trip if PRAGMA foreign_keys is on
        // without cascade.
        tx.execute(
            &format!("{SUBTREE_CTE} DELETE FROM assets WHERE owning_note_id IN (SELECT id FROM notes WHERE parent_collection_id IN (SELECT id FROM subtree))"),
            params![root_id],
        )?;
        tx.execute(
            &format!("{SUBTREE_CTE} DELETE FROM notes WHERE parent_collection_id IN (SELECT id FROM subtree)"),
            params![root_id],
        )?;
        tx.execute(
            &format!("{SUBTREE_CTE} DELETE FROM collections WHERE id IN (SELECT id FROM subtree)"),
            params![root_id],
        )?;
        tx.commit()?;
        Ok(())
    })
}

/// Local accepted shared-with-me scopes that are no longer in the authoritative
/// live-manifest set — the owner deleted the folder *or* removed this member from
/// it. Pure so it's unit-testable.
pub(super) fn scopes_to_purge<'a>(
    local_scopes: &'a [String],
    live_scopes: &HashSet<String>,
) -> Vec<&'a str> {
    local_scopes
        .iter()
        .filter(|scope| !live_scopes.contains(*scope))
        .map(String::as_str)
        .collect()
}

/// Reconcile shares the current user has lost access to — the owner either
/// deleted the folder ("Stop sharing") or removed this member. Both cases show up
/// the same way: the scope's manifest is no longer in the account's authoritative
/// manifest list. So enumerate that list *fully* into a live-scope set and purge
/// any local accepted shared-with-me scope that's missing from it.
///
/// Safety: this only ever purges when the manifest enumeration *succeeds* — any
/// list error aborts before purging, so a network blip or partial page can't
/// delete a folder. Local accepted roots exist only after a successful first
/// pull, so there's no half-synced folder to mistake for a revocation. Called
/// from `sync::scopes::sync_scopes`.
pub(crate) fn reconcile_revoked_shares(db: &Db, cm: &CollectionManager) -> AppResult<()> {
    let local_scopes: Vec<String> = db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT share_scope_id
               FROM collections
              WHERE COALESCE(shared_by_me, 0) = 0
                AND share_scope_id IS NOT NULL
                AND share_id IS NOT NULL",
        )?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })?;
    if local_scopes.is_empty() {
        return Ok(());
    }

    // Authoritative live set: a decodable, non-deleted manifest means we still
    // have access to that scope. Paginate fully; any error propagates and aborts
    // (never purge on an incomplete enumeration).
    let mut live_scopes: HashSet<String> = HashSet::new();
    let mut stoken: Option<String> = None;
    loop {
        let options = FetchOptions::new().limit(100).stoken(stoken.as_deref());
        let page = cm
            .list(COLLECTION_TYPE_SHARE_MANIFEST, Some(&options))
            .map_err(|e| AppError::InvalidArg(format!("list manifests for reconcile: {e}")))?;
        for col in page.data() {
            if col.is_deleted() {
                continue;
            }
            if let Ok(manifest) = decode_manifest(col) {
                live_scopes.insert(manifest.share_scope_id);
            }
        }
        if page.done() {
            break;
        }
        match page.stoken().map(str::to_string) {
            Some(next) => stoken = Some(next),
            None => break,
        }
    }

    for scope in scopes_to_purge(&local_scopes, &live_scopes) {
        log::info!(
            "[sharing] scope {scope} no longer accessible (revoked/removed); purging locally"
        );
        purge_local_scope(db, scope)?;
    }
    Ok(())
}

/// Stop sharing a folder the current user owns (`shared_by_me`). The owner keeps
/// the folder — its subtree is re-homed back into the vault as a personal folder
/// — while every recipient loses access: the scope's collections are deleted
/// server-side, which each recipient's next sync reads (`is_deleted`) and
/// reconciles by purging its local copy (see `reconcile_revoked_shares`).
#[tauri::command]
pub async fn stop_sharing_collection(app: AppHandle, collection_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = restore_required(&app)?;
        let db = app.state::<Db>();

        // `share_scope_id` is the ideal handle, but a broken/dev-era outgoing
        // share can be `shared_by_me` with a NULL scope while still carrying
        // `share_id` (the folders collection uid). Never hard-error on such a
        // folder — it must remain un-shareable-able so the owner can clean it up.
        let (scope_id, share_id, shared_by_me): (Option<String>, Option<String>, bool) = db
            .with_conn(|conn| {
                Ok(conn
                    .query_row(
                        "SELECT share_scope_id, share_id, COALESCE(shared_by_me, 0)
                         FROM collections WHERE id = ?1",
                        params![collection_id],
                        |row| {
                            Ok((
                                row.get::<_, Option<String>>(0)?,
                                row.get::<_, Option<String>>(1)?,
                                row.get::<_, i64>(2)? != 0,
                            ))
                        },
                    )
                    .optional()?
                    .unwrap_or((None, None, false)))
            })?;

        if !shared_by_me && scope_id.is_none() && share_id.is_none() {
            return Err(AppError::InvalidArg(
                "you're not sharing this folder".into(),
            ));
        }

        // Local first, so the owner keeps their content even if the server call
        // below fails. Handles a NULL scope (just clears the share metadata).
        db.with_conn(|conn| detach_owner_share(conn, &collection_id))?;

        // Revoke server-side by deleting the scope's collections — the signal
        // recipients read to purge their copies. Best-effort: a scope already gone
        // server-side (or a NULL-scope broken share) is fine, the folder is already
        // personal locally. Prefer the full scope; fall back to the folders
        // collection by `share_id` when the scope can't be resolved.
        let cm = account
            .collection_manager()
            .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;
        let scope_label = scope_id.as_deref().unwrap_or("-");
        let mut deleted_via_scope = false;
        if let Some(scope) = scope_id.as_deref() {
            match find_existing_scope(&cm, scope) {
                Ok(Some(resolved)) => {
                    for col in [
                        resolved.manifest,
                        resolved.folders,
                        resolved.notes,
                        resolved.assets,
                    ] {
                        delete_collection_best_effort(&cm, col, scope);
                    }
                    deleted_via_scope = true;
                }
                Ok(None) => log::warn!(
                    "[sharing] scope {scope} already gone server-side while stopping share"
                ),
                Err(e) => log::warn!("[sharing] resolve scope {scope} to stop sharing: {e}"),
            }
        }
        if !deleted_via_scope {
            if let Some(uid) = share_id.as_deref() {
                match cm.fetch(uid, None) {
                    Ok(col) => delete_collection_best_effort(&cm, col, scope_label),
                    Err(e) => {
                        log::warn!("[sharing] fetch {uid} to delete (scope {scope_label}): {e}")
                    }
                }
            }
        }

        Ok::<(), AppError>(())
    })
    .await
    .map_err(|e| format!("stop sharing collection task: {e}"))?
    .map_err(Into::into)
}
