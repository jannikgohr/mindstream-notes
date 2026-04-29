//! SQLite connection wrapper.
//!
//! One Connection lives behind a Mutex on the Tauri AppState. Tauri runs
//! commands on its own thread pool, so the lock is held only for the
//! duration of a single query — fine for typical desktop write rates.
//! For very high-throughput cases (vault scans, batch imports) refactor
//! to a writer thread or move to a real connection pool (r2d2_sqlite).

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::error::{AppError, AppResult};

pub mod migrations;

pub struct Db(pub Mutex<Connection>);

impl Db {
    /// Open or create the SQLite database at `path`, run migrations, and
    /// return a ready-to-use connection wrapped in a Mutex.
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut conn = Connection::open(path)?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        migrations::run(&mut conn)?;
        Ok(Self(Mutex::new(conn)))
    }

    /// Run a closure against the connection (read).
    pub fn with_conn<F, R>(&self, f: F) -> AppResult<R>
    where
        F: FnOnce(&Connection) -> AppResult<R>,
    {
        let conn = self
            .0
            .lock()
            .map_err(|_| AppError::InvalidArg("database mutex poisoned".into()))?;
        f(&conn)
    }

    /// Run a closure against the connection (write — borrowed mutably so
    /// transactions are possible).
    pub fn with_conn_mut<F, R>(&self, f: F) -> AppResult<R>
    where
        F: FnOnce(&mut Connection) -> AppResult<R>,
    {
        let mut conn = self
            .0
            .lock()
            .map_err(|_| AppError::InvalidArg("database mutex poisoned".into()))?;
        f(&mut conn)
    }
}


#[cfg(test)]
pub fn open_memory_for_tests() -> Db {
    let mut conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrations::run(&mut conn).expect("migrations");
    Db(std::sync::Mutex::new(conn))
}
