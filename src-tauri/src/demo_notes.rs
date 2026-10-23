//! Demo notes: the example notes setup can add to a vault.
//!
//! Their text lives in the repo under `demo-notes/<slug>/<lang>.md`. At setup
//! the editor turns each file into the document the note starts from (see
//! src/lib/onboarding/demo-notes.ts), and this module names the note after
//! that document: `demo_<slug>_<lang>_<hash>`, the hash covering the title and
//! the encoded Yjs state.
//!
//! Two devices that hold the same id therefore started from identical bytes,
//! and sync merges their edits like any other note's. Text that renders
//! differently (edited demo text, another editor version) gets another id and
//! becomes a separate note, so a duplicate is the worst case, never lost
//! content. A note that exists is never touched again, by setup or by an app
//! update.
//!
//! The one rule this needs elsewhere: a demo note never enters a shared
//! folder. Sync matches notes by id, so someone else holding the same demo
//! note could not take in the shared one.

use rusqlite::{params, Connection};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

const ID_PREFIX: &str = "demo_";

/// The UI translates this word, see src/lib/account/refusal.ts.
const REASON_NOT_SHAREABLE: &str = "demo_note_not_shareable";

const MAX_NOTES: usize = 32;
const MAX_TITLE: usize = 512;
const MAX_BODY: usize = 64 * 1024;
const MAX_STATE: usize = 1024 * 1024;

/// One demo note as the editor rendered it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DemoNote {
    /// The note's directory under `demo-notes/`.
    slug: String,
    /// The language of the file the note came from.
    lang: String,
    title: String,
    /// The markdown the editor serialised from `yrs_state`.
    body: String,
    /// The y-prosemirror document (payload_schema 2) the note starts from.
    yrs_state: Vec<u8>,
}

impl DemoNote {
    fn id(&self) -> String {
        let mut hash = Sha256::new();
        hash.update((self.title.len() as u64).to_le_bytes());
        hash.update(self.title.as_bytes());
        hash.update(&self.yrs_state);
        let hex: String = hash.finalize()[..8]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        format!("{ID_PREFIX}{}_{}_{hex}", self.slug, self.lang)
    }

    fn validate(&self) -> AppResult<()> {
        let slug_ok = (1..=64).contains(&self.slug.len())
            && self
                .slug
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        let lang_ok =
            (2..=3).contains(&self.lang.len()) && self.lang.bytes().all(|b| b.is_ascii_lowercase());
        if !slug_ok
            || !lang_ok
            || self.title.is_empty()
            || self.title.len() > MAX_TITLE
            || self.body.len() > MAX_BODY
            || self.yrs_state.len() > MAX_STATE
            || !crate::sync::yrs_doc::has_editor_content(&self.yrs_state)
        {
            return Err(AppError::InvalidArg(format!(
                "invalid demo note {}/{}",
                self.slug, self.lang
            )));
        }
        Ok(())
    }
}

pub fn is_demo_note(id: &str) -> bool {
    id.starts_with(ID_PREFIX)
}

/// Add each note unless one with its id exists, and return the ids in order.
/// A note that exists is left exactly as it is, edits and all.
pub(crate) fn insert(conn: &Connection, notes: &[DemoNote], now: &str) -> AppResult<Vec<String>> {
    if notes.len() > MAX_NOTES {
        return Err(AppError::InvalidArg("too many demo notes".into()));
    }
    for note in notes {
        note.validate()?;
    }
    let mut ids = Vec::with_capacity(notes.len());
    for (position, note) in notes.iter().enumerate() {
        let id = note.id();
        // dirty = 0: an unedited demo note stays on this device. Pushed, its
        // demo title would win over a rename another device made to the same
        // note, because a dirty row keeps its own metadata through a pull.
        // The first change marks it dirty like any note's.
        conn.execute(
            "INSERT INTO notes(id, title, body, position, created, modified, yrs_state,
                               payload_schema, dirty)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, 2, 0)
             ON CONFLICT(id) DO NOTHING",
            params![
                id,
                note.title,
                note.body,
                position as i64,
                now,
                note.yrs_state
            ],
        )?;
        ids.push(id);
    }
    Ok(ids)
}

/// Refuse to move a demo note into a shared folder.
pub(crate) fn ensure_note_shareable(note_id: &str) -> AppResult<()> {
    if is_demo_note(note_id) {
        return Err(not_shareable());
    }
    Ok(())
}

/// Refuse to share a folder, or to move it into a shared one, while a demo
/// note is in it.
pub(crate) fn ensure_folder_shareable(conn: &Connection, root_folder_id: &str) -> AppResult<()> {
    let holds_demo_note: bool = conn.query_row(
        "WITH RECURSIVE subtree(id) AS (
            SELECT ?1
            UNION ALL
            SELECT c.id FROM collections c JOIN subtree s ON c.parent_collection_id = s.id
        )
        SELECT EXISTS(
            SELECT 1 FROM notes
             WHERE parent_collection_id IN (SELECT id FROM subtree)
               AND substr(id, 1, length(?2)) = ?2
        )",
        params![root_folder_id, ID_PREFIX],
        |row| row.get(0),
    )?;
    if holds_demo_note {
        return Err(not_shareable());
    }
    Ok(())
}

fn not_shareable() -> AppError {
    AppError::Refused {
        reason: REASON_NOT_SHAREABLE,
        message: "demo notes can't be shared".into(),
    }
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
