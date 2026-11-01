//! Native adapters for the shared PDF text cache.
use crate::db::Db;
use crate::error::{AppResult, CommandResult};
use rusqlite::{params, Connection, OptionalExtension};
pub fn store_text(c: &Connection, id: &str, text: &str) -> AppResult<()> {
    mindstream_storage_core::pdf_text::store_text(c, id, text).map_err(Into::into)
}
pub fn notes_missing_text(c: &Connection) -> AppResult<Vec<String>> {
    mindstream_storage_core::pdf_text::notes_missing_text(c).map_err(Into::into)
}
pub fn note_needs_text(c: &Connection, id: &str) -> AppResult<bool> {
    mindstream_storage_core::pdf_text::note_needs_text(c, id).map_err(Into::into)
}
pub(crate) fn store_ink_text(
    c: &Connection,
    id: &str,
    text: &str,
    signature: &str,
) -> AppResult<()> {
    mindstream_storage_core::pdf_text::store_ink_text(c, id, text, signature).map_err(Into::into)
}
// ---------- Tauri commands ----------

#[tauri::command]
pub fn pdf_page_text(
    db: tauri::State<'_, Db>,
    asset_id: String,
    page_index: u32,
    text: Option<String>,
) -> CommandResult<Option<String>> {
    db.with_conn(|c| {
        if let Some(text) = &text {
            c.execute("INSERT OR REPLACE INTO pdf_page_text(asset_id, page_index, text) VALUES (?1, ?2, ?3)", params![asset_id, page_index, text])?;
        }
        Ok(c.query_row("SELECT text FROM pdf_page_text WHERE asset_id = ?1 AND page_index = ?2 AND extraction_version = 1", params![asset_id, page_index], |r| r.get(0)).optional()?)
    }).map_err(Into::into)
}

#[tauri::command]
pub fn set_pdf_text(
    db: tauri::State<'_, Db>,
    note_id: String,
    text: String,
    expected_signature: Option<String>,
) -> CommandResult<()> {
    db.with_conn(|c| {
        if let Some(signature) = &expected_signature {
            store_ink_text(c, &note_id, &text, signature)
        } else {
            store_text(c, &note_id, &text)
        }
    })
    .map_err(Into::into)
}

#[tauri::command]
pub fn pdf_notes_missing_text(db: tauri::State<'_, Db>) -> CommandResult<Vec<String>> {
    db.with_conn(notes_missing_text).map_err(Into::into)
}

#[tauri::command]
pub fn pdf_note_needs_text(db: tauri::State<'_, Db>, note_id: String) -> CommandResult<bool> {
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
