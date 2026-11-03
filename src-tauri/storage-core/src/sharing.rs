//! Local write checks. Sync apply deliberately bypasses these user-mutation guards.
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};

pub fn ensure_collection_writable(conn: &Connection, id: &str) -> AppResult<()> {
    let denied: bool = conn.query_row(
        "WITH RECURSIVE ancestors(id, parent_collection_id, share_scope_id, shared_role, shared_by_me) AS (
            SELECT id, parent_collection_id, share_scope_id, shared_role, shared_by_me FROM collections WHERE id = ?1
            UNION
            SELECT c.id, c.parent_collection_id, c.share_scope_id, c.shared_role, c.shared_by_me
            FROM collections c JOIN ancestors a ON a.parent_collection_id = c.id
        )
        SELECT EXISTS(SELECT 1 FROM ancestors a WHERE
            (a.shared_role = 'read_only' AND a.shared_by_me = 0)
            OR EXISTS(SELECT 1 FROM collections owner WHERE owner.share_scope_id = a.share_scope_id
                AND owner.shared_role = 'read_only' AND owner.shared_by_me = 0))",
        params![id], |r| r.get(0),
    )?;
    if denied {
        return Err(AppError::InvalidArg(
            "This shared folder is read-only".into(),
        ));
    }
    Ok(())
}

pub fn ensure_parent_writable(conn: &Connection, parent: Option<&str>) -> AppResult<()> {
    if let Some(id) = parent {
        ensure_collection_writable(conn, id)?;
    }
    Ok(())
}

pub fn ensure_note_writable(conn: &Connection, id: &str) -> AppResult<()> {
    let row: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT parent_collection_id, share_scope_id FROM notes WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((parent, scope)) = row else {
        return Ok(());
    };
    ensure_parent_writable(conn, parent.as_deref())?;
    if let Some(scope) = scope {
        let denied: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM collections WHERE share_scope_id = ?1 AND shared_role = 'read_only' AND shared_by_me = 0)",
            params![scope], |r| r.get(0),
        )?;
        if denied {
            return Err(AppError::InvalidArg("This shared note is read-only".into()));
        }
    }
    Ok(())
}

pub fn ensure_subtree_writable(conn: &Connection, id: &str) -> AppResult<()> {
    ensure_collection_writable(conn, id)?;
    let denied: bool = conn.query_row(
        "WITH RECURSIVE subtree(id) AS (
            SELECT id FROM collections WHERE id = ?1 UNION
            SELECT c.id FROM collections c JOIN subtree s ON c.parent_collection_id = s.id
        ) SELECT EXISTS(SELECT 1 FROM collections c JOIN subtree s ON c.id = s.id
            WHERE (c.shared_role = 'read_only' AND c.shared_by_me = 0)
            OR EXISTS(SELECT 1 FROM collections owner WHERE owner.share_scope_id = c.share_scope_id
                AND owner.shared_role = 'read_only' AND owner.shared_by_me = 0))
            OR EXISTS(SELECT 1 FROM notes n JOIN subtree s ON n.parent_collection_id = s.id
                JOIN collections owner ON owner.share_scope_id = n.share_scope_id
                WHERE owner.shared_role = 'read_only' AND owner.shared_by_me = 0)",
        params![id],
        |r| r.get(0),
    )?;
    if denied {
        return Err(AppError::InvalidArg(
            "This folder contains a read-only share".into(),
        ));
    }
    Ok(())
}

