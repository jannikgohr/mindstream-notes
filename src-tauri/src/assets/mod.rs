//! Asset blobs attached to freeform (drawing) notes.
//!
//! Each asset is the raw byte payload of an image (or, later, any file the
//! user drops onto a drawing canvas). The frontend can store
//! `mindstream-asset://<id>` URLs inside drawing records and call
//! `fetch_drawing_asset` to materialise those into blob URLs at render time.
//!
//! Sync model: the table has the same `dirty` / `etebase_uid` /
//! `etebase_etag` columns as `notes`, but the actual push / pull
//! implementation lives in the follow-up slice. For now uploads land
//! locally with `dirty = 1` so when sync ships nothing needs migrating.

use std::collections::HashMap;
use std::sync::OnceLock;

use chrono::Utc;
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::db::Db;
use crate::error::{AppError, AppResult, CommandResult};
use crate::notes::{self, CreateNote, Note, NoteKind};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetSummary {
    pub id: String,
    pub owning_note_id: String,
    pub mime_type: String,
    pub size: i64,
    pub created: String,
    pub modified: String,
    /// True once the asset's been pushed to the remote (i.e. has an
    /// `etebase_uid`). Mirrors the same field on `NoteSummary`.
    pub pushed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Asset {
    #[serde(flatten)]
    pub summary: AssetSummary,
    /// Raw file bytes. JS receives this as a number array (Tauri's
    /// default Vec<u8> serialisation) and reassembles a `Blob` from it
    /// client-side.
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UploadAsset {
    pub owning_note_id: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportPdfNote {
    pub title: Option<String>,
    pub parent_collection_id: Option<String>,
    pub bytes: Vec<u8>,
}

fn row_to_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<AssetSummary> {
    let etebase_uid: Option<String> = row.get("etebase_uid")?;
    Ok(AssetSummary {
        id: row.get("id")?,
        owning_note_id: row.get("owning_note_id")?,
        mime_type: row.get("mime_type")?,
        size: row.get("size")?,
        created: row.get("created")?,
        modified: row.get("modified")?,
        pushed: etebase_uid.is_some(),
    })
}

pub fn upload(conn: &Connection, input: UploadAsset) -> AppResult<Asset> {
    let id = format!("asset_{}", uuid::Uuid::new_v4());
    upload_with_id(conn, id, input)
}

pub fn upload_with_id(conn: &Connection, id: String, input: UploadAsset) -> AppResult<Asset> {
    // Confirm the owning note exists first — the FK constraint would
    // surface as a generic SQLite error otherwise. A targeted NotFound
    // gives the JS side a useful message to relay if the user trashes
    // the note between the drop and the upload landing.
    let note_exists: bool = conn
        .query_row(
            "SELECT 1 FROM notes WHERE id = ?1",
            params![input.owning_note_id],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if !note_exists {
        return Err(AppError::NotFound(format!(
            "note {} (asset upload)",
            input.owning_note_id
        )));
    }

    let now = Utc::now().to_rfc3339();
    let size = input.bytes.len() as i64;

    // Inherit the owning note's share scope so an image dropped into a shared
    // note is routed into that scope's asset collection (and pulled by
    // recipients) rather than the vault.
    let share_scope_id = crate::sharing::note_scope(conn, &input.owning_note_id)?;

    conn.execute(
        "INSERT INTO assets(id, owning_note_id, mime_type, bytes, size,
                            created, modified, share_scope_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)",
        params![
            id,
            input.owning_note_id,
            input.mime_type,
            input.bytes,
            size,
            now,
            share_scope_id,
        ],
    )?;
    load(conn, &id)
}

pub fn import_pdf_note_inner(conn: &Connection, input: ImportPdfNote) -> AppResult<Note> {
    if input.bytes.is_empty() {
        return Err(AppError::InvalidArg("PDF file is empty".into()));
    }

    let asset_id = format!("asset_{}", uuid::Uuid::new_v4());
    let body = json!({ "pdfAssetId": asset_id }).to_string();
    let note = notes::create(
        conn,
        CreateNote {
            title: input.title,
            body: Some(body),
            parent_collection_id: input.parent_collection_id,
            note_kind: Some(NoteKind::Pdf),
        },
    )?;

    upload_with_id(
        conn,
        asset_id,
        UploadAsset {
            owning_note_id: note.summary.id.clone(),
            mime_type: "application/pdf".into(),
            bytes: input.bytes,
        },
    )?;

    Ok(note)
}

pub fn load(conn: &Connection, id: &str) -> AppResult<Asset> {
    let mut stmt = conn.prepare(
        "SELECT id, owning_note_id, mime_type, bytes, size,
                created, modified, etebase_uid
         FROM assets WHERE id = ?1",
    )?;
    let row_data = stmt
        .query_row(params![id], |row| {
            let summary = row_to_summary(row)?;
            let bytes: Vec<u8> = row.get("bytes")?;
            Ok((summary, bytes))
        })
        .optional()?;

    match row_data {
        Some((summary, bytes)) => Ok(Asset { summary, bytes }),
        None => Err(AppError::NotFound(format!("asset {id}"))),
    }
}

fn asset_url_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| match Regex::new(r"asset:mindstream/([A-Za-z0-9_-]+)") {
        Ok(re) => Some(re),
        Err(err) => {
            log::error!("[assets] invalid asset URL regex: {err}");
            None
        }
    })
    .as_ref()
}

fn count_asset_refs(body: &str, counts: &mut HashMap<String, usize>) {
    if let Some(re) = asset_url_re() {
        for captures in re.captures_iter(body) {
            if let Some(id) = captures.get(1) {
                *counts.entry(id.as_str().to_string()).or_default() += 1;
            }
        }
    }
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(id) = parsed.get("pdfAssetId").and_then(|v| v.as_str()) {
            *counts.entry(id.to_string()).or_default() += 1;
        }
    }
}

