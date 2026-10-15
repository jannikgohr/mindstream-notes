//! Undoing a share: leaving one that was shared with you, stopping one you
//! own, and noticing that the server has taken one away.
//!
//! All three end in the same local cleanup: the folder's rows go.

use super::*;

/// A folder's local share metadata:
/// `(share_scope_id, share_id, shared_role, shared_by_me)`.
pub(super) type ShareMetadataRow = (Option<String>, Option<String>, Option<String>, bool);

fn share_metadata(db: &Db, collection_id: &str) -> AppResult<Option<ShareMetadataRow>> {
    db.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT share_scope_id, share_id, shared_role, COALESCE(shared_by_me, 0)
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
    })
}

/// Leave a folder that was shared with the current user. Gives up the
/// membership on the server and removes the folder's rows here. The owner
/// and the other members are unaffected, and the user can be invited again.
#[tauri::command]
pub async fn leave_shared_collection(app: AppHandle, collection_id: String) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = restore_required(&app)?;
        let db = app.state::<Db>();

        let Some((scope, share_id, shared_role, shared_by_me)) =
            share_metadata(&db, &collection_id)?
        else {
            return Err(AppError::NotFound(format!("collection {collection_id}")));
        };
        if shared_by_me {
            return Err(AppError::InvalidArg(
                "you own this shared folder — manage it from sharing settings instead of leaving"
                    .into(),
            ));
        }
        // A row can carry any one of the three and still be a share that
        // must be removable.
        if scope.is_none() && share_id.is_none() && shared_role.is_none() {
            return Err(AppError::InvalidArg(format!(
                "collection {collection_id} is not a shared folder"
            )));
        }

        // Giving up the membership is best effort. What removes the folder
        // from this device is the purge below, and a membership that could
        // not be given up now is found gone or still there by the next sync.
        let cm = account
            .collection_manager()
            .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;
        if let Some(uid) = scope.as_deref().or(share_id.as_deref()) {
            leave_best_effort(&cm, uid);
        }

        if let Some(scope) = scope.as_deref() {
            purge_local_scope(&db, scope)?;
        }
        // By folder as well as by scope, so that a row whose scope was lost
        // is still removed.
        purge_local_subtree(&db, &collection_id)?;

        Ok::<(), AppError>(())
    })
    .await
    .map_err(|e| format!("leave shared collection task: {e}"))?
    .map_err(Into::into)
}

/// Give up membership of one collection. Failing is logged and no more.
fn leave_best_effort(cm: &CollectionManager, uid: &str) {
    let collection = match open_space(cm, uid) {
        Ok(Some(collection)) => collection,
        Ok(None) => return,
        Err(e) => {
            log::warn!("[sharing] fetch {uid} to leave: {e}");
            return;
        }
    };
    match cm.member_manager(&collection) {
        Ok(members) => {
            if let Err(e) = members.leave() {
                log::warn!("[sharing] leave shared folder {uid}: {e}");
            }
        }
        Err(e) => log::warn!("[sharing] member_manager for {uid}: {e}"),
    }
}

/// The key a scope's pull cursor is kept under in `sync_state`.
pub(crate) fn scope_stoken_key(scope: &str) -> String {
    format!("scope:{scope}")
}

/// Delete every row this device holds of a scope: its folders, notes and
/// attachments, the deletions queued for it, and its cursors. Used when the
/// folder is left or taken away, so it stops showing and nothing of it is
/// pushed again.
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
            "DELETE FROM sync_state WHERE kind IN (?1, ?2)",
            params![
                scope_stoken_key(scope),
                crate::sync::held_key(&scope_stoken_key(scope)),
            ],
        )?;
        tx.commit()?;
        Ok(())
    })
}

