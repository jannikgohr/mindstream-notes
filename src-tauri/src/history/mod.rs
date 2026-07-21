//! Local, automatic note edit history.
//!
//! Each row in `note_versions` is a point-in-time snapshot of a note's rendered
//! markdown (DEFLATE-compressed). History is deliberately **local and not
//! synced** — every device keeps its own timeline. That's fine because a
//! *restore* is applied by the editor as a normal CRDT edit
//! (`collabServiceCtx.applyTemplate`), so the restored content converges across
//! devices through the existing sync/merge path; replaying an old `yrs_state`
//! blob would be a no-op (its state vector is a subset of the live doc's).
//!
//! Capture is driven from the frontend (idle debounce + on note close + on
//! create/restore). This module owns dedup, the per-version change magnitude
//! (via `similar`), compression, the per-note safety cap, and time-based
//! retention pruning.

use std::io::{Read, Write};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::Utc;
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::content_stats::{token_delta, word_delta};
use crate::db::Db;
use crate::error::{AppError, AppResult};

/// Hard cap on versions kept per note, independent of the time-based retention
/// setting — a safety valve against pathological churn within the window.
const MAX_VERSIONS_PER_NOTE: i64 = 200;
const SNAPSHOT_MARKER: &str = "mindstream-history-snapshot";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionSummary {
    pub id: String,
    pub note_id: String,
    pub created: String,
    pub note_kind: String,
    /// Why this version exists: `created` | `edited` | `reverted`.
    pub action: String,
    /// Future user-named bookmark; always None for now.
    pub label: Option<String>,
    /// For `reverted`: the restore target's version id.
    pub ref_version_id: Option<String>,
    /// For `reverted`: the target's timestamp, denormalised so the
    /// "Reverted to {date}" label survives the target being pruned.
    pub ref_created: Option<String>,
    pub words_added: i64,
    pub words_removed: i64,
    /// Fallback magnitude for word-neutral edits: non-whitespace characters
    /// added/removed vs the previous snapshot (formatting, punctuation, …).
    pub tokens_added: i64,
    pub tokens_removed: i64,
    /// Uncompressed markdown byte length.
    pub size: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Version {
    #[serde(flatten)]
    pub summary: VersionSummary,
    /// Decompressed markdown snapshot.
    pub body: String,
}

fn compress(md: &str) -> AppResult<Vec<u8>> {
    let mut enc = DeflateEncoder::new(Vec::new(), Compression::default());
    enc.write_all(md.as_bytes())?;
    Ok(enc.finish()?)
}

pub(crate) fn decompress_snapshot(bytes: &[u8]) -> AppResult<String> {
    let mut out = String::new();
    DeflateDecoder::new(bytes).read_to_string(&mut out)?;
    Ok(out)
}

fn serialize_yjs_snapshot(note_kind: &str, bytes: &[u8]) -> AppResult<String> {
    Ok(serde_json::json!({
        "marker": SNAPSHOT_MARKER,
        "version": 1,
        "noteKind": note_kind,
        "payloadKind": "yjs-update",
        "encoding": "base64",
        "data": BASE64_STANDARD.encode(bytes),
    })
    .to_string())
}

/// Read a note's saved fields. Lock-cheap: a single indexed lookup, no
/// encoding — callers build the snapshot off the DB lock via `build_snapshot`.
fn read_note_raw(conn: &Connection, note_id: &str) -> AppResult<(String, String, Option<Vec<u8>>)> {
    let row = conn
        .query_row(
            "SELECT note_kind, body, yrs_state FROM notes WHERE id = ?1",
            params![note_id],
            |r| {
                Ok((
                    r.get::<_, String>("note_kind")?,
                    r.get::<_, String>("body")?,
                    r.get::<_, Option<Vec<u8>>>("yrs_state")?,
                ))
            },
        )
        .optional()?;
    row.ok_or_else(|| AppError::NotFound(format!("note {note_id}")))
}

/// Build the history snapshot string for a note. Markdown keeps its body
/// verbatim; other kinds wrap the saved Yjs state in a base64 envelope. Pure
/// CPU work — the base64 of a large canvas must not run under the DB lock.
fn build_snapshot(note_kind: &str, body: String, yrs_state: Option<Vec<u8>>) -> AppResult<String> {
    if note_kind == "markdown" {
        Ok(body)
    } else {
        serialize_yjs_snapshot(note_kind, &yrs_state.unwrap_or_default())
    }
}

#[cfg(test)]
fn current_note_snapshot(conn: &Connection, note_id: &str) -> AppResult<(String, String)> {
    let (note_kind, body, yrs_state) = read_note_raw(conn, note_id)?;
    let snapshot = build_snapshot(&note_kind, body, yrs_state)?;
    Ok((note_kind, snapshot))
}

fn row_to_summary(r: &Row<'_>) -> rusqlite::Result<VersionSummary> {
    Ok(VersionSummary {
        id: r.get("id")?,
        note_id: r.get("note_id")?,
        created: r.get("created")?,
        note_kind: r.get("note_kind")?,
        action: r.get("action")?,
        label: r.get("label")?,
        ref_version_id: r.get("ref_version_id")?,
        ref_created: r.get("ref_created")?,
        words_added: r.get("words_added")?,
        words_removed: r.get("words_removed")?,
        tokens_added: r.get("tokens_added")?,
        tokens_removed: r.get("tokens_removed")?,
        size: r.get("size")?,
    })
}

/// The newest version's (compressed) body — the dedup baseline and magnitude
/// reference. Lock-cheap: a single indexed read. Callers decompress off-lock.
fn latest_version_blob(conn: &Connection, note_id: &str) -> AppResult<Option<Vec<u8>>> {
    Ok(conn
        .query_row(
            "SELECT body FROM note_versions WHERE note_id = ?1
             ORDER BY created DESC, rowid DESC LIMIT 1",
            params![note_id],
            |r| r.get::<_, Vec<u8>>(0),
        )
        .optional()?)
}

/// A version row whose body is already compressed, ready to insert. Built off
/// the DB lock so the expensive diff/compress never holds the connection.
struct PreparedVersion {
    id: String,
    note_id: String,
    created: String,
    note_kind: String,
    action: String,
    ref_version_id: Option<String>,
    words_added: i64,
    words_removed: i64,
    tokens_added: i64,
    tokens_removed: i64,
    compressed: Vec<u8>,
    size: i64,
}

/// Decide whether `markdown` creates a new version and, if so, pre-compute and
/// compress everything the insert needs. `prev_md` is the decompressed previous
/// snapshot, or `None` when the note has no versions yet. Returns `None` for a
/// dedup no-op. Pure CPU work — no DB access, so it runs with the lock released.
fn prepare_version(
    prev_md: Option<String>,
    note_id: &str,
    note_kind: &str,
    action: &str,
    ref_version_id: Option<&str>,
    markdown: &str,
) -> AppResult<Option<PreparedVersion>> {
    let existed = prev_md.is_some();
    let prev_md = prev_md.unwrap_or_default();

    // Dedup: unchanged content never creates a version.
    if existed && prev_md == markdown {
        return Ok(None);
    }

    // The first snapshot of a note is its creation point.
    let action = if existed { action } else { "created" };
    let (words_added, words_removed, tokens_added, tokens_removed) = if note_kind == "markdown" {
        let (words_added, words_removed) = word_delta(&prev_md, markdown);
        let (tokens_added, tokens_removed) = token_delta(&prev_md, markdown);
        (words_added, words_removed, tokens_added, tokens_removed)
    } else {
        // Non-markdown snapshots are encoded binary payloads. Running the
        // markdown word/char diff over a large base64 Yjs envelope can stall
        // the app for seconds or minutes, so use a cheap size delta instead.
        let prev_len = prev_md.len() as i64;
        let next_len = markdown.len() as i64;
        let tokens_added = (next_len - prev_len).max(0);
        let tokens_removed = (prev_len - next_len).max(0);
        (0, 0, tokens_added, tokens_removed)
    };

    Ok(Some(PreparedVersion {
        id: format!("ver_{}", uuid::Uuid::new_v4()),
        note_id: note_id.to_string(),
        created: Utc::now().to_rfc3339(),
        note_kind: note_kind.to_string(),
        action: action.to_string(),
        ref_version_id: ref_version_id.map(str::to_string),
        words_added,
        words_removed,
        tokens_added,
        tokens_removed,
        compressed: compress(markdown)?,
        size: markdown.len() as i64,
    }))
}

/// Insert a prepared version and enforce the per-note cap. Lock-cheap: index
/// lookups plus one insert. Denormalises the restore target's timestamp so a
/// `reverted` label outlives its target being pruned.
fn insert_prepared(conn: &Connection, prepared: PreparedVersion) -> AppResult<VersionSummary> {
    let ref_created: Option<String> = if prepared.action == "reverted" {
        match prepared.ref_version_id.as_deref() {
            Some(target) => conn
                .query_row(
                    "SELECT created FROM note_versions WHERE id = ?1",
                    params![target],
                    |r| r.get::<_, String>(0),
                )
                .optional()?,
            None => None,
        }
    } else {
        None
    };

    conn.execute(
        "INSERT INTO note_versions
            (id, note_id, created, note_kind, action, label, ref_version_id,
             ref_created, words_added, words_removed, tokens_added,
             tokens_removed, body, size)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            prepared.id,
            prepared.note_id,
            prepared.created,
            prepared.note_kind,
            prepared.action,
            prepared.ref_version_id,
            ref_created,
            prepared.words_added,
            prepared.words_removed,
            prepared.tokens_added,
            prepared.tokens_removed,
            prepared.compressed,
            prepared.size,
        ],
    )?;

    enforce_cap(conn, &prepared.note_id)?;

    Ok(VersionSummary {
        id: prepared.id,
        note_id: prepared.note_id,
        created: prepared.created,
        note_kind: prepared.note_kind,
        action: prepared.action,
        label: None,
        ref_version_id: prepared.ref_version_id,
        ref_created,
        words_added: prepared.words_added,
        words_removed: prepared.words_removed,
        tokens_added: prepared.tokens_added,
        tokens_removed: prepared.tokens_removed,
        size: prepared.size,
    })
}

