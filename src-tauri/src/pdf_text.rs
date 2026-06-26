//! Cached searchable text for PDF notes.
//!
//! A PDF note's bytes are immutable, so its extracted text is derived data we
//! compute once (frontend pdf.js) and stash in `notes.pdf_text` for the
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

use rusqlite::{params, Connection};

use crate::db::Db;
use crate::error::AppResult;

/// Persist the extracted text for a PDF note. No-ops unless the note is a PDF
/// note that is still un-indexed (`pdf_text IS NULL`) — the guard makes repeat
/// calls (import + on-open + sweep racing) harmless and keeps the first writer's
/// result stable. Pointedly leaves `modified`/`dirty` untouched: this is derived
/// local data and must not trigger a sync push.
pub fn store_text(conn: &Connection, note_id: &str, text: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE notes SET pdf_text = ?2
         WHERE id = ?1 AND note_kind = 'pdf' AND pdf_text IS NULL",
        params![note_id, text],
    )?;
    Ok(())
}

/// Ids of non-trashed PDF notes that have no cached text yet. Drives the
/// frontend background backfill sweep.
pub fn notes_missing_text(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM notes
         WHERE note_kind = 'pdf' AND pdf_text IS NULL AND trashed_at IS NULL",
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
            SELECT 1 FROM notes
            WHERE id = ?1 AND note_kind = 'pdf' AND pdf_text IS NULL
         )",
        params![note_id],
        |row| row.get(0),
    )?;
    Ok(needs)
}

// ---------- Tauri commands ----------

#[tauri::command]
pub fn set_pdf_text(db: tauri::State<'_, Db>, note_id: String, text: String) -> Result<(), String> {
    db.with_conn(|c| store_text(c, &note_id, &text))
        .map_err(Into::into)
}

#[tauri::command]
pub fn pdf_notes_missing_text(db: tauri::State<'_, Db>) -> Result<Vec<String>, String> {
    db.with_conn(notes_missing_text).map_err(Into::into)
}

#[tauri::command]
pub fn pdf_note_needs_text(db: tauri::State<'_, Db>, note_id: String) -> Result<bool, String> {
    db.with_conn(|c| note_needs_text(c, &note_id))
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory_for_tests;
    use crate::notes::{create, CreateNote};

    fn make_pdf_note(db: &Db) -> String {
        db.with_conn(|c| {
            create(
                c,
                CreateNote {
                    title: Some("Paper".into()),
                    body: Some(r#"{"pdfAssetId":"asset_x"}"#.into()),
                    parent_collection_id: None,
                    note_kind: Some("pdf".into()),
                },
            )
        })
        .unwrap()
        .summary
        .id
    }

    fn dirty(db: &Db, id: &str) -> i64 {
        db.with_conn(|c| {
            c.query_row("SELECT dirty FROM notes WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .map_err(Into::into)
        })
        .unwrap()
    }

    #[test]
    fn set_then_missing_and_needs_reflect_state() {
        let db = open_memory_for_tests();
        let id = make_pdf_note(&db);

        // Freshly created → un-indexed.
        assert_eq!(db.with_conn(notes_missing_text).unwrap(), vec![id.clone()]);
        assert!(db.with_conn(|c| note_needs_text(c, &id)).unwrap());

        db.with_conn(|c| store_text(c, &id, "hello world")).unwrap();

        // Indexed → no longer missing / needed.
        assert!(db.with_conn(notes_missing_text).unwrap().is_empty());
        assert!(!db.with_conn(|c| note_needs_text(c, &id)).unwrap());
    }

    #[test]
    fn set_is_idempotent_and_keeps_first_write() {
        let db = open_memory_for_tests();
        let id = make_pdf_note(&db);
        db.with_conn(|c| store_text(c, &id, "first")).unwrap();
        // Second call must not overwrite (pdf_text IS NULL guard).
        db.with_conn(|c| store_text(c, &id, "second")).unwrap();
        let stored: String = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT pdf_text FROM notes WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .map_err(Into::into)
            })
            .unwrap();
        assert_eq!(stored, "first");
    }

    #[test]
    fn set_does_not_dirty_the_note() {
        let db = open_memory_for_tests();
        let id = make_pdf_note(&db);
        // Clear the create-time dirty flag so we can detect a spurious bump.
        db.with_conn(|c| {
            c.execute("UPDATE notes SET dirty = 0 WHERE id = ?1", params![id])
                .map(|_| ())
                .map_err(Into::into)
        })
        .unwrap();

        db.with_conn(|c| store_text(c, &id, "content")).unwrap();

        assert_eq!(dirty(&db, &id), 0, "indexing must not mark the note dirty");
    }

    #[test]
    fn ignores_non_pdf_notes() {
        let db = open_memory_for_tests();
        let md = db
            .with_conn(|c| {
                create(
                    c,
                    CreateNote {
                        title: Some("Note".into()),
                        body: Some("body".into()),
                        parent_collection_id: None,
                        note_kind: None,
                    },
                )
            })
            .unwrap()
            .summary
            .id;

        assert!(db.with_conn(notes_missing_text).unwrap().is_empty());
        assert!(!db.with_conn(|c| note_needs_text(c, &md)).unwrap());
        // A stray set on a markdown note is a no-op.
        db.with_conn(|c| store_text(c, &md, "x")).unwrap();
    }
}