/// Delete a folder subtree locally: the root, the folders under it, their
/// notes and attachments, and the deletions queued for those rows. What
/// makes "Leave" remove a folder whatever state its share columns are in.
pub(super) fn purge_local_subtree(db: &Db, root_id: &str) -> AppResult<()> {
    const SUBTREE_CTE: &str = "WITH RECURSIVE subtree(id) AS (
            SELECT ?1
            UNION ALL
            SELECT c.id FROM collections c JOIN subtree s ON c.parent_collection_id = s.id
        )";
    db.with_conn_mut(|conn| {
        let tx = conn.transaction()?;
        // Deletions queued for rows that are about to vanish.
        tx.execute(
            &format!("{SUBTREE_CTE} DELETE FROM tombstones WHERE etebase_uid IN (SELECT etebase_uid FROM collections WHERE id IN (SELECT id FROM subtree) AND etebase_uid IS NOT NULL)"),
            params![root_id],
        )?;
        tx.execute(
            &format!("{SUBTREE_CTE} DELETE FROM tombstones WHERE etebase_uid IN (SELECT etebase_uid FROM notes WHERE parent_collection_id IN (SELECT id FROM subtree) AND etebase_uid IS NOT NULL)"),
            params![root_id],
        )?;
        // Children first, so a foreign key check cannot trip.
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

/// The scopes this device holds as shared with it.
pub(crate) fn local_received_scopes(db: &Db) -> AppResult<Vec<String>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT share_scope_id
               FROM collections
              WHERE COALESCE(shared_by_me, 0) = 0
                AND share_scope_id IS NOT NULL
                AND share_id IS NOT NULL",
        )?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

/// The scopes held locally that the server no longer lists for this
/// account: the owner stopped sharing the folder, or removed this member.
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

/// Remove the shared folders this account has lost. `live_scopes` must be
/// every shared collection the server lists for the account, from a listing
/// that ran to its end: a folder is removed for being absent from it, so a
/// partial list would remove folders that are still shared. A local root
/// only exists after a first pull, so there is no half-arrived folder to
/// take for a lost one.
pub(crate) fn reconcile_revoked_shares(db: &Db, live_scopes: &HashSet<String>) -> AppResult<()> {
    let local_scopes = local_received_scopes(db)?;
    for scope in scopes_to_purge(&local_scopes, live_scopes) {
        log::info!("[sharing] shared folder {scope} is no longer accessible; removing it locally");
        purge_local_scope(db, scope)?;
    }
    Ok(())
}

/// Remove the shared folders the server named as lost: ones the account was
/// taken out of, or whose collection was deleted. Of those, only folders
/// that were shared with this account are removed. A folder this account
/// shares is the owner's own content, and when its collection goes the
/// rows come back through the vault.
pub(crate) fn purge_lost_shares(db: &Db, lost: &[String]) -> AppResult<()> {
    if lost.is_empty() {
        return Ok(());
    }
    for scope in local_received_scopes(db)?
        .iter()
        .filter(|scope| lost.contains(scope))
    {
        log::info!("[sharing] shared folder {scope} is no longer accessible; removing it locally");
        purge_local_scope(db, scope)?;
    }
    Ok(())
}

/// Stop sharing a folder the current user owns. The owner keeps the folder:
/// its subtree goes back into the vault as a personal folder. The shared
/// collection is deleted, which is what tells every other member's device
/// to drop its copy.
#[tauri::command]
pub async fn stop_sharing_collection(app: AppHandle, collection_id: String) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = restore_required(&app)?;
        let db = app.state::<Db>();

        let (scope, share_id, _, shared_by_me) =
            share_metadata(&db, &collection_id)?.unwrap_or((None, None, None, false));
        if !shared_by_me && scope.is_none() && share_id.is_none() {
            return Err(AppError::InvalidArg(
                "you're not sharing this folder".into(),
            ));
        }

        // Locally first, so the owner has their content whatever the server
        // call below does.
        db.with_conn(|conn| detach_owner_share(conn, &collection_id))?;

        // Then the collection. A failure leaves the others with access until
        // it is retried, and is not allowed to undo the local step.
        let cm = account
            .collection_manager()
            .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;
        if let Some(uid) = scope.as_deref().or(share_id.as_deref()) {
            match open_space(&cm, uid) {
                Ok(Some(collection)) => delete_best_effort(&cm, collection),
                Ok(None) => {}
                Err(e) => log::warn!("[sharing] fetch {uid} to stop sharing: {e}"),
            }
        }

        Ok::<(), AppError>(())
    })
    .await
    .map_err(|e| format!("stop sharing collection task: {e}"))?
    .map_err(Into::into)
}

/// Delete a shared collection. Failing is logged and no more.
fn delete_best_effort(cm: &CollectionManager, mut collection: Collection) {
    if let Err(e) = collection.delete() {
        log::warn!("[sharing] mark {} deleted: {e}", collection.uid());
        return;
    }
    if let Err(e) = cm.upload(&collection, None) {
        log::warn!("[sharing] upload delete of {}: {e}", collection.uid());
    }
}
