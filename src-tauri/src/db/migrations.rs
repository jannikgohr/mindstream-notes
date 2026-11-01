//! Native adapter for the shared migration runner.
use crate::error::AppResult;
use rusqlite::Connection;

pub fn run(conn: &mut Connection) -> AppResult<()> {
    mindstream_storage_core::migrations::run(conn).map_err(Into::into)
}

pub fn was_freshly_created(conn: &Connection) -> AppResult<bool> {
    mindstream_storage_core::migrations::was_freshly_created(conn).map_err(Into::into)
}

pub fn seed(conn: &Connection) -> AppResult<()> {
    mindstream_storage_core::migrations::seed(conn).map_err(Into::into)
}

pub(crate) fn insert_note(
    conn: &Connection,
    id: &str,
    title: &str,
    body: &str,
    parent: Option<&str>,
    position: i64,
    now: &str,
) -> AppResult<()> {
    mindstream_storage_core::migrations::insert_note(conn, id, title, body, parent, position, now)
        .map_err(Into::into)
}
