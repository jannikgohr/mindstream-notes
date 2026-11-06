//! Behavior checks called against native SQLite and worker-owned OPFS SQLite.
use crate::error::{AppError, AppResult};
use crate::{migrations, yrs_doc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofReport {
    pub schema_version: u32,
    pub upgrades: usize,
    pub sqlite_version: String,
    pub journal_mode: String,
    pub fts5: bool,
    pub transactions: bool,
    pub foreign_keys: bool,
    pub crdt: bool,
}

fn require(condition: bool, message: &str) -> AppResult<()> {
    if condition {
        Ok(())
    } else {
        Err(AppError::InvalidArg(message.into()))
    }
}

pub fn verify(conn: &mut Connection) -> AppResult<ProofReport> {
    let upgrades = migrations::verify_upgrades()?;
    migrations::run(conn)?;
    let before: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    migrations::run(conn)?;
    let after: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    require(before == after, "Migrations must be idempotent")?;
    require(
        after == migrations::latest_version(),
        "Migrations must reach the latest schema",
    )?;
    let foreign_keys: bool = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0))?;
    require(foreign_keys, "Foreign keys must be enabled")?;

    // A savepoint restores the pre-check data even when an assertion fails.
    let tx = conn.savepoint()?;
    tx.execute("INSERT INTO notes(id, title, body, created, modified) VALUES ('sqlite_proof_transaction', 'Proof', 'trigram persistence', 'proof', 'proof')", [])?;
    let hits: i64 = tx.query_row(
        "SELECT COUNT(*) FROM note_search WHERE note_search MATCH 'igram'",
        [],
        |r| r.get(0),
    )?;
    require(hits >= 1, "FTS5 trigram insertion failed")?;
    require(
        crate::search::search(&tx, "igram")?
            .iter()
            .any(|hit| hit.note.id == "sqlite_proof_transaction"),
        "Shared search query failed",
    )?;
    require(
        crate::notes::load(&tx, "sqlite_proof_transaction")?.body == "trigram persistence",
        "Shared note read failed",
    )?;
    tx.execute(
        "UPDATE notes SET body = 'updated transaction' WHERE id = 'sqlite_proof_transaction'",
        [],
    )?;
    let updated: i64 = tx.query_row("SELECT COUNT(*) FROM note_search WHERE note_search MATCH 'updated' AND rowid = (SELECT rowid FROM notes WHERE id = 'sqlite_proof_transaction')", [], |r| r.get(0))?;
    require(updated == 1, "FTS5 update trigger failed")?;
    // Dropping an uncommitted savepoint rolls it back.
    drop(tx);
    let surviving: i64 = conn.query_row(
        "SELECT COUNT(*) FROM notes WHERE id = 'sqlite_proof_transaction'",
        [],
        |r| r.get(0),
    )?;
    require(surviving == 0, "Transaction rollback failed")?;
    let state = yrs_doc::init_seed_state("shared CRDT");
    require(
        yrs_doc::to_markdown(&yrs_doc::merge_remote(&state, &state)) == "shared CRDT",
        "CRDT origin round trip failed",
    )?;
    Ok(ProofReport {
        schema_version: after,
        upgrades,
        sqlite_version: rusqlite::version().into(),
        journal_mode: conn.query_row("PRAGMA journal_mode", [], |r| r.get(0))?,
        fts5: true,
        transactions: true,
        foreign_keys,
        crdt: true,
    })
}

pub fn write_marker(conn: &mut Connection, body: &str) -> AppResult<()> {
    let tx = conn.transaction()?;
    let state = yrs_doc::init_seed_state(body);
    tx.execute("INSERT INTO notes(id, title, body, created, modified, yrs_state) VALUES ('sqlite_proof_marker', 'Persistence marker', ?1, 'proof', 'proof', ?2) ON CONFLICT(id) DO UPDATE SET body = excluded.body, yrs_state = excluded.yrs_state", params![body, state])?;
    tx.commit()?;
    Ok(())
}

pub fn read_marker(conn: &Connection) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT body FROM notes WHERE id = 'sqlite_proof_marker'",
            [],
            |r| r.get(0),
        )
        .optional()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_storage_passes_the_browser_behavior_checks() {
        let mut conn = Connection::open_in_memory().unwrap();
        let report = verify(&mut conn).unwrap();
        assert!(report.fts5 && report.transactions && report.foreign_keys && report.crdt);
        assert_eq!(report.schema_version, migrations::latest_version());
        // Version 1 plus every version from 24 below the latest.
        assert_eq!(
            report.upgrades,
            1 + (24..migrations::latest_version()).count()
        );
        assert!(read_marker(&conn).unwrap().is_none());
        write_marker(&mut conn, "first").unwrap();
        write_marker(&mut conn, "second").unwrap();
        verify(&mut conn).unwrap();
        assert_eq!(read_marker(&conn).unwrap().as_deref(), Some("second"));
    }
}