/// Capture a snapshot of `markdown` for `note_id`. Returns `None` when the
/// snapshot is a no-op (identical to the note's latest version). The first
/// version a note ever gets is promoted to `action = 'created'`.
///
/// This runs every phase under the caller's single `conn` (e.g. tests). The
/// Tauri commands instead use [`capture_off_lock`] to keep the diff/compress
/// off the DB lock.
pub fn capture(
    conn: &Connection,
    note_id: &str,
    note_kind: &str,
    action: &str,
    ref_version_id: Option<&str>,
    markdown: &str,
) -> AppResult<Option<VersionSummary>> {
    let prev_md = latest_version_blob(conn, note_id)?
        .as_deref()
        .map(decompress_snapshot)
        .transpose()?;
    let Some(prepared) = prepare_version(
        prev_md,
        note_id,
        note_kind,
        action,
        ref_version_id,
        markdown,
    )?
    else {
        return Ok(None);
    };
    Ok(Some(insert_prepared(conn, prepared)?))
}

/// Phased capture for the command path: read the dedup baseline under the lock,
/// decompress + diff + compress with the lock released, then re-acquire only to
/// insert. Keeps a heavy capture from stalling unrelated DB work.
fn capture_off_lock(
    db: &Db,
    note_id: &str,
    note_kind: &str,
    action: &str,
    ref_version_id: Option<&str>,
    markdown: &str,
) -> AppResult<Option<VersionSummary>> {
    let prev_md = db
        .with_conn(|c| latest_version_blob(c, note_id))?
        .as_deref()
        .map(decompress_snapshot)
        .transpose()?;
    let Some(prepared) = prepare_version(
        prev_md,
        note_id,
        note_kind,
        action,
        ref_version_id,
        markdown,
    )?
    else {
        return Ok(None);
    };
    Ok(Some(db.with_conn(|c| insert_prepared(c, prepared))?))
}

