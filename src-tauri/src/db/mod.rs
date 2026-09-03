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

use crate::error::AppResult;

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
        let conn = self.lock_recovering();
        f(&conn)
    }

    /// Run a closure against the connection (write — borrowed mutably so
    /// transactions are possible).
    pub fn with_conn_mut<F, R>(&self, f: F) -> AppResult<R>
    where
        F: FnOnce(&mut Connection) -> AppResult<R>,
    {
        let mut conn = self.lock_recovering();
        f(&mut conn)
    }

    /// Take the lock, recovering from poisoning rather than propagating it.
    ///
    /// A panic while the guard is alive poisons the mutex, and the app has
    /// exactly one connection — so the old `map_err(...)?` turned a single
    /// caught panic into every subsequent database call failing for the rest
    /// of the process. That is reachable in practice: `sync::catch_blocking_panic`
    /// exists to keep the app alive after a panic in the sync pipeline, and
    /// that pipeline runs `with_conn_mut`. On a scheduler, it then retried
    /// into a permanently broken store.
    ///
    /// Recovering is sound here because the guarded value is a `Connection`,
    /// not a hand-rolled invariant. rusqlite's `Transaction` rolls back in its
    /// `Drop`, which runs during the unwind, so an interrupted write leaves no
    /// half-applied statement behind — the connection is back to a consistent
    /// state by the time the next caller sees it.
    fn lock_recovering(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.0.lock().unwrap_or_else(|poisoned| {
            log::warn!(
                "[db] connection mutex was poisoned by an earlier panic; \
                 recovering (open transactions rolled back on unwind)"
            );
            self.0.clear_poison();
            poisoned.into_inner()
        })
    }
}

#[cfg(test)]
pub fn open_memory_for_tests() -> Db {
    let mut conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrations::run(&mut conn).expect("migrations");
    Db(std::sync::Mutex::new(conn))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_creates_the_db_file_and_runs_migrations() {
        let dir = std::env::temp_dir().join(format!("ms-db-open-{}", uuid::Uuid::new_v4()));
        // Nested path so the create_dir_all(parent) branch runs.
        let path = dir.join("nested").join("mindstream.db");
        let db = Db::open(&path).expect("open db");
        assert!(path.exists(), "db file created");

        // Migrations ran: the notes table exists and foreign keys are on.
        db.with_conn(|c| {
            let n: i64 = c
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='notes'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1);
            let fk: i64 = c
                .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
                .unwrap();
            assert_eq!(fk, 1);
            Ok(())
        })
        .unwrap();

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_panic_under_the_lock_does_not_brick_the_connection() {
        use std::panic::{catch_unwind, AssertUnwindSafe};

        let db = open_memory_for_tests();

        // Same shape as `sync::catch_blocking_panic`: a panic raised while
        // the guard is alive, swallowed so the process keeps running.
        // Turbofished because the closure only ever diverges, so `R` is
        // otherwise unconstrained.
        let panicked = catch_unwind(AssertUnwindSafe(|| {
            db.with_conn_mut::<_, ()>(|c| {
                let tx = c.transaction()?;
                tx.execute(
                    "INSERT INTO collections (id, name, parent_collection_id, created, modified)
                     VALUES ('doomed', 'Folder', NULL, '2025-01-01', '2025-01-01')",
                    [],
                )?;
                panic!("boom, mid-transaction");
            })
        }));
        assert!(
            panicked.is_err(),
            "the panic must have escaped with_conn_mut"
        );
        assert!(db.0.is_poisoned(), "std Mutex poisons on an unwind");

        // The next caller still gets a working connection...
        let count: i64 = db
            .with_conn(|c| Ok(c.query_row("SELECT COUNT(*) FROM collections", [], |r| r.get(0))?))
            .expect("connection is usable after a poisoning panic");

        // ...and the interrupted write rolled back with the Transaction's Drop,
        // so only the seeded trash row is there.
        assert_eq!(count, 1, "the doomed insert must not have survived");

        // Poison was cleared, so this isn't merely papering over each call.
        assert!(!db.0.is_poisoned());
    }

    #[test]
    fn with_conn_mut_supports_transactions() {
        let db = open_memory_for_tests();
        db.with_conn_mut(|c| {
            let tx = c.transaction()?;
            tx.execute(
                "INSERT INTO collections (id, name, parent_collection_id, created, modified)
                 VALUES ('c1', 'Folder', NULL, '2025-01-01', '2025-01-01')",
                [],
            )?;
            tx.commit()?;
            Ok(())
        })
        .unwrap();

        let count: i64 = db
            .with_conn(|c| {
                Ok(
                    c.query_row("SELECT COUNT(*) FROM collections WHERE id='c1'", [], |r| {
                        r.get(0)
                    })?,
                )
            })
            .unwrap();
        assert_eq!(count, 1);
    }
}
