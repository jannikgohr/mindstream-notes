//! Native adapters for shared tree batch storage.
use crate::db::Db;
use crate::error::{AppResult, CommandResult};
pub use mindstream_storage_core::tree_batch::*;
use rusqlite::Connection;
use std::collections::HashSet;

pub fn move_many_items(
    conn: &mut Connection,
    items: Vec<TreeItemRef>,
    target_collection_id: Option<String>,
) -> AppResult<BatchCounts> {
    mindstream_storage_core::tree_batch::move_many_items(conn, items, target_collection_id)
        .map_err(Into::into)
}

pub fn purge_many_items(conn: &mut Connection, items: Vec<TreeItemRef>) -> AppResult<BatchCounts> {
    mindstream_storage_core::tree_batch::purge_many_items(conn, items).map_err(Into::into)
}

pub fn validate_target(conn: &Connection, target_collection_id: Option<&str>) -> AppResult<()> {
    mindstream_storage_core::tree_batch::validate_target(conn, target_collection_id)
        .map_err(Into::into)
}

pub fn validate_folder_move(
    conn: &Connection,
    folder_id: &str,
    target_collection_id: Option<&str>,
) -> AppResult<()> {
    mindstream_storage_core::tree_batch::validate_folder_move(conn, folder_id, target_collection_id)
        .map_err(Into::into)
}

pub fn move_note(
    conn: &Connection,
    id: &str,
    target_collection_id: Option<&str>,
    now: &str,
) -> AppResult<()> {
    mindstream_storage_core::tree_batch::move_note(conn, id, target_collection_id, now)
        .map_err(Into::into)
}

pub fn rehome_note_if_scope_changed(
    conn: &Connection,
    id: &str,
    target_collection_id: Option<&str>,
) -> AppResult<()> {
    mindstream_storage_core::tree_batch::rehome_note_if_scope_changed(
        conn,
        id,
        target_collection_id,
    )
    .map_err(Into::into)
}

pub fn move_folder(
    conn: &Connection,
    id: &str,
    target_collection_id: Option<&str>,
    now: &str,
) -> AppResult<()> {
    mindstream_storage_core::tree_batch::move_folder(conn, id, target_collection_id, now)
        .map_err(Into::into)
}

pub fn normalize_items(conn: &Connection, items: Vec<TreeItemRef>) -> AppResult<Vec<TreeItemRef>> {
    mindstream_storage_core::tree_batch::normalize_items(conn, items).map_err(Into::into)
}

pub fn item_is_covered_by_selected_folder(
    conn: &Connection,
    item: &TreeItemRef,
    selected_folders: &HashSet<String>,
) -> AppResult<bool> {
    mindstream_storage_core::tree_batch::item_is_covered_by_selected_folder(
        conn,
        item,
        selected_folders,
    )
    .map_err(Into::into)
}

pub fn collection_or_ancestor_is_selected(
    conn: &Connection,
    collection_id: &str,
    selected_folders: &HashSet<String>,
) -> AppResult<bool> {
    mindstream_storage_core::tree_batch::collection_or_ancestor_is_selected(
        conn,
        collection_id,
        selected_folders,
    )
    .map_err(Into::into)
}

pub fn collection_is_under(
    conn: &Connection,
    collection_id: &str,
    ancestor_id: &str,
) -> AppResult<bool> {
    mindstream_storage_core::tree_batch::collection_is_under(conn, collection_id, ancestor_id)
        .map_err(Into::into)
}

pub fn collection_parent(conn: &Connection, collection_id: &str) -> AppResult<Option<String>> {
    mindstream_storage_core::tree_batch::collection_parent(conn, collection_id).map_err(Into::into)
}

pub fn note_parent(conn: &Connection, note_id: &str) -> AppResult<Option<String>> {
    mindstream_storage_core::tree_batch::note_parent(conn, note_id).map_err(Into::into)
}

#[tauri::command]
pub fn move_many(
    db: tauri::State<'_, Db>,
    items: Vec<TreeItemRef>,
    target_collection_id: Option<String>,
) -> CommandResult<BatchCounts> {
    db.with_conn_mut(|c| move_many_items(c, items, target_collection_id))
        .map_err(Into::into)
}

#[tauri::command]
pub fn trash_many(db: tauri::State<'_, Db>, items: Vec<TreeItemRef>) -> CommandResult<BatchCounts> {
    db.with_conn_mut(|c| move_many_items(c, items, Some(TRASH_ID.to_string())))
        .map_err(Into::into)
}

#[tauri::command]
pub fn restore_many(
    db: tauri::State<'_, Db>,
    items: Vec<TreeItemRef>,
) -> CommandResult<BatchCounts> {
    db.with_conn_mut(|c| move_many_items(c, items, None))
        .map_err(Into::into)
}

#[tauri::command]
pub fn purge_many(db: tauri::State<'_, Db>, items: Vec<TreeItemRef>) -> CommandResult<BatchCounts> {
    db.with_conn_mut(|c| purge_many_items(c, items))
        .map_err(Into::into)
}

#[cfg(test)]
mod tests;

use crate::collections::TRASH_ID;

#[cfg(test)]
use crate::{collections, notes};
#[cfg(test)]
use rusqlite::params;

#[cfg(test)]
use crate::error::AppError;