pub(crate) fn asset_reference_counts(
    conn: &Connection,
    note_id: &str,
) -> AppResult<HashMap<String, usize>> {
    let mut counts = HashMap::new();
    let current: Option<(NoteKind, String)> = conn
        .query_row(
            "SELECT note_kind, body FROM notes WHERE id = ?1",
            params![note_id],
            |r| Ok((r.get::<_, NoteKind>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((note_kind, body)) = current else {
        return Ok(counts);
    };
    count_asset_refs(&body, &mut counts);

    if !note_kind.is_markdown() {
        return Ok(counts);
    }

    let mut stmt = conn.prepare(
        "SELECT body FROM note_versions
         WHERE note_id = ?1 AND note_kind = 'markdown'",
    )?;
    let rows = stmt.query_map(params![note_id], |r| r.get::<_, Vec<u8>>(0))?;
    for row in rows {
        let snapshot = crate::history::decompress_snapshot(&row?)?;
        count_asset_refs(&snapshot, &mut counts);
    }
    Ok(counts)
}

pub(crate) fn purge_unreferenced_markdown_assets(
    conn: &Connection,
    note_id: &str,
) -> AppResult<usize> {
    let note_kind: Option<NoteKind> = conn
        .query_row(
            "SELECT note_kind FROM notes WHERE id = ?1",
            params![note_id],
            |r| r.get(0),
        )
        .optional()?;
    if note_kind != Some(NoteKind::Markdown) {
        return Ok(0);
    }

    let refs = asset_reference_counts(conn, note_id)?;
    let mut stmt = conn.prepare(
        "SELECT id, etebase_uid FROM assets
         WHERE owning_note_id = ?1",
    )?;
    let rows = stmt.query_map(params![note_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
    })?;
    let assets = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    let mut removed = 0usize;
    for (asset_id, etebase_uid) in assets {
        if refs.contains_key(&asset_id) {
            continue;
        }
        if let Some(uid) = etebase_uid {
            crate::sync::queue_tombstone(conn, "asset", &uid)?;
        }
        removed += conn.execute("DELETE FROM assets WHERE id = ?1", params![asset_id])?;
    }
    Ok(removed)
}

pub(crate) fn sweep_unreferenced_markdown_assets_inner(conn: &Connection) -> AppResult<usize> {
    let note_ids = {
        let mut stmt = conn.prepare(
            "SELECT id FROM notes
             WHERE note_kind = 'markdown'",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let mut removed = 0usize;
    for note_id in note_ids {
        removed += purge_unreferenced_markdown_assets(conn, &note_id)?;
    }
    Ok(removed)
}

// ---------- Tauri commands ----------

#[tauri::command]
pub fn upload_drawing_asset(db: tauri::State<'_, Db>, input: UploadAsset) -> CommandResult<Asset> {
    db.with_conn(|c| upload(c, input)).map_err(Into::into)
}

#[tauri::command]
pub fn fetch_drawing_asset(db: tauri::State<'_, Db>, id: String) -> CommandResult<Asset> {
    db.with_conn(|c| load(c, &id)).map_err(Into::into)
}

#[tauri::command]
pub fn import_pdf_note(db: tauri::State<'_, Db>, input: ImportPdfNote) -> CommandResult<Note> {
    db.with_conn(|c| import_pdf_note_inner(c, input))
        .map_err(Into::into)
}

#[tauri::command]
pub fn sweep_unreferenced_markdown_assets(db: tauri::State<'_, Db>) -> CommandResult<usize> {
    db.with_conn(sweep_unreferenced_markdown_assets_inner)
        .map_err(Into::into)
}

#[cfg(test)]
mod tests;
