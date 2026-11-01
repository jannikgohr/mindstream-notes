//! The SQLite side of sharing: stamping local rows with their scope,
//! re-homing subtrees into a scope, and reading back share state.

use super::*;

/// Stamp the local root folder as shared by this account. `scope` is the
/// uid of the shared collection, which is both what the rows under the root
/// are tagged with and what marks the root as the top of a share. Whoever
/// shares a folder is its admin.
pub(super) fn record_outgoing_share(
    conn: &Connection,
    collection_id: &str,
    scope: &str,
    owner: Option<&str>,
) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    let role_db = share_access_level_to_db(ShareAccessLevel::Admin);
    conn.execute(
        "UPDATE collections
            SET share_scope_id = ?1,
                share_id = ?1,
                shared_role = ?2,
                shared_owner = ?3,
                shared_by_me = 1,
                modified = ?4
          WHERE id = ?5",
        params![scope, role_db, owner, now, collection_id],
    )?;
    Ok(())
}

/// Move a folder into its shared collection on this device: stamp every
/// folder, note and attachment under it with the scope and detach it from
/// where it was, so the next sync creates it there. `created` says the
/// collection was made just now, which is when the folder's root is marked
/// as shared by this account.
///
/// A folder that was shared already is in its collection, and what was
/// added to it since inherited the scope as it was added. There is nothing
/// to move then, and moving it anyway would delete and recreate every item
/// for every member.
pub(super) fn move_into_space(
    conn: &Connection,
    collection_id: &str,
    scope: &str,
    created: bool,
    owner: Option<&str>,
) -> AppResult<()> {
    if created || subtree_outside_scope(conn, collection_id, scope)? {
        rehome_folder_subtree(conn, collection_id, Some(scope))?;
    }
    if created {
        record_outgoing_share(conn, collection_id, scope, owner)?;
    }
    Ok(())
}

/// Whether anything under a folder, the folder included, is tagged with
/// something other than `scope`. Rows added to a shared folder inherit its
/// scope as they are added, so this is false for a folder that has been
/// shared all along, and inviting someone else then has nothing to move.
pub(super) fn subtree_outside_scope(
    conn: &Connection,
    root_folder_id: &str,
    scope: &str,
) -> AppResult<bool> {
    Ok(conn.query_row(
        "WITH RECURSIVE subtree(id) AS (
            SELECT ?1
            UNION ALL
            SELECT c.id FROM collections c JOIN subtree s ON c.parent_collection_id = s.id
        )
        SELECT EXISTS(
            SELECT 1 FROM collections
             WHERE id IN (SELECT id FROM subtree) AND share_scope_id IS NOT ?2
        ) OR EXISTS(
            SELECT 1 FROM notes
             WHERE parent_collection_id IN (SELECT id FROM subtree)
               AND share_scope_id IS NOT ?2
        )",
        params![root_folder_id, scope],
        |row| row.get(0),
    )?)
}