use chrono::Utc;
use std::collections::HashSet;
pub fn rehome_folder_subtree(
    conn: &Connection,
    root_folder_id: &str,
    target_scope: Option<&str>,
) -> AppResult<()> {
    const SUBTREE_CTE: &str = "WITH RECURSIVE subtree(id) AS (
            SELECT ?1
            UNION ALL
            SELECT c.id FROM collections c JOIN subtree s ON c.parent_collection_id = s.id
        )";

    if target_scope.is_some() {
        crate::demo_notes::ensure_folder_shareable(conn, root_folder_id)?;
    }

    // 1. Queue tombstones for already-pushed rows before we stamp/detach, so
    //    each delete routes to the row's current (source) scope collection.
    let folder_uids = collect_uids(
        conn,
        &format!("{SUBTREE_CTE} SELECT etebase_uid FROM collections WHERE id IN (SELECT id FROM subtree) AND etebase_uid IS NOT NULL"),
        root_folder_id,
    )?;
    for uid in &folder_uids {
        crate::tombstones::queue_tombstone(conn, "folder", uid)?;
    }
    let note_uids = collect_uids(
        conn,
        &format!("{SUBTREE_CTE} SELECT etebase_uid FROM notes WHERE parent_collection_id IN (SELECT id FROM subtree) AND etebase_uid IS NOT NULL"),
        root_folder_id,
    )?;
    for uid in &note_uids {
        crate::tombstones::queue_tombstone(conn, "note", uid)?;
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
        &format!("{SUBTREE_CTE} UPDATE collections SET share_scope_id = ?2, etebase_uid = NULL, dirty = 1, released = 0 WHERE id IN (SELECT id FROM subtree)"),
        params![root_folder_id, target_scope],
    )?;
    conn.execute(
        &format!("{SUBTREE_CTE} UPDATE notes SET share_scope_id = ?2, etebase_uid = NULL, dirty = 1, released = 0 WHERE parent_collection_id IN (SELECT id FROM subtree)"),
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
/// A demo note is refused a shared target, as in [`rehome_folder_subtree`].
pub fn rehome_note_subtree(
    conn: &Connection,
    note_id: &str,
    target_scope: Option<&str>,
) -> AppResult<()> {
    if target_scope.is_some() {
        crate::demo_notes::ensure_note_shareable(note_id)?;
    }
    if let Some(uid) = conn
        .query_row(
            "SELECT etebase_uid FROM notes WHERE id = ?1",
            params![note_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
    {
        crate::tombstones::queue_tombstone(conn, "note", &uid)?;
    }
    conn.execute(
        "UPDATE notes SET share_scope_id = ?2, etebase_uid = NULL, dirty = 1, released = 0 WHERE id = ?1",
        params![note_id, target_scope],
    )?;
    rehome_assets_for_notes(conn, &[note_id.to_string()], target_scope)?;
    Ok(())
}

#[derive(Debug)]
pub struct RehomeAsset {
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
pub fn rehome_assets_for_notes(
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
                crate::tombstones::queue_tombstone(conn, "asset", uid)?;
            }
            conn.execute(
                "UPDATE assets SET owning_note_id = ?1, share_scope_id = ?2,
                        etebase_uid = NULL, modified = ?3, dirty = 1, released = 0 WHERE id = ?4",
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

pub fn record_asset_remap(
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

pub fn find_asset_in_scope(
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

pub fn rewrite_note_asset_id(
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
        state.map(|bytes| crate::yrs_doc::replace_asset_id(&bytes, old_id, new_id));
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
pub fn collection_scope(conn: &Connection, id: &str) -> AppResult<Option<String>> {
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
pub fn note_scope(conn: &Connection, id: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT share_scope_id FROM notes WHERE id = ?1",
            params![id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

/// Whether a folder is a share anchor: the root of a share, whose scope is
/// fixed by the share itself and not inherited from its parent. Both the
/// owner (`record_outgoing_share`) and everyone else (`project_shared_root`)
/// stamp `share_id` on the root only. What is under it carries
/// `share_scope_id` and no `share_id`. Callers use this to leave a share's
/// root in its scope when it is moved.
pub fn is_share_anchor(conn: &Connection, id: &str) -> AppResult<bool> {
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
pub fn collect_uids(conn: &Connection, sql: &str, root_folder_id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params![root_folder_id], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}