/// Trim a note back to the newest `MAX_VERSIONS_PER_NOTE` versions.
fn enforce_cap(conn: &Connection, note_id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM note_versions
         WHERE note_id = ?1 AND id NOT IN (
            SELECT id FROM note_versions WHERE note_id = ?1
            ORDER BY created DESC, rowid DESC LIMIT ?2
         )",
        params![note_id, MAX_VERSIONS_PER_NOTE],
    )?;
    Ok(())
}

/// All versions for a note, newest first, without the (compressed) body.
pub fn list(conn: &Connection, note_id: &str) -> AppResult<Vec<VersionSummary>> {
    let mut stmt = conn.prepare(
        "SELECT id, note_id, created, note_kind, action, label, ref_version_id,
                ref_created, words_added, words_removed, tokens_added,
                tokens_removed, size
         FROM note_versions WHERE note_id = ?1
         ORDER BY created DESC, rowid DESC",
    )?;
    let rows = stmt.query_map(params![note_id], row_to_summary)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// One version with its decompressed markdown body.
pub fn load(conn: &Connection, version_id: &str) -> AppResult<Version> {
    let row = conn
        .query_row(
            "SELECT id, note_id, created, note_kind, action, label, ref_version_id,
                    ref_created, words_added, words_removed, tokens_added,
                    tokens_removed, size, body
             FROM note_versions WHERE id = ?1",
            params![version_id],
            |r| Ok((row_to_summary(r)?, r.get::<_, Vec<u8>>("body")?)),
        )
        .optional()?;
    match row {
        Some((summary, blob)) => Ok(Version {
            summary,
            body: decompress_snapshot(&blob)?,
        }),
        None => Err(AppError::NotFound(format!("note version {version_id}"))),
    }
}

/// Delete versions older than `retention_days`. `None` = keep forever (no-op).
/// Returns the number of rows removed.
pub fn prune(conn: &Connection, retention_days: Option<u32>) -> AppResult<usize> {
    let Some(days) = retention_days else {
        return Ok(0);
    };
    let cutoff = (Utc::now() - chrono::Duration::days(days as i64)).to_rfc3339();
    let removed = conn.execute(
        "DELETE FROM note_versions WHERE created < ?1",
        params![cutoff],
    )?;
    Ok(removed)
}

// ---------- Tauri commands ----------

#[tauri::command]
pub async fn capture_note_version(
    app: AppHandle,
    note_id: String,
    note_kind: String,
    action: String,
    ref_version_id: Option<String>,
    markdown: String,
) -> Result<Option<VersionSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<VersionSummary>, String> {
        let db = app.state::<Db>();
        capture_off_lock(
            &db,
            &note_id,
            &note_kind,
            &action,
            ref_version_id.as_deref(),
            &markdown,
        )
        .map_err(Into::into)
    })
    .await
    .map_err(|e| format!("history capture task: {e}"))?
}

