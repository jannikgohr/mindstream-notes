//! Demo notes: the example notes setup can add to a vault.
//!
//! Their text lives under `src/lib/onboarding/demo-notes/<slug>/<lang>.md`.
//! At setup the editor turns each file into the document the note starts from (see
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

pub const ID_PREFIX: &str = "demo_";

/// The UI translates this word, see src/lib/account/refusal.ts.
pub const REASON_NOT_SHAREABLE: &str = "demo_note_not_shareable";

pub const MAX_NOTES: usize = 32;
pub const MAX_TITLE: usize = 512;
pub const MAX_BODY: usize = 64 * 1024;
pub const MAX_STATE: usize = 1024 * 1024;

/// One demo note as the editor rendered it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DemoNote {
    /// The note's directory under `src/lib/onboarding/demo-notes/`.
    pub slug: String,
    /// The language of the file the note came from.
    pub lang: String,
    pub title: String,
    /// The markdown the editor serialised from `yrs_state`.
    pub body: String,
    /// The y-prosemirror document (payload_schema 2) the note starts from.
    pub yrs_state: Vec<u8>,
}

impl DemoNote {
    pub fn id(&self) -> String {
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

    pub fn validate(&self) -> AppResult<()> {
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
            || !crate::yrs_doc::has_editor_content(&self.yrs_state)
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
pub fn insert(conn: &Connection, notes: &[DemoNote], now: &str) -> AppResult<Vec<String>> {
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
pub fn ensure_note_shareable(note_id: &str) -> AppResult<()> {
    if is_demo_note(note_id) {
        return Err(not_shareable());
    }
    Ok(())
}

/// Refuse to share a folder, or to move it into a shared one, while a demo
/// note is in it.
pub fn ensure_folder_shareable(conn: &Connection, root_folder_id: &str) -> AppResult<()> {
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

pub fn not_shareable() -> AppError {
    AppError::Refused {
        reason: REASON_NOT_SHAREABLE,
        message: "demo notes can't be shared".into(),
    }
}
