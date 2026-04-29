//! Notes — CRUD + Tauri commands.
//!
//! Two views of a note:
//!   - `NoteSummary`: id, title, parent, modified, position. Cheap to list
//!     and render in the file tree / metadata panel.
//!   - `Note`: NoteSummary + body. Loaded on demand when an editor opens.
//!
//! Soft-delete via `trashed_at`; listing skips trashed unless asked.

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteSummary {
    pub id: String,
    pub parent_collection_id: Option<String>,
    pub title: String,
    pub position: i64,
    pub created: String,
    pub modified: String,
    pub tags: Vec<String>,
    pub trashed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    #[serde(flatten)]
    pub summary: NoteSummary,
    pub body: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateNote {
    pub title: Option<String>,
    pub body: Option<String>,
    pub parent_collection_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateNote {
    pub id: String,
    pub title: Option<String>,
    pub body: Option<String>,
    /// Outer Some => change parent. Inner Option is the new value (None = root).
    pub parent_collection_id: Option<Option<String>>,
    pub position: Option<i64>,
    pub tags: Option<Vec<String>>,
}

fn row_to_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<NoteSummary> {
    let trashed_at: Option<String> = row.get("trashed_at")?;
    Ok(NoteSummary {
        id: row.get("id")?,
        parent_collection_id: row.get("parent_collection_id")?,
        title: row.get("title")?,
        position: row.get("position")?,
        created: row.get("created")?,
        modified: row.get("modified")?,
        tags: Vec::new(),
        trashed: trashed_at.is_some(),
    })
}

fn load_tags(conn: &Connection, note_id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT tag FROM note_tags WHERE note_id = ?1 ORDER BY tag")?;
    let rows = stmt.query_map(params![note_id], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn list(conn: &Connection, include_trashed: bool) -> AppResult<Vec<NoteSummary>> {
    let sql = if include_trashed {
        "SELECT id, parent_collection_id, title, position, created, modified, trashed_at
         FROM notes
         ORDER BY parent_collection_id IS NOT NULL, parent_collection_id, position, title"
    } else {
        "SELECT id, parent_collection_id, title, position, created, modified, trashed_at
         FROM notes
         WHERE trashed_at IS NULL
         ORDER BY parent_collection_id IS NOT NULL, parent_collection_id, position, title"
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], row_to_summary)?;
    let mut summaries = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    for s in &mut summaries {
        s.tags = load_tags(conn, &s.id)?;
    }
    Ok(summaries)
}

pub fn load(conn: &Connection, id: &str) -> AppResult<Note> {
    let mut stmt = conn.prepare(
        "SELECT id, parent_collection_id, title, position, created, modified, trashed_at, body
         FROM notes WHERE id = ?1",
    )?;
    let row_data = stmt
        .query_row(params![id], |row| {
            let summary = row_to_summary(row)?;
            let body: String = row.get("body")?;
            Ok((summary, body))
        })
        .optional()?;

    match row_data {
        Some((mut summary, body)) => {
            summary.tags = load_tags(conn, id)?;
            Ok(Note { summary, body })
        }
        None => Err(AppError::NotFound(format!("note {id}"))),
    }
}

pub fn create(conn: &Connection, input: CreateNote) -> AppResult<Note> {
    let id = format!("note_{}", uuid::Uuid::new_v4());
    let now = Utc::now().to_rfc3339();
    let position = next_position(conn, input.parent_collection_id.as_deref())?;
    let title = input.title.unwrap_or_else(|| "Untitled".to_string());
    let body = input.body.unwrap_or_default();
    conn.execute(
        "INSERT INTO notes(id, parent_collection_id, title, body, position, created, modified)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![id, input.parent_collection_id, title, body, position, now],
    )?;
    load(conn, &id)
}

pub fn update(conn: &mut Connection, input: UpdateNote) -> AppResult<Note> {
    let now = Utc::now().to_rfc3339();
    let tx = conn.transaction()?;

    if let Some(title) = &input.title {
        tx.execute(
            "UPDATE notes SET title = ?1, modified = ?2 WHERE id = ?3",
            params![title, now, input.id],
        )?;
    }
    if let Some(body) = &input.body {
        tx.execute(
            "UPDATE notes SET body = ?1, modified = ?2 WHERE id = ?3",
            params![body, now, input.id],
        )?;
    }
    if let Some(parent) = &input.parent_collection_id {
        tx.execute(
            "UPDATE notes SET parent_collection_id = ?1, modified = ?2 WHERE id = ?3",
            params![parent, now, input.id],
        )?;
    }
    if let Some(position) = input.position {
        tx.execute(
            "UPDATE notes SET position = ?1, modified = ?2 WHERE id = ?3",
            params![position, now, input.id],
        )?;
    }
    if let Some(tags) = &input.tags {
        tx.execute("DELETE FROM note_tags WHERE note_id = ?1", params![input.id])?;
        let mut stmt =
            tx.prepare("INSERT INTO note_tags(note_id, tag) VALUES (?1, ?2)")?;
        for tag in tags {
            stmt.execute(params![input.id, tag])?;
        }
    }

    tx.commit()?;
    load(conn, &input.id)
}

pub fn trash(conn: &Connection, id: &str) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    let n = conn.execute(
        "UPDATE notes SET trashed_at = ?1, modified = ?1 WHERE id = ?2",
        params![now, id],
    )?;
    if n == 0 {
        return Err(AppError::NotFound(format!("note {id}")));
    }
    Ok(())
}

pub fn restore(conn: &Connection, id: &str) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    let n = conn.execute(
        "UPDATE notes SET trashed_at = NULL, modified = ?1 WHERE id = ?2",
        params![now, id],
    )?;
    if n == 0 {
        return Err(AppError::NotFound(format!("note {id}")));
    }
    Ok(())
}

pub fn purge(conn: &Connection, id: &str) -> AppResult<()> {
    let n = conn.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
    if n == 0 {
        return Err(AppError::NotFound(format!("note {id}")));
    }
    Ok(())
}

fn next_position(conn: &Connection, parent: Option<&str>) -> AppResult<i64> {
    let max: Option<i64> = if let Some(p) = parent {
        conn.query_row(
            "SELECT MAX(position) FROM notes WHERE parent_collection_id = ?1",
            params![p],
            |r| r.get(0),
        )
        .optional()?
        .flatten()
    } else {
        conn.query_row(
            "SELECT MAX(position) FROM notes WHERE parent_collection_id IS NULL",
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
pub fn list_notes(
    db: tauri::State<'_, Db>,
    include_trashed: Option<bool>,
) -> Result<Vec<NoteSummary>, String> {
    db.with_conn(|c| list(c, include_trashed.unwrap_or(false)))
        .map_err(Into::into)
}

#[tauri::command]
pub fn load_note(db: tauri::State<'_, Db>, id: String) -> Result<Note, String> {
    db.with_conn(|c| load(c, &id)).map_err(Into::into)
}

#[tauri::command]
pub fn create_note(db: tauri::State<'_, Db>, input: CreateNote) -> Result<Note, String> {
    db.with_conn(|c| create(c, input)).map_err(Into::into)
}

#[tauri::command]
pub fn save_note(db: tauri::State<'_, Db>, input: UpdateNote) -> Result<Note, String> {
    db.with_conn_mut(|c| update(c, input)).map_err(Into::into)
}

#[tauri::command]
pub fn trash_note(db: tauri::State<'_, Db>, id: String) -> Result<(), String> {
    db.with_conn(|c| trash(c, &id)).map_err(Into::into)
}

#[tauri::command]
pub fn restore_note(db: tauri::State<'_, Db>, id: String) -> Result<(), String> {
    db.with_conn(|c| restore(c, &id)).map_err(Into::into)
}

#[tauri::command]
pub fn purge_note(db: tauri::State<'_, Db>, id: String) -> Result<(), String> {
    db.with_conn(|c| purge(c, &id)).map_err(Into::into)
}
