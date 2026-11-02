//! Native history capture keeps compression outside the connection lock.
use crate::db::Db;
use crate::error::{AppResult, CommandError, CommandResult};
use crate::notes::NoteKind;
pub use mindstream_storage_core::history::*;
use rusqlite::Connection;
use tauri::{AppHandle, Manager};
pub fn decompress_snapshot(bytes: &[u8]) -> AppResult<String> {
    mindstream_storage_core::history::decompress_snapshot(bytes).map_err(Into::into)
}

pub fn read_note_raw(
    conn: &Connection,
    note_id: &str,
) -> AppResult<(NoteKind, String, Option<Vec<u8>>)> {
    mindstream_storage_core::history::read_note_raw(conn, note_id).map_err(Into::into)
}

pub fn build_snapshot(
    note_kind: NoteKind,
    body: String,
    yrs_state: Option<Vec<u8>>,
) -> AppResult<String> {
    mindstream_storage_core::history::build_snapshot(note_kind, body, yrs_state).map_err(Into::into)
}

pub fn current_note_snapshot(conn: &Connection, note_id: &str) -> AppResult<(NoteKind, String)> {
    mindstream_storage_core::history::current_note_snapshot(conn, note_id).map_err(Into::into)
}

pub fn latest_version_blob(conn: &Connection, note_id: &str) -> AppResult<Option<Vec<u8>>> {
    mindstream_storage_core::history::latest_version_blob(conn, note_id).map_err(Into::into)
}

pub fn prepare_version(
    prev_md: Option<String>,
    note_id: &str,
    note_kind: NoteKind,
    action: VersionAction,
    ref_version_id: Option<&str>,
    markdown: &str,
) -> AppResult<Option<PreparedVersion>> {
    mindstream_storage_core::history::prepare_version(
        prev_md,
        note_id,
        note_kind,
        action,
        ref_version_id,
        markdown,
    )
    .map_err(Into::into)
}

pub fn insert_prepared(conn: &Connection, prepared: PreparedVersion) -> AppResult<VersionSummary> {
    mindstream_storage_core::history::insert_prepared(conn, prepared).map_err(Into::into)
}

pub fn capture<N, A>(
    conn: &Connection,
    note_id: &str,
    note_kind: N,
    action: A,
    ref_version_id: Option<&str>,
    markdown: &str,
) -> AppResult<Option<VersionSummary>>
where
    N: Into<NoteKind>,
    A: Into<VersionAction>,
{
    mindstream_storage_core::history::capture(
        conn,
        note_id,
        note_kind,
        action,
        ref_version_id,
        markdown,
    )
    .map_err(Into::into)
}

pub fn list(conn: &Connection, note_id: &str) -> AppResult<Vec<VersionSummary>> {
    mindstream_storage_core::history::list(conn, note_id).map_err(Into::into)
}

pub fn load(conn: &Connection, version_id: &str) -> AppResult<Version> {
    mindstream_storage_core::history::load(conn, version_id).map_err(Into::into)
}

pub fn prune(conn: &Connection, retention_days: Option<u32>) -> AppResult<usize> {
    mindstream_storage_core::history::prune(conn, retention_days).map_err(Into::into)
}

fn capture_off_lock(
    db: &Db,
    note_id: &str,
    note_kind: NoteKind,
    action: VersionAction,
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
// ---------- Tauri commands ----------

#[tauri::command]
pub async fn capture_note_version(
    app: AppHandle,
    note_id: String,
    note_kind: NoteKind,
    action: VersionAction,
    ref_version_id: Option<String>,
    markdown: String,
) -> CommandResult<Option<VersionSummary>> {
    let job = app.state::<crate::vault_jobs::Saves>().enter()?;
    tauri::async_runtime::spawn_blocking(move || -> CommandResult<Option<VersionSummary>> {
        let _job = job;
        let db = app.state::<Db>();
        capture_off_lock(
            &db,
            &note_id,
            note_kind,
            action,
            ref_version_id.as_deref(),
            &markdown,
        )
        .map_err(Into::into)
    })
    .await
    .map_err(|e| CommandError::task(format!("history capture task: {e}")))?
}

#[tauri::command]
pub async fn capture_current_note_version(
    app: AppHandle,
    note_id: String,
    action: VersionAction,
    ref_version_id: Option<String>,
) -> CommandResult<Option<VersionSummary>> {
    let job = app.state::<crate::vault_jobs::Saves>().enter()?;
    tauri::async_runtime::spawn_blocking(move || -> CommandResult<Option<VersionSummary>> {
        let _job = job;
        let db = app.state::<Db>();
        // Read the saved state under the lock; build the (possibly large) base64
        // snapshot with the lock released.
        let (note_kind, body, yrs_state) = db.with_conn(|c| read_note_raw(c, &note_id))?;
        let snapshot = build_snapshot(note_kind.clone(), body, yrs_state)?;
        capture_off_lock(
            &db,
            &note_id,
            note_kind,
            action,
            ref_version_id.as_deref(),
            &snapshot,
        )
        .map_err(Into::into)
    })
    .await
    .map_err(|e| CommandError::task(format!("history current capture task: {e}")))?
}

#[tauri::command]
pub async fn list_note_versions(
    app: AppHandle,
    note_id: String,
) -> CommandResult<Vec<VersionSummary>> {
    let job = app.state::<crate::vault_jobs::Saves>().enter()?;
    tauri::async_runtime::spawn_blocking(move || -> CommandResult<Vec<VersionSummary>> {
        let _job = job;
        let db = app.state::<Db>();
        db.with_conn(|c| list(c, &note_id)).map_err(Into::into)
    })
    .await
    .map_err(|e| CommandError::task(format!("history list task: {e}")))?
}

#[tauri::command]
pub async fn load_note_version(app: AppHandle, version_id: String) -> CommandResult<Version> {
    let job = app.state::<crate::vault_jobs::Saves>().enter()?;
    tauri::async_runtime::spawn_blocking(move || -> CommandResult<Version> {
        let _job = job;
        let db = app.state::<Db>();
        db.with_conn(|c| load(c, &version_id)).map_err(Into::into)
    })
    .await
    .map_err(|e| CommandError::task(format!("history load task: {e}")))?
}

#[tauri::command]
pub async fn prune_note_versions(
    app: AppHandle,
    retention_days: Option<u32>,
) -> CommandResult<usize> {
    let job = app.state::<crate::vault_jobs::Saves>().enter()?;
    tauri::async_runtime::spawn_blocking(move || -> CommandResult<usize> {
        let _job = job;
        let db = app.state::<Db>();
        db.with_conn(|c| prune(c, retention_days))
            .map_err(Into::into)
    })
    .await
    .map_err(|e| CommandError::task(format!("history prune task: {e}")))?
}

#[cfg(test)]
mod tests;

#[cfg(test)]
use crate::error::AppError;

#[cfg(test)]
use chrono::Utc;

#[cfg(test)]
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
#[cfg(test)]
use rusqlite::params;
