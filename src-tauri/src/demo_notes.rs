//! Native adapters for shared setup notes and share guards.
#[cfg(test)]
use crate::error::AppError;
use crate::error::AppResult;
pub use mindstream_storage_core::demo_notes::*;
use rusqlite::Connection;
pub fn insert(conn: &Connection, notes: &[DemoNote], now: &str) -> AppResult<Vec<String>> {
    mindstream_storage_core::demo_notes::insert(conn, notes, now).map_err(Into::into)
}

pub fn ensure_note_shareable(note_id: &str) -> AppResult<()> {
    mindstream_storage_core::demo_notes::ensure_note_shareable(note_id).map_err(Into::into)
}

pub fn ensure_folder_shareable(conn: &Connection, root_folder_id: &str) -> AppResult<()> {
    mindstream_storage_core::demo_notes::ensure_folder_shareable(conn, root_folder_id)
        .map_err(Into::into)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::yrs_doc::editor_state_for_tests;

    fn note(slug: &str, title: &str, text: &str) -> DemoNote {
        DemoNote {
            slug: slug.into(),
            lang: "en".into(),
            title: title.into(),
            body: format!("{text}\n"),
            yrs_state: editor_state_for_tests(text),
        }
    }

    fn row(conn: &Connection, id: &str) -> (String, String, i64, i64) {
        conn.query_row(
            "SELECT title, body, payload_schema, dirty FROM notes WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap()
    }

    #[test]
    fn the_same_document_gets_the_same_id_and_any_difference_another() {
        let welcome = note("welcome", "Welcome", "Hello");
        let id = welcome.id();
        assert!(id.starts_with("demo_welcome_en_"));
        assert_eq!(id.len(), "demo_welcome_en_".len() + 16);
        assert!(is_demo_note(&id));
        // Same bytes from another device: same note.
        let again = note("welcome", "Welcome", "Hello");
        assert_eq!(again.id(), id);
        // The body is derived from the state and does not name the note.
        let other_body = DemoNote {
            body: "different serialisation".into(),
            ..note("welcome", "Welcome", "Hello")
        };
        assert_eq!(other_body.id(), id);
        // Other text, another title or another language: another note.
        assert_ne!(note("welcome", "Welcome", "Hallo").id(), id);
        assert_ne!(note("welcome", "Hi", "Hello").id(), id);
        let german = DemoNote {
            lang: "de".into(),
            ..note("welcome", "Welcome", "Hello")
        };
        assert_ne!(german.id(), id);
    }

    #[test]
    fn rejects_what_the_editor_cannot_have_made() {
        for bad in [
            note("Welcome", "Welcome", "Hello"),
            note("wel_come", "Welcome", "Hello"),
            note("", "Welcome", "Hello"),
            note("welcome", "", "Hello"),
            DemoNote {
                lang: "en-GB".into(),
                ..note("welcome", "Welcome", "Hello")
            },
            DemoNote {
                yrs_state: crate::sync::yrs_doc::init_with_markdown("Hello"),
                ..note("welcome", "Welcome", "Hello")
            },
            DemoNote {
                yrs_state: Vec::new(),
                ..note("welcome", "Welcome", "Hello")
            },
        ] {
            assert!(bad.validate().is_err(), "accepted {}", bad.slug);
        }
        assert!(note("welcome-2", "Welcome", "Hello").validate().is_ok());
    }

    #[test]
    fn adds_each_note_once_and_never_touches_one_that_exists() {
        let db = crate::db::open_memory_for_tests();
        db.with_conn(|conn| {
            let notes = [
                note("welcome", "Welcome", "Hello"),
                note("basics", "Basics", "Text"),
            ];
            let ids = insert(conn, &notes, "2026-10-21T00:00:00Z")?;
            assert_eq!(ids.len(), 2);
            assert_eq!(
                row(conn, &ids[0]),
                ("Welcome".into(), "Hello\n".into(), 2, 0)
            );

            // The user edits the note, then runs setup again.
            conn.execute(
                "UPDATE notes SET title = 'Mine', body = 'Edited', dirty = 1 WHERE id = ?1",
                [&ids[0]],
            )?;
            let again = insert(conn, &notes, "2026-10-22T00:00:00Z")?;
            assert_eq!(again, ids);
            assert_eq!(row(conn, &ids[0]), ("Mine".into(), "Edited".into(), 2, 1));
            let count: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))?;
            assert_eq!(count, 2);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn a_demo_note_stays_out_of_shared_folders() {
        let db = crate::db::open_memory_for_tests();
        db.with_conn(|conn| {
            let ids = insert(
                conn,
                &[note("welcome", "Welcome", "Hello")],
                "2026-10-21T00:00:00Z",
            )?;
            let demo = &ids[0];
            conn.execute_batch(
                "INSERT INTO collections(id, name, created, modified)
                     VALUES ('outer', 'Outer', 'now', 'now');
                 INSERT INTO collections(id, name, parent_collection_id, created, modified)
                     VALUES ('inner', 'Inner', 'outer', 'now', 'now');",
            )?;
            conn.execute(
                "UPDATE notes SET parent_collection_id = 'inner' WHERE id = ?1",
                [demo],
            )?;

            let refused = |result: AppResult<()>| {
                matches!(
                    result,
                    Err(AppError::Refused {
                        reason: REASON_NOT_SHAREABLE,
                        ..
                    })
                )
            };
            assert!(refused(crate::sharing::rehome_note_subtree(
                conn,
                demo,
                Some("scope")
            )));
            assert!(refused(crate::sharing::rehome_folder_subtree(
                conn,
                "outer",
                Some("scope")
            )));
            let scoped: i64 = conn.query_row(
                "SELECT COUNT(*) FROM collections WHERE share_scope_id IS NOT NULL",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(scoped, 0);

            // Out of a share and back into the vault is always allowed.
            crate::sharing::rehome_note_subtree(conn, demo, None)?;
            crate::sharing::rehome_folder_subtree(conn, "outer", None)?;
            // So is sharing a folder that holds ordinary notes only.
            conn.execute(
                "UPDATE notes SET parent_collection_id = NULL WHERE id = ?1",
                [demo],
            )?;
            ensure_folder_shareable(conn, "outer")?;
            Ok(())
        })
        .unwrap();
    }
}
