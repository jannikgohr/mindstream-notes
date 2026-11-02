//! Tauri adapters for shared attachment storage.
use crate::db::Db;
use crate::error::{AppResult, CommandResult};
use crate::notes::Note;
pub use mindstream_storage_core::assets::*;
use rusqlite::Connection;
use std::collections::HashMap;
pub mod binary;
#[cfg(test)]
use crate::error::AppError;
#[cfg(test)]
use rusqlite::params;
pub fn import_ink_pdf_note_inner(conn: &Connection, input: ImportInkPdfNote) -> AppResult<Note> {
    mindstream_storage_core::assets::import_ink_pdf_note_inner(conn, input).map_err(Into::into)
}

pub fn store_deduped(
    conn: &Connection,
    note_id: &str,
    mime_type: &str,
    bytes: &[u8],
) -> AppResult<StoredAsset> {
    mindstream_storage_core::assets::store_deduped(conn, note_id, mime_type, bytes)
        .map_err(Into::into)
}

pub fn upload(conn: &Connection, input: UploadAsset) -> AppResult<Asset> {
    mindstream_storage_core::assets::upload(conn, input).map_err(Into::into)
}

pub fn upload_with_id(conn: &Connection, id: String, input: UploadAsset) -> AppResult<Asset> {
    mindstream_storage_core::assets::upload_with_id(conn, id, input).map_err(Into::into)
}

pub fn add_ref(conn: &Connection, asset_id: &str, note_id: &str) -> AppResult<()> {
    mindstream_storage_core::assets::add_ref(conn, asset_id, note_id).map_err(Into::into)
}

pub fn register_body_refs(conn: &Connection, note_id: &str, body: &str) -> AppResult<()> {
    mindstream_storage_core::assets::register_body_refs(conn, note_id, body).map_err(Into::into)
}

pub fn normalize_asset_ids_for_note(
    conn: &Connection,
    note_id: &str,
    body: &str,
    state: Option<&[u8]>,
) -> AppResult<(String, Option<Vec<u8>>)> {
    mindstream_storage_core::assets::normalize_asset_ids_for_note(conn, note_id, body, state)
        .map_err(Into::into)
}

pub fn release_note_assets(conn: &Connection, note_id: &str) -> AppResult<usize> {
    mindstream_storage_core::assets::release_note_assets(conn, note_id).map_err(Into::into)
}

pub fn import_pdf_note_inner(conn: &Connection, input: ImportPdfNote) -> AppResult<Note> {
    mindstream_storage_core::assets::import_pdf_note_inner(conn, input).map_err(Into::into)
}

pub fn load(conn: &Connection, id: &str) -> AppResult<Asset> {
    mindstream_storage_core::assets::load(conn, id).map_err(Into::into)
}

pub fn load_summary(conn: &Connection, id: &str) -> AppResult<AssetSummary> {
    mindstream_storage_core::assets::load_summary(conn, id).map_err(Into::into)
}

pub fn asset_reference_counts(
    conn: &Connection,
    note_id: &str,
) -> AppResult<HashMap<String, usize>> {
    mindstream_storage_core::assets::asset_reference_counts(conn, note_id).map_err(Into::into)
}

pub fn purge_unreferenced_markdown_assets(conn: &Connection, note_id: &str) -> AppResult<usize> {
    mindstream_storage_core::assets::purge_unreferenced_markdown_assets(conn, note_id)
        .map_err(Into::into)
}

pub fn sweep_unreferenced_markdown_assets_inner(conn: &Connection) -> AppResult<usize> {
    mindstream_storage_core::assets::sweep_unreferenced_markdown_assets_inner(conn)
        .map_err(Into::into)
}

#[cfg(test)]
pub fn backfill_content_hashes(conn: &Connection) -> AppResult<usize> {
    mindstream_storage_core::asset_hash::backfill_content_hashes(conn).map_err(Into::into)
}
#[tauri::command]
pub fn import_ink_pdf_note(
    db: tauri::State<'_, Db>,
    input: ImportInkPdfNote,
) -> CommandResult<Note> {
    db.with_conn(|c| import_ink_pdf_note_inner(c, input))
        .map_err(Into::into)
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

#[cfg(test)]
use chrono::Utc;
