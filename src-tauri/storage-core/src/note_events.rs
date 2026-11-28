//! Durable cursors for plugin note events.
//!
//! Each note row carries the number of its latest change (`change_seq`) and
//! when it happened (`changed_at`), both set by triggers. A plugin export's
//! cursor is the highest change number it has been told about. Both hosts run
//! the same queries; only the loop that calls the plugin is per host.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::error::AppResult;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteChange {
    pub note_id: String,
    pub kind: String,
    pub revision: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    /// Passed back to `commit`, which ignores it once the cursor was reset.
    pub generation: String,
    pub changes: Vec<NoteChange>,
}

/// The changes after the cursor whose notes have stopped changing for
/// `settle_ms`, oldest first, up to `limit`. The list stops at the first note
/// still settling, so the cursor never passes it. Trashed notes and other
/// kinds are left out without holding the cursor back.
///
/// `settings` are the plugin's effective settings. When they differ from the
/// last call's, the cursor starts over, so notes the plugin skipped while it
/// was not set up are delivered again. Only a hash of them is stored.
pub fn pending(
    conn: &Connection,
    plugin_id: &str,
    export: &str,
    settings: &serde_json::Value,
    kinds: Option<&[String]>,
    settle_ms: u32,
    limit: u32,
) -> AppResult<Pending> {
    let (seq, generation) = cursor(conn, plugin_id, export, settings)?;
    let kinds = kinds.map(|kinds| serde_json::to_string(kinds).unwrap_or_default());
    let mut stmt = conn.prepare(
        "SELECT id, note_kind, change_seq,
                changed_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) - ?3
         FROM active_notes
         WHERE change_seq > ?1
           AND (?2 IS NULL OR note_kind IN (SELECT value FROM json_each(?2)))
         ORDER BY change_seq
         LIMIT ?4",
    )?;
    let rows = stmt.query_map(params![seq, kinds, settle_ms, limit], |row| {
        Ok((
            NoteChange {
                note_id: row.get(0)?,
                kind: row.get(1)?,
                revision: row.get(2)?,
            },
            row.get::<_, bool>(3)?,
        ))
    })?;
    let mut changes = Vec::new();
    for row in rows {
        let (change, settling) = row?;
        if settling {
            break;
        }
        changes.push(change);
    }
    Ok(Pending {
        generation,
        changes,
    })
}

fn cursor(
    conn: &Connection,
    plugin_id: &str,
    export: &str,
    settings: &serde_json::Value,
) -> AppResult<(i64, String)> {
    let settings = crate::asset_hash::content_hash(settings.to_string().as_bytes());
    let existing = conn
        .query_row(
            "SELECT seq, generation FROM plugin_event_cursors
             WHERE plugin_id = ?1 AND export = ?2 AND settings = ?3",
            params![plugin_id, export, settings],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some(cursor) = existing {
        return Ok(cursor);
    }
    let generation = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT OR REPLACE INTO plugin_event_cursors(plugin_id, export, seq, generation, settings)
         VALUES (?1, ?2, 0, ?3, ?4)",
        params![plugin_id, export, generation, settings],
    )?;
    Ok((0, generation))
}

/// Moves the cursor past `revision` after its event was handled. Does
/// nothing when the cursor was reset or deleted since `pending` returned
/// `generation`, or when it is already further along.
pub fn commit(
    conn: &Connection,
    plugin_id: &str,
    export: &str,
    generation: &str,
    revision: i64,
) -> AppResult<()> {
    conn.execute(
        "UPDATE plugin_event_cursors SET seq = ?4
         WHERE plugin_id = ?1 AND export = ?2 AND generation = ?3 AND seq < ?4",
        params![plugin_id, export, generation, revision],
    )?;
    Ok(())
}

/// Drops the plugin's cursors when it is disabled or removed.
pub fn forget(conn: &Connection, plugin_id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM plugin_event_cursors WHERE plugin_id = ?1",
        params![plugin_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests;
