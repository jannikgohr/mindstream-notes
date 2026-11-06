//! Native adapters for shared tree batch storage.
use crate::db::Db;
use crate::error::{AppResult, CommandResult};
pub use mindstream_storage_core::tree_batch::*;
use rusqlite::Connection;

pub fn move_many_items(
    conn: &mut Connection,
    items: Vec<TreeItemRef>,
    target_collection_id: Option<String>,
) -> AppResult<BatchCounts> {
    mindstream_storage_core::tree_batch::move_many_items(conn, items, target_collection_id)
        .map_err(Into::into)
}

pub fn restore_many_items(
    conn: &mut Connection,
    items: Vec<TreeItemRef>,
) -> AppResult<BatchCounts> {
    mindstream_storage_core::tree_batch::restore_many_items(conn, items).map_err(Into::into)
}

pub fn purge_many_items(conn: &mut Connection, items: Vec<TreeItemRef>) -> AppResult<BatchCounts> {
    mindstream_storage_core::tree_batch::purge_many_items(conn, items).map_err(Into::into)
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
    db.with_conn_mut(|c| restore_many_items(c, items))
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
