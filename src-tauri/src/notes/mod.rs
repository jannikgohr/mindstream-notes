//! Tauri adapters for shared note storage.
use crate::db::Db;
use crate::error::{AppResult, CommandResult};
pub use mindstream_storage_core::notes::*;
use rusqlite::Connection;
#[cfg(test)]
use std::str::FromStr;
pub fn list(conn: &Connection, include_trashed: bool) -> AppResult<Vec<NoteSummary>> {
    mindstream_storage_core::notes::list(conn, include_trashed).map_err(Into::into)
}

pub fn load_tags(conn: &Connection, id: &str) -> AppResult<Vec<String>> {
    mindstream_storage_core::notes::load_tags(conn, id).map_err(Into::into)
}

pub fn load_yrs_state(conn: &Connection, id: &str) -> AppResult<Vec<u8>> {
    mindstream_storage_core::notes::load_yrs_state(conn, id).map_err(Into::into)
}

pub fn load(conn: &Connection, id: &str) -> AppResult<Note> {
    mindstream_storage_core::notes::load(conn, id).map_err(Into::into)
}

pub fn save_yrs_state(conn: &mut Connection, id: &str, bytes: &[u8]) -> AppResult<bool> {
    mindstream_storage_core::notes::save_yrs_state(conn, id, bytes).map_err(Into::into)
}

pub fn create(conn: &Connection, input: CreateNote) -> AppResult<Note> {
    mindstream_storage_core::notes::create(conn, input).map_err(Into::into)
}

pub fn update(conn: &mut Connection, input: UpdateNote) -> AppResult<Note> {
    mindstream_storage_core::notes::update(conn, input).map_err(Into::into)
}

pub fn trash(conn: &Connection, id: &str) -> AppResult<()> {
    mindstream_storage_core::notes::trash(conn, id).map_err(Into::into)
}

pub fn restore(conn: &Connection, id: &str) -> AppResult<()> {
    mindstream_storage_core::notes::restore(conn, id).map_err(Into::into)
}

pub fn purge(conn: &Connection, id: &str) -> AppResult<()> {
    mindstream_storage_core::notes::purge(conn, id).map_err(Into::into)
}

pub fn next_position(conn: &Connection, parent: Option<&str>) -> AppResult<i64> {
    mindstream_storage_core::notes::next_position(conn, parent).map_err(Into::into)
}
// ---------- Tauri commands ----------

#[tauri::command]
pub fn list_notes(
    db: tauri::State<'_, Db>,
    include_trashed: Option<bool>,
) -> CommandResult<Vec<NoteSummary>> {
    db.with_conn(|c| list(c, include_trashed.unwrap_or(false)))
        .map_err(Into::into)
}

#[tauri::command]
pub fn load_note(db: tauri::State<'_, Db>, id: String) -> CommandResult<Note> {
    db.with_conn(|c| load(c, &id)).map_err(Into::into)
}

#[tauri::command]
pub fn create_note(db: tauri::State<'_, Db>, input: CreateNote) -> CommandResult<Note> {
    db.with_conn(|c| create(c, input)).map_err(Into::into)
}

#[tauri::command]
pub fn save_note(db: tauri::State<'_, Db>, input: UpdateNote) -> CommandResult<Note> {
    db.with_conn_mut(|c| update(c, input)).map_err(Into::into)
}

#[tauri::command]
pub fn trash_note(db: tauri::State<'_, Db>, id: String) -> CommandResult<()> {
    db.with_conn(|c| trash(c, &id)).map_err(Into::into)
}

#[tauri::command]
pub fn restore_note(db: tauri::State<'_, Db>, id: String) -> CommandResult<()> {
    db.with_conn(|c| restore(c, &id)).map_err(Into::into)
}

#[tauri::command]
pub fn purge_note(db: tauri::State<'_, Db>, id: String) -> CommandResult<()> {
    db.with_conn(|c| purge(c, &id)).map_err(Into::into)
}

#[cfg(test)]
mod tests;

#[cfg(test)]
use crate::error::AppError;
#[cfg(test)]
use rusqlite::params;
