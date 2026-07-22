//! Collections (folders) — CRUD + Tauri commands.

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::error::{AppError, AppResult, CommandResult};
use crate::serde_helpers::double_option;

/// Public-facing folder shape. Position is the sort index inside the
/// parent (or root, if parent is None).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Collection {
    pub id: String,
    pub parent_collection_id: Option<String>,
    pub name: String,
    pub position: i64,
    pub created: String,
    pub modified: String,
    pub share_id: Option<String>,
    pub shared_role: Option<String>,
    pub shared_owner: Option<String>,
    pub shared_by_me: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateCollection {
    pub name: String,
    pub parent_collection_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateCollection {
    pub id: String,
    pub name: Option<String>,
    /// Outer Some => change parent. Inner Option = the new value
    /// (`Some(id)` to a specific folder, `None` for root).
    /// The custom deserializer is needed because plain
    /// `Option<Option<T>>` collapses `null` into outer `None`,
    /// which would silently turn a 'move to root' into a no-op.
    #[serde(default, deserialize_with = "double_option")]
    pub parent_collection_id: Option<Option<String>>,
    pub position: Option<i64>,
}

/// Reserved id for the always-present trash collection. Refusing mutations
/// against it keeps the file tree's special-cased section stable.
pub const TRASH_ID: &str = "trash";

fn is_trash(id: &str) -> bool {
    id == TRASH_ID
}

/// Stamp `trashed_at` when a note/folder is being moved into the trash,
/// and clear it when moving back out. Called from `notes::update` and
/// `collections::update` after the parent change is applied.
///
/// `COALESCE` on the SET keeps the original timestamp if the row was
/// already in trash and got re-shuffled inside it — retention should
/// run from when the user originally trashed the item, not from the
/// last drag-and-drop within the Trash view.
pub fn stamp_trashed_at_on_parent_change(
    conn: &rusqlite::Connection,
    table: &str,
    id: &str,
    new_parent: Option<&str>,
    now: &str,
) -> AppResult<()> {
    // Hard-coded list avoids passing arbitrary user input into the
    // statement. Only callers in the crate touch this; the table arg
    // is a constant at the call site.
    debug_assert!(matches!(table, "notes" | "collections"));
    if matches!(new_parent, Some(TRASH_ID)) {
        let sql = format!("UPDATE {table} SET trashed_at = COALESCE(trashed_at, ?1) WHERE id = ?2");
        conn.execute(&sql, params![now, id])?;
    } else {
        let sql = format!("UPDATE {table} SET trashed_at = NULL WHERE id = ?1");
        conn.execute(&sql, params![id])?;
    }
    Ok(())
}

fn row_to_collection(row: &rusqlite::Row<'_>) -> rusqlite::Result<Collection> {
    Ok(Collection {
        id: row.get("id")?,
        parent_collection_id: row.get("parent_collection_id")?,
        name: row.get("name")?,
        position: row.get("position")?,
        created: row.get("created")?,
        modified: row.get("modified")?,
        share_id: row.get("share_id")?,
        shared_role: row.get("shared_role")?,
        shared_owner: row.get("shared_owner")?,
        shared_by_me: row.get::<_, i64>("shared_by_me")? != 0,
    })
}

pub fn list(conn: &Connection) -> AppResult<Vec<Collection>> {
    let mut stmt = conn.prepare(
        "SELECT id, parent_collection_id, name, position, created, modified,
                share_id, shared_role, shared_owner, shared_by_me
         FROM collections
         ORDER BY parent_collection_id IS NOT NULL, parent_collection_id, position, name",
    )?;
    let rows = stmt.query_map([], row_to_collection)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn create(conn: &Connection, input: CreateCollection) -> AppResult<Collection> {
    let id = format!("coll_{}", uuid::Uuid::new_v4());
    let now = Utc::now().to_rfc3339();
    let position = next_position(conn, input.parent_collection_id.as_deref())?;
    // Stamp `trashed_at` if the new folder is being created straight
    // into the trash (mirrors the create-note path) so retention has a
    // timestamp to compare against.
    let trashed_at: Option<&str> = if input.parent_collection_id.as_deref() == Some(TRASH_ID) {
        Some(&now)
    } else {
        None
    };
    // Inherit the parent's share scope so a folder created inside a shared
    // subtree is routed into that scope's collection (and pulled by recipients)
    // rather than the vault. Root / vault parent → NULL, i.e. vault-local.
    let share_scope_id = match input.parent_collection_id.as_deref() {
        Some(parent) => crate::sharing::collection_scope(conn, parent)?,
        None => None,
    };
    // dirty defaults to 1 in the schema; row will be picked up by the next sync push.
    conn.execute(
        "INSERT INTO collections(id, parent_collection_id, name, position, created, modified, trashed_at, share_scope_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7)",
        params![
            id,
            input.parent_collection_id,
            input.name,
            position,
            now,
            trashed_at,
            share_scope_id,
        ],
    )?;
    get(conn, &id)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Collection> {
    conn.query_row(
        "SELECT id, parent_collection_id, name, position, created, modified,
                share_id, shared_role, shared_owner, shared_by_me
         FROM collections WHERE id = ?1",
        params![id],
        row_to_collection,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("collection {id}")))
}

pub fn update(conn: &Connection, input: UpdateCollection) -> AppResult<Collection> {
    if is_trash(&input.id) {
        return Err(AppError::InvalidArg(
            "the trash collection cannot be modified".into(),
        ));
    }
    let now = Utc::now().to_rfc3339();
    if let Some(name) = &input.name {
        conn.execute(
            "UPDATE collections SET name = ?1, modified = ?2 WHERE id = ?3",
            params![name, now, input.id],
        )?;
    }
    if let Some(parent) = &input.parent_collection_id {
        // parent: Option<Option<String>> — outer Some means "change", inner Option is the new value.
        if let Some(parent_id) = parent {
            // Refuse self-parent or descendant cycles.
            if parent_id == &input.id {
                return Err(AppError::InvalidArg(
                    "cannot move a collection into itself".into(),
                ));
            }
            if is_descendant(conn, &input.id, parent_id)? {
                return Err(AppError::InvalidArg(
                    "cannot move a collection into one of its descendants".into(),
                ));
            }
        }
        conn.execute(
            "UPDATE collections SET parent_collection_id = ?1, modified = ?2 WHERE id = ?3",
            params![parent, now, input.id],
        )?;
        // Track when the folder enters / leaves the trash so the retention
        // sweep has a real timestamp to age against. `modified` already
        // updated above, but it would tick on every later in-place edit
        // too — `trashed_at` is the dedicated "when did this enter trash"
        // stamp the sweep needs.
        stamp_trashed_at_on_parent_change(conn, "collections", &input.id, parent.as_deref(), &now)?;
        // Re-home the subtree if the move crossed a share-scope boundary: the
        // destination's scope wins (NULL for a root / vault parent). Skip when
        // the moved folder is itself a share anchor — a share root's scope is
        // fixed by the share, so relocating it in the owner's tree must not
        // strip it. Only act on an actual change so an in-scope reorder doesn't
        // needlessly detach + repush every descendant.
        if !crate::sharing::is_share_anchor(conn, &input.id)? {
            let new_scope = match parent.as_deref() {
                Some(parent_id) => crate::sharing::collection_scope(conn, parent_id)?,
                None => None,
            };
            let old_scope = crate::sharing::collection_scope(conn, &input.id)?;
            if new_scope != old_scope {
                crate::sharing::rehome_folder_subtree(conn, &input.id, new_scope.as_deref())?;
            }
        }
    }
    if let Some(position) = input.position {
        conn.execute(
            "UPDATE collections SET position = ?1, modified = ?2 WHERE id = ?3",
            params![position, now, input.id],
        )?;
    }
    // Any update is a sync candidate. Trash itself is rejected above so it
    // never ends up dirty.
    conn.execute(
        "UPDATE collections SET dirty = 1 WHERE id = ?1",
        params![input.id],
    )?;
    get(conn, &input.id)
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    if is_trash(id) {
        return Err(AppError::InvalidArg(
            "the trash collection cannot be deleted".into(),
        ));
    }
    // Queue a server-side delete if this folder had been synced. See the
    // matching path in notes::purge for the same rationale.
    let etebase_uid: Option<String> = conn
        .query_row(
            "SELECT etebase_uid FROM collections WHERE id = ?1",
            params![id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    if let Some(uid) = etebase_uid {
        crate::sync::queue_tombstone(conn, "folder", &uid)?;
    }
    let n = conn.execute("DELETE FROM collections WHERE id = ?1", params![id])?;
    if n == 0 {
        return Err(AppError::NotFound(format!("collection {id}")));
    }
    Ok(())
}

/// Walks the parent chain of `candidate` to see if `ancestor` appears in it.
/// Used to reject moves that would create a cycle.
fn is_descendant(conn: &Connection, ancestor: &str, candidate: &str) -> AppResult<bool> {
    let mut current = candidate.to_string();
    loop {
        let next: Option<Option<String>> = conn
            .query_row(
                "SELECT parent_collection_id FROM collections WHERE id = ?1",
                params![current],
                |r| r.get(0),
            )
            .optional()?;
        match next {
            Some(Some(parent)) => {
                if parent == ancestor {
                    return Ok(true);
                }
                current = parent;
            }
            _ => return Ok(false),
        }
    }
}

fn next_position(conn: &Connection, parent: Option<&str>) -> AppResult<i64> {
    let max: Option<i64> = if let Some(p) = parent {
        conn.query_row(
            "SELECT MAX(position) FROM collections WHERE parent_collection_id = ?1",
            params![p],
            |r| r.get(0),
        )
        .optional()?
        .flatten()
    } else {
        conn.query_row(
            "SELECT MAX(position) FROM collections WHERE parent_collection_id IS NULL",
            [],
            |r| r.get(0),
        )
        .optional()?
        .flatten()
    };
    Ok(max.unwrap_or(-1) + 1)
}

// ---------- Tauri commands ----------

#[tauri::command]
pub fn list_collections(db: tauri::State<'_, Db>) -> CommandResult<Vec<Collection>> {
    db.with_conn(list).map_err(Into::into)
}

#[tauri::command]
pub fn create_collection(
    db: tauri::State<'_, Db>,
    input: CreateCollection,
) -> CommandResult<Collection> {
    db.with_conn(|c| create(c, input)).map_err(Into::into)
}

#[tauri::command]
pub fn update_collection(
    db: tauri::State<'_, Db>,
    input: UpdateCollection,
) -> CommandResult<Collection> {
    db.with_conn(|c| update(c, input)).map_err(Into::into)
}

#[tauri::command]
pub fn delete_collection(db: tauri::State<'_, Db>, id: String) -> CommandResult<()> {
    db.with_conn(|c| delete(c, &id)).map_err(Into::into)
}

#[cfg(test)]
mod tests;
