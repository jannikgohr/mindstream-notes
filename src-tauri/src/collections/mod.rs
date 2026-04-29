//! Collections (folders) — CRUD + Tauri commands.

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::error::{AppError, AppResult};

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
    pub parent_collection_id: Option<Option<String>>,
    pub position: Option<i64>,
}

fn row_to_collection(row: &rusqlite::Row<'_>) -> rusqlite::Result<Collection> {
    Ok(Collection {
        id: row.get("id")?,
        parent_collection_id: row.get("parent_collection_id")?,
        name: row.get("name")?,
        position: row.get("position")?,
        created: row.get("created")?,
        modified: row.get("modified")?,
    })
}

pub fn list(conn: &Connection) -> AppResult<Vec<Collection>> {
    let mut stmt = conn.prepare(
        "SELECT id, parent_collection_id, name, position, created, modified
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
    conn.execute(
        "INSERT INTO collections(id, parent_collection_id, name, position, created, modified)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![
            id,
            input.parent_collection_id,
            input.name,
            position,
            now
        ],
    )?;
    get(conn, &id)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Collection> {
    conn.query_row(
        "SELECT id, parent_collection_id, name, position, created, modified
         FROM collections WHERE id = ?1",
        params![id],
        row_to_collection,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("collection {id}")))
}

pub fn update(conn: &Connection, input: UpdateCollection) -> AppResult<Collection> {
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
    }
    if let Some(position) = input.position {
        conn.execute(
            "UPDATE collections SET position = ?1, modified = ?2 WHERE id = ?3",
            params![position, now, input.id],
        )?;
    }
    get(conn, &input.id)
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
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
pub fn list_collections(db: tauri::State<'_, Db>) -> Result<Vec<Collection>, String> {
    db.with_conn(|c| list(c)).map_err(Into::into)
}

#[tauri::command]
pub fn create_collection(
    db: tauri::State<'_, Db>,
    input: CreateCollection,
) -> Result<Collection, String> {
    db.with_conn(|c| create(c, input)).map_err(Into::into)
}

#[tauri::command]
pub fn update_collection(
    db: tauri::State<'_, Db>,
    input: UpdateCollection,
) -> Result<Collection, String> {
    db.with_conn(|c| update(c, input)).map_err(Into::into)
}

#[tauri::command]
pub fn delete_collection(db: tauri::State<'_, Db>, id: String) -> Result<(), String> {
    db.with_conn(|c| delete(c, &id)).map_err(Into::into)
}