/// Reverse a share on the owner's side, locally: re-home the folder's subtree
/// from its shared scope back into the vault (so the owner keeps the content as a
/// personal folder) and strip the anchor's share membership columns. The caller
/// revokes the server-side scope collections separately. Pure DB mutation, so it
/// is unit-testable without a server.
pub(super) fn detach_owner_share(conn: &Connection, root_folder_id: &str) -> AppResult<()> {
    // Only re-home when the folder is actually scoped: rehome detaches + repushes
    // the whole subtree, which is needless churn (and tombstones vault items) if
    // the share was already broken with a NULL scope. Either way we clear the
    // anchor's share columns below so it reads as an ordinary personal folder.
    let scope: Option<String> = conn
        .query_row(
            "SELECT share_scope_id FROM collections WHERE id = ?1",
            params![root_folder_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    if scope.is_some() {
        // Subtree home to the vault: tombstones the scoped rows, clears
        // share_scope_id across the subtree, and marks dirty for the vault push.
        rehome_folder_subtree(conn, root_folder_id, None)?;
    }
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE collections
            SET shared_by_me = 0,
                share_id = NULL,
                shared_role = NULL,
                shared_owner = NULL,
                share_scope_id = NULL,
                modified = ?1
          WHERE id = ?2",
        params![now, root_folder_id],
    )?;
    Ok(())
}

/// Re-home a folder subtree into `target_scope` (`None` = the vault).
///
/// For every folder under `root_folder_id` (inclusive) and every note/asset
/// beneath them: queue a delete for anything already pushed (done first, so
/// `queue_tombstone` reads each row's *current* `share_scope_id` and routes the
/// delete to the collection the row currently lives in — the vault when the
/// subtree was unscoped, or the source scope when moving between shares), then
/// stamp the target scope, clear `etebase_uid`, and mark dirty so the next sync
/// creates it fresh in the target collection. This is the "one home" model — a
/// row lives only in its scope collection. Idempotent: rows already at the
/// target have no `etebase_uid` and so queue no tombstone.
///
/// Callers must only invoke this when the scope actually changes; it always
/// detaches + repushes, which is wasted churn when source == target. Callers
/// must also skip folders that are themselves a share anchor (`share_id` set) —
/// a share root's scope is defined by the share, not by where it sits in the
/// owner's tree, so moving it around must not strip the scope.
///
/// Transient window: this is a detach-then-repush, so a *second* owner device
/// that syncs after the source delete lands but before the row becomes a
/// reachable member of the target scope briefly sees the subtree empty. It
/// self-heals once the device pulls the re-homed rows; no data is lost.
///
/// Refuses a shared target while a demo note is in the subtree, before
/// changing anything (see [`crate::demo_notes`]).
pub(crate) fn rehome_folder_subtree(
    conn: &Connection,
    root_folder_id: &str,
    target_scope: Option<&str>,
) -> AppResult<()> {
    mindstream_storage_core::sharing::rehome_folder_subtree(conn, root_folder_id, target_scope)
        .map_err(Into::into)
}

#[cfg(test)]
pub fn rehome_note_subtree(
    conn: &Connection,
    note_id: &str,
    target_scope: Option<&str>,
) -> AppResult<()> {
    mindstream_storage_core::sharing::rehome_note_subtree(conn, note_id, target_scope)
        .map_err(Into::into)
}

pub fn collection_scope(conn: &Connection, id: &str) -> AppResult<Option<String>> {
    mindstream_storage_core::sharing::collection_scope(conn, id).map_err(Into::into)
}

#[cfg(test)]
pub fn note_scope(conn: &Connection, id: &str) -> AppResult<Option<String>> {
    mindstream_storage_core::sharing::note_scope(conn, id).map_err(Into::into)
}

#[cfg(test)]
pub fn is_share_anchor(conn: &Connection, id: &str) -> AppResult<bool> {
    mindstream_storage_core::sharing::is_share_anchor(conn, id).map_err(Into::into)
}

pub(super) fn local_share_state(
    conn: &Connection,
    collection_id: &str,
) -> AppResult<CollectionShareState> {
    conn.query_row(
        "SELECT id, share_id, shared_role, shared_owner, shared_by_me
           FROM collections
          WHERE id = ?1",
        params![collection_id],
        |row| {
            let role: Option<String> = row.get(2)?;
            Ok(CollectionShareState {
                collection_id: row.get(0)?,
                share_id: row.get(1)?,
                shared_role: role.as_deref().and_then(share_access_level_from_db),
                shared_owner: row.get(3)?,
                shared_by_me: row.get::<_, i64>(4)? != 0,
                members: Vec::new(),
                outgoing_invitations: Vec::new(),
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("collection {collection_id}")))
}

pub(crate) fn share_access_level_to_db(value: ShareAccessLevel) -> &'static str {
    match value {
        ShareAccessLevel::ReadOnly => "read_only",
        ShareAccessLevel::ReadWrite => "read_write",
        ShareAccessLevel::Admin => "admin",
    }
}

pub(super) fn share_access_level_from_db(value: &str) -> Option<ShareAccessLevel> {
    match value {
        "read_only" => Some(ShareAccessLevel::ReadOnly),
        "read_write" => Some(ShareAccessLevel::ReadWrite),
        "admin" => Some(ShareAccessLevel::Admin),
        _ => None,
    }
}
