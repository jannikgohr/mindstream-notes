//! The SQLite side of sharing: stamping local rows with their scope,
//! re-homing subtrees into a scope, and reading back share state.

use super::*;

/// Stamp the local root folder as shared-by-me and anchor the scope on it.
pub(super) fn record_outgoing_share(
    conn: &Connection,
    collection_id: &str,
    share_scope_id: &str,
    folders_uid: &str,
    role: ShareAccessLevel,
    owner: Option<&str>,
) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    let role_db = share_access_level_to_db(role);
    conn.execute(
        "UPDATE collections
            SET share_scope_id = ?1,
                share_id = ?2,
                shared_role = ?3,
                shared_owner = ?4,
                shared_by_me = 1,
                modified = ?5
          WHERE id = ?6",
        params![
            share_scope_id,
            folders_uid,
            role_db,
            owner,
            now,
            collection_id
        ],
    )?;
    Ok(())
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
pub(crate) fn rehome_folder_subtree(
    conn: &Connection,
    root_folder_id: &str,
    target_scope: Option<&str>,
) -> AppResult<()> {
    const SUBTREE_CTE: &str = "WITH RECURSIVE subtree(id) AS (
            SELECT ?1
            UNION ALL
            SELECT c.id FROM collections c JOIN subtree s ON c.parent_collection_id = s.id
        )";

    // 1. Queue tombstones for already-pushed rows before we stamp/detach, so
    //    each delete routes to the row's current (source) scope collection.
    let folder_uids = collect_uids(
        conn,
        &format!("{SUBTREE_CTE} SELECT etebase_uid FROM collections WHERE id IN (SELECT id FROM subtree) AND etebase_uid IS NOT NULL"),
        root_folder_id,
    )?;
    for uid in &folder_uids {
        crate::sync::queue_tombstone(conn, "folder", uid)?;
    }
    let note_uids = collect_uids(
        conn,
        &format!("{SUBTREE_CTE} SELECT etebase_uid FROM notes WHERE parent_collection_id IN (SELECT id FROM subtree) AND etebase_uid IS NOT NULL"),
        root_folder_id,
    )?;
    for uid in &note_uids {
        crate::sync::queue_tombstone(conn, "note", uid)?;
    }
    let moving_notes: Vec<String> = {
        let mut stmt = conn.prepare(&format!(
            "{SUBTREE_CTE} SELECT id FROM notes WHERE parent_collection_id IN (SELECT id FROM subtree)"
        ))?;
        let rows = stmt.query_map(params![root_folder_id], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    // 2. Stamp the target scope, detach from the source, and mark dirty.
    conn.execute(
        &format!("{SUBTREE_CTE} UPDATE collections SET share_scope_id = ?2, etebase_uid = NULL, dirty = 1 WHERE id IN (SELECT id FROM subtree)"),
        params![root_folder_id, target_scope],
    )?;
    conn.execute(
        &format!("{SUBTREE_CTE} UPDATE notes SET share_scope_id = ?2, etebase_uid = NULL, dirty = 1 WHERE parent_collection_id IN (SELECT id FROM subtree)"),
        params![root_folder_id, target_scope],
    )?;
    rehome_assets_for_notes(conn, &moving_notes, target_scope)?;
    Ok(())
}

/// Re-home a single note (and its assets) into `target_scope` (`None` = the
/// vault). The note-level analogue of [`rehome_folder_subtree`], for a note that
/// crosses a share boundary without its folder moving (e.g. dragged out of a
/// shared folder into the vault). Same tombstone-in-current-scope-then-restamp
/// ordering; same caller contract (only invoke on an actual scope change).
pub(crate) fn rehome_note_subtree(
    conn: &Connection,
    note_id: &str,
    target_scope: Option<&str>,
) -> AppResult<()> {
    if let Some(uid) = conn
        .query_row(
            "SELECT etebase_uid FROM notes WHERE id = ?1",
            params![note_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
    {
        crate::sync::queue_tombstone(conn, "note", &uid)?;
    }
    conn.execute(
        "UPDATE notes SET share_scope_id = ?2, etebase_uid = NULL, dirty = 1 WHERE id = ?1",
        params![note_id, target_scope],
    )?;
    rehome_assets_for_notes(conn, &[note_id.to_string()], target_scope)?;
    Ok(())
}

#[derive(Debug)]
struct RehomeAsset {
    id: String,
    owner: Option<String>,
    mime_type: String,
    bytes: Vec<u8>,
    size: i64,
    created: String,
    etebase_uid: Option<String>,
    scope: Option<String>,
    content_hash: String,
}

/// Put every asset referenced by `moving_notes` in the same scope as those
/// notes. A blob referenced only by moving notes keeps its id. A blob shared
/// with stationary notes is copied into the target scope and only the moving
/// notes are rewritten to the new id.
fn rehome_assets_for_notes(
    conn: &Connection,
    moving_notes: &[String],
    target_scope: Option<&str>,
) -> AppResult<()> {
    if moving_notes.is_empty() {
        return Ok(());
    }
    let moving: HashSet<&str> = moving_notes.iter().map(String::as_str).collect();
    let mut asset_ids = HashSet::new();
    for note_id in moving_notes {
        let mut stmt = conn.prepare(
            "SELECT asset_id FROM asset_refs WHERE note_id = ?1
             UNION SELECT id FROM assets WHERE owning_note_id = ?1",
        )?;
        let rows = stmt.query_map(params![note_id], |r| r.get::<_, String>(0))?;
        for row in rows {
            asset_ids.insert(row?);
        }
    }
    for asset_id in asset_ids {
        let mut asset = conn.query_row(
            "SELECT id, owning_note_id, mime_type, bytes, size, created,
                    etebase_uid, share_scope_id, COALESCE(content_hash, '')
               FROM assets WHERE id = ?1",
            params![asset_id],
            |r| {
                Ok(RehomeAsset {
                    id: r.get(0)?,
                    owner: r.get(1)?,
                    mime_type: r.get(2)?,
                    bytes: r.get(3)?,
                    size: r.get(4)?,
                    created: r.get(5)?,
                    etebase_uid: r.get(6)?,
                    scope: r.get(7)?,
                    content_hash: r.get(8)?,
                })
            },
        )?;
        if asset.scope.as_deref() == target_scope {
            continue;
        }
        if asset.content_hash.is_empty() {
            asset.content_hash = crate::assets::content_hash(&asset.bytes);
            conn.execute(
                "UPDATE assets SET content_hash = ?1 WHERE id = ?2",
                params![asset.content_hash, asset.id],
            )?;
        }
        let mut refs: Vec<String> = {
            let mut stmt = conn.prepare("SELECT note_id FROM asset_refs WHERE asset_id = ?1")?;
            let rows = stmt.query_map(params![asset.id], |r| r.get(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        // Older sync payloads may have only the creator anchor.
        if refs.is_empty() {
            if let Some(owner) = asset.owner.as_ref() {
                crate::assets::add_ref(conn, &asset.id, owner)?;
                refs.push(owner.clone());
            }
        }
        let moving_refs: Vec<&String> = refs
            .iter()
            .filter(|id| moving.contains(id.as_str()))
            .collect();
        if moving_refs.is_empty() {
            continue;
        }
        let stationary: Vec<&String> = refs
            .iter()
            .filter(|id| !moving.contains(id.as_str()))
            .collect();
        let now = Utc::now().to_rfc3339();

        if stationary.is_empty() {
            // Keep existing ids stable, including identical destination blobs.
            if let Some(uid) = asset.etebase_uid.as_deref() {
                crate::sync::queue_tombstone(conn, "asset", uid)?;
            }
            conn.execute(
                "UPDATE assets SET owning_note_id = ?1, share_scope_id = ?2,
                        etebase_uid = NULL, modified = ?3, dirty = 1 WHERE id = ?4",
                params![moving_refs[0], target_scope, now, asset.id],
            )?;
            continue;
        }

        let target_id = match find_asset_in_scope(conn, target_scope, &asset.content_hash)? {
            Some(id) => id,
            None => {
                let id = format!("asset_{}", uuid::Uuid::new_v4());
                conn.execute(
                    "INSERT INTO assets(id, owning_note_id, mime_type, bytes, size, created,
                                        modified, share_scope_id, content_hash, dirty)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1)",
                    params![
                        id,
                        moving_refs[0],
                        asset.mime_type,
                        asset.bytes,
                        asset.size,
                        asset.created,
                        now,
                        target_scope,
                        asset.content_hash
                    ],
                )?;
                id
            }
        };
        for note_id in moving_refs {
            rewrite_note_asset_id(conn, note_id, &asset.id, &target_id)?;
            record_asset_remap(conn, note_id, &asset.id, &target_id)?;
            conn.execute(
                "DELETE FROM asset_refs WHERE asset_id = ?1 AND note_id = ?2",
                params![asset.id, note_id],
            )?;
            crate::assets::add_ref(conn, &target_id, note_id)?;
        }
        if asset.owner.as_deref().is_none_or(|id| moving.contains(id)) {
            conn.execute(
                "UPDATE assets SET owning_note_id = ?1, modified = ?2, dirty = 1 WHERE id = ?3",
                params![stationary[0], now, asset.id],
            )?;
        }
    }
    Ok(())
}

fn record_asset_remap(
    conn: &Connection,
    note_id: &str,
    old_id: &str,
    new_id: &str,
) -> AppResult<()> {
    // Carry older aliases forward before the old destination is deleted.
    conn.execute(
        "UPDATE asset_id_remaps SET new_asset_id = ?1
          WHERE note_id = ?2 AND new_asset_id = ?3",
        params![new_id, note_id, old_id],
    )?;
    conn.execute(
        "INSERT INTO asset_id_remaps(note_id, old_asset_id, new_asset_id)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(note_id, old_asset_id)
         DO UPDATE SET new_asset_id = excluded.new_asset_id",
        params![note_id, old_id, new_id],
    )?;
    Ok(())
}

fn find_asset_in_scope(
    conn: &Connection,
    scope: Option<&str>,
    hash: &str,
) -> AppResult<Option<String>> {
    let sql = if scope.is_some() {
        "SELECT id FROM assets WHERE share_scope_id = ?1 AND content_hash = ?2 LIMIT 1"
    } else {
        "SELECT id FROM assets WHERE share_scope_id IS NULL AND content_hash = ?2 LIMIT 1"
    };
    Ok(conn
        .query_row(sql, params![scope, hash], |r| r.get(0))
        .optional()?)
}

fn rewrite_note_asset_id(
    conn: &Connection,
    note_id: &str,
    old_id: &str,
    new_id: &str,
) -> AppResult<()> {
    let (body, state): (String, Option<Vec<u8>>) = conn.query_row(
        "SELECT body, yrs_state FROM notes WHERE id = ?1",
        params![note_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let rewritten_body = body.replace(old_id, new_id);
    let rewritten_state =
        state.map(|bytes| crate::sync::yrs_doc::replace_asset_id(&bytes, old_id, new_id));
    conn.execute(
        "UPDATE notes SET body = ?1, yrs_state = ?2, modified = ?3, dirty = 1 WHERE id = ?4",
        params![
            rewritten_body,
            rewritten_state,
            Utc::now().to_rfc3339(),
            note_id
        ],
    )?;
    crate::history::rewrite_asset_id_in_snapshots(conn, note_id, old_id, new_id)
}

/// The share scope a folder currently belongs to (`None` = the vault). Used to
/// inherit a parent's scope on create and to detect scope changes on move.
pub(crate) fn collection_scope(conn: &Connection, id: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT share_scope_id FROM collections WHERE id = ?1",
            params![id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

/// The share scope a note currently belongs to (`None` = the vault). Mirror of
/// [`collection_scope`] for the note move + asset-inherit paths.
pub(crate) fn note_scope(conn: &Connection, id: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT share_scope_id FROM notes WHERE id = ?1",
            params![id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

/// Whether a folder is a share anchor — the root of a share, whose scope is
/// fixed by the share itself rather than inherited from its parent. Both the
/// owner (`record_outgoing_share`) and recipient (`project_shared_root`) stamp
/// `share_id` on the root only; descendants carry `share_scope_id` but no
/// `share_id`. Callers use this to skip re-homing a share root on move.
pub(crate) fn is_share_anchor(conn: &Connection, id: &str) -> AppResult<bool> {
    Ok(conn
        .query_row(
            "SELECT share_id FROM collections WHERE id = ?1",
            params![id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
        .is_some())
}

// `sql` is always a crate-internal literal built from `SUBTREE_CTE` above (no
// user input in the query text); `root_folder_id` is bound as a parameter.
pub(super) fn collect_uids(
    conn: &Connection,
    sql: &str,
    root_folder_id: &str,
) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params![root_folder_id], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// root so the folder shows up in "shared with me" before the scoped sync pulls
/// its real contents.
///
/// `name_override` lets a manifest bundle name the root after the share (e.g.
/// "Project X") instead of the generic "sender's shared collection" fallback
/// used by a bare single-collection accept.
/// Project an accepted remote share onto the local `collections` table: update
/// the row already anchored to `collection_uid`, or insert a placeholder shared
pub(super) fn record_accepted_share(
    conn: &Connection,
    collection_uid: &str,
    role: ShareAccessLevel,
    owner: Option<&str>,
    name_override: Option<&str>,
) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    let role_db = share_access_level_to_db(role);
    let changed = conn.execute(
        "UPDATE collections
            SET shared_role = ?1,
                shared_owner = ?2,
                shared_by_me = 0,
                modified = ?3
          WHERE share_id = ?4",
        params![role_db, owner, now, collection_uid],
    )?;
    if changed > 0 {
        return Ok(());
    }

    let position = conn
        .query_row(
            "SELECT MAX(position) FROM collections WHERE parent_collection_id IS NULL",
            [],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()?
        .flatten()
        .unwrap_or(-1)
        + 1;
    let id = format!("coll_{}", uuid::Uuid::new_v4());
    let name = name_override
        .map(str::to_string)
        .or_else(|| owner.map(|sender| format!("{sender}'s shared collection")))
        .unwrap_or_else(|| "Shared collection".to_string());
    conn.execute(
        "INSERT INTO collections(
            id, parent_collection_id, name, position, created, modified,
            dirty, share_id, shared_role, shared_owner, shared_by_me
         )
         VALUES (?1, NULL, ?2, ?3, ?4, ?4, 0, ?5, ?6, ?7, 0)",
        params![id, name, position, now, collection_uid, role_db, owner],
    )?;
    Ok(())
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
