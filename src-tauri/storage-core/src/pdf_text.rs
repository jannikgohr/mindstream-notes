//! Cached searchable text for PDF notes and PDF-backed ink pages.
//!
//! A PDF note's bytes are immutable, so its extracted text is derived data we
//! compute with frontend PDF.js and stash in `notes.pdf_text` for the
//! cross-note search to hit (see `search::search`). This module is the local
//! persistence seam plus the queries that drive frontend indexing:
//!
//!   * `set_pdf_text`           — persist extracted text (idempotent).
//!   * `pdf_notes_missing_text` — un-indexed PDF notes, for the background sweep.
//!   * `pdf_note_needs_text`    — cheap per-note check for the on-open path.
//!
//! `pdf_text` is deliberately NOT synced (it's reproducible from the PDF bytes
//! every device already has), so writing it must never dirty the note — none of
//! these touch `modified` / `dirty`.
//! Ink page-list changes invalidate the note cache. A matching background
//! signature guards asynchronous writes; pdf_page_text caches source pages.

use rusqlite::{params, Connection};

use crate::error::AppResult;

/// Persist the extracted text for a PDF note. No-ops unless the note is a PDF
/// note that is still un-indexed (`pdf_text IS NULL`) — the guard makes repeat
/// calls (import + on-open + sweep racing) harmless and keeps the first writer's
/// result stable. Pointedly leaves `modified`/`dirty` untouched: this is derived
/// local data and must not trigger a sync push.
pub fn store_text(conn: &Connection, note_id: &str, text: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE notes SET pdf_text = ?2
         WHERE id = ?1 AND note_kind IN ('pdf', 'ink') AND pdf_text IS NULL",
        params![note_id, text],
    )?;
    Ok(())
}

/// Ids of non-trashed PDF notes that have no cached text yet. Drives the
/// frontend background backfill sweep.
pub fn notes_missing_text(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM active_notes
         WHERE note_kind IN ('pdf', 'ink') AND pdf_text IS NULL AND trashed_at IS NULL",
    )?;
    let ids = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}

/// Whether a single PDF note still needs indexing. Cheap gate for the viewer's
/// on-open path so it only extracts (and reuses its open document) when needed.
pub fn note_needs_text(conn: &Connection, note_id: &str) -> AppResult<bool> {
    let needs: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM active_notes
            WHERE id = ?1 AND note_kind IN ('pdf', 'ink') AND pdf_text IS NULL
         )",
        params![note_id],
        |row| row.get(0),
    )?;
    Ok(needs)
}

pub fn store_ink_text(
    conn: &Connection,
    note_id: &str,
    text: &str,
    signature: &str,
) -> AppResult<()> {
    let state: Option<Vec<u8>> = conn.query_row(
        "SELECT yrs_state FROM notes WHERE id = ?1",
        params![note_id],
        |r| r.get(0),
    )?;
    if crate::yrs_doc::ink_background_signature(&state.unwrap_or_default()) == signature {
        conn.execute("UPDATE notes SET pdf_text = ?2, pdf_text_signature = ?3 WHERE id = ?1 AND note_kind = 'ink'", params![note_id, text, signature])?;
    }
    Ok(())
}