#[tauri::command]
pub async fn capture_current_note_version(
    app: AppHandle,
    note_id: String,
    action: String,
    ref_version_id: Option<String>,
) -> Result<Option<VersionSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<VersionSummary>, String> {
        let db = app.state::<Db>();
        // Read the saved state under the lock; build the (possibly large) base64
        // snapshot with the lock released.
        let (note_kind, body, yrs_state) = db.with_conn(|c| read_note_raw(c, &note_id))?;
        let snapshot = build_snapshot(&note_kind, body, yrs_state)?;
        capture_off_lock(
            &db,
            &note_id,
            &note_kind,
            &action,
            ref_version_id.as_deref(),
            &snapshot,
        )
        .map_err(Into::into)
    })
    .await
    .map_err(|e| format!("history current capture task: {e}"))?
}

#[tauri::command]
pub async fn list_note_versions(
    app: AppHandle,
    note_id: String,
) -> Result<Vec<VersionSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<VersionSummary>, String> {
        let db = app.state::<Db>();
        db.with_conn(|c| list(c, &note_id)).map_err(Into::into)
    })
    .await
    .map_err(|e| format!("history list task: {e}"))?
}

#[tauri::command]
pub async fn load_note_version(app: AppHandle, version_id: String) -> Result<Version, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Version, String> {
        let db = app.state::<Db>();
        db.with_conn(|c| load(c, &version_id)).map_err(Into::into)
    })
    .await
    .map_err(|e| format!("history load task: {e}"))?
}

#[tauri::command]
pub async fn prune_note_versions(
    app: AppHandle,
    retention_days: Option<u32>,
) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<usize, String> {
        let db = app.state::<Db>();
        db.with_conn(|c| prune(c, retention_days))
            .map_err(Into::into)
    })
    .await
    .map_err(|e| format!("history prune task: {e}"))?
}

#[cfg(test)]
mod tests;
