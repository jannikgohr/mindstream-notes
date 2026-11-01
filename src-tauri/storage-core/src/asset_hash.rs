use crate::error::AppResult;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

/// sha256 of an asset's bytes, lowercase hex. The dedup key (paired with the
/// share scope) and what the migration-26 backfill writes.
pub fn content_hash(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        // Writing into a String is infallible; the Result only exists to
        // satisfy the fmt::Write trait.
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Fill in `content_hash` for rows that predate migration 26.
///
/// SQLite has no hashing function, so the migration leaves the column NULL and
/// this runs once afterwards. Until a row is hashed it simply never matches a
/// dedup lookup, so a partial failure costs storage, never correctness.
///
/// Bytes are fetched one row at a time rather than in one query: an asset can
/// be tens of megabytes and the whole point is to keep peak memory to a single
/// blob.
pub fn backfill_content_hashes(conn: &Connection) -> AppResult<usize> {
    let pending: Vec<String> = {
        // Served by idx_assets_unhashed, so the steady-state check after the
        // backfill has run is an empty index probe, not a table scan.
        let mut stmt = conn.prepare("SELECT id FROM assets WHERE content_hash IS NULL")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    if pending.is_empty() {
        return Ok(0);
    }
    log::info!("[assets] hashing {} pre-existing asset(s)", pending.len());

    let mut hashed = 0usize;
    for id in pending {
        let bytes: Option<Vec<u8>> = conn
            .query_row("SELECT bytes FROM assets WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .optional()?;
        let Some(bytes) = bytes else { continue };
        conn.execute(
            "UPDATE assets SET content_hash = ?1 WHERE id = ?2",
            params![content_hash(&bytes), id],
        )?;
        hashed += 1;
    }
    Ok(hashed)
}
