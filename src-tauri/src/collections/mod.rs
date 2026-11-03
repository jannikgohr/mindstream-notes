//! Tauri adapters for shared folder storage.
use crate::db::Db;
use crate::error::{AppResult, CommandResult};
pub use mindstream_storage_core::collections::*;
use rusqlite::Connection;
pub fn list(conn: &Connection) -> AppResult<Vec<Collection>> {
    mindstream_storage_core::collections::list(conn).map_err(Into::into)
}

pub fn create(conn: &Connection, input: CreateCollection) -> AppResult<Collection> {
    mindstream_storage_core::collections::create(conn, input).map_err(Into::into)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Collection> {
    mindstream_storage_core::collections::get(conn, id).map_err(Into::into)
}

pub fn update(conn: &Connection, input: UpdateCollection) -> AppResult<Collection> {
    mindstream_storage_core::collections::update(conn, input).map_err(Into::into)
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    mindstream_storage_core::collections::delete(conn, id).map_err(Into::into)
}

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
    // One transaction, so a move the re-home refuses (a demo note heading
    // into a shared folder) leaves the folder where it was.
    db.with_conn_mut(|c| {
        let tx = c.transaction()?;
        let folder = update(&tx, input)?;
        tx.commit()?;
        Ok(folder)
    })
    .map_err(Into::into)
}

#[tauri::command]
pub fn delete_collection(db: tauri::State<'_, Db>, id: String) -> CommandResult<()> {
    db.with_conn(|c| delete(c, &id)).map_err(Into::into)
}

#[cfg(test)]
mod tests;

#[cfg(test)]
use crate::error::AppError;
#[cfg(test)]
use rusqlite::params;
