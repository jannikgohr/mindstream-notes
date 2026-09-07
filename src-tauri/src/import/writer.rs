//! Batched SQLite writes for an import run.
//!
//! Deliberately bypasses [`crate::notes::create`]. That helper runs a
//! `MAX(position)` query and then re-reads the row it just wrote, which is
//! two extra round trips per note — invisible when a human creates one note,
//! ruinous across a million. Here the position counters live in memory and
//! nothing is read back.
//!
//! Work is committed in batches rather than one transaction for the whole
//! run, for two reasons: a cancel (or a crash) keeps everything already
//! written, and the global connection lock is released between batches so the
//! rest of the app isn't frozen for the duration of a large import.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};

use crate::db::Db;
use crate::error::AppResult;
use crate::notes::NoteKind;

use super::model::{AttachmentRef, FolderIndex, StagedNote};

/// A note ready to be written, with its attachment bytes already read.
pub struct PreparedNote {
    pub note: StagedNote,
    /// `(reference, bytes)` pairs. The body still carries each reference's
    /// placeholder; the writer swaps in the asset id it settles on, which may
    /// be an existing one if the bytes are already stored.
    pub attachments: Vec<(AttachmentRef, Vec<u8>)>,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct BatchOutcome {
    pub notes: usize,
    pub attachments: usize,
    pub attachments_deduplicated: usize,
}

/// Tracks the next free position per parent folder across the whole run.
///
/// Seeded from the database the first time a parent is seen — the destination
/// folder may already hold notes — and incremented in memory after that.
#[derive(Default)]
pub struct PositionCounters {
    next: HashMap<Option<String>, i64>,
}

impl PositionCounters {
    fn take(&mut self, conn: &Connection, parent: Option<&str>, table: &str) -> AppResult<i64> {
        let key = parent.map(str::to_string);
        if let Some(slot) = self.next.get_mut(&key) {
            let value = *slot;
            *slot += 1;
            return Ok(value);
        }
        let sql = match parent {
            Some(_) => format!("SELECT MAX(position) FROM {table} WHERE parent_collection_id = ?1"),
            None => format!("SELECT MAX(position) FROM {table} WHERE parent_collection_id IS NULL"),
        };
        let max: Option<i64> = match parent {
            Some(id) => conn
                .query_row(&sql, params![id], |r| r.get(0))
                .optional()?
                .flatten(),
            None => conn.query_row(&sql, [], |r| r.get(0)).optional()?.flatten(),
        };
        let start = max.unwrap_or(-1) + 1;
        self.next.insert(key, start + 1);
        Ok(start)
    }
}

/// Create every folder the source described, in one transaction.
///
/// `destination` is the collection the whole import lands under (`None` for
/// the vault root). Folders arrive parent-before-child from the index pass, so
/// a single ordered insert satisfies the foreign key.
pub fn write_folders(
    db: &Db,
    folders: &[FolderIndex],
    destination: Option<&str>,
    share_scope_id: Option<&str>,
) -> AppResult<usize> {
    if folders.is_empty() {
        return Ok(0);
    }
    db.with_conn_mut(|conn| {
        let tx = conn.transaction()?;
        let now = chrono::Utc::now().to_rfc3339();
        let mut positions = PositionCounters::default();
        {
            let mut stmt = tx.prepare_cached(
                "INSERT INTO collections(id, parent_collection_id, name, position,
                                         created, modified, dirty, share_scope_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5, 1, ?6)",
            )?;
            for folder in folders {
                let parent = folder.parent_id.as_deref().or(destination);
                let position = positions.take(&tx, parent, "collections")?;
                stmt.execute(params![
                    folder.id,
                    parent,
                    folder.name,
                    position,
                    now,
                    share_scope_id,
                ])?;
            }
        }
        tx.commit()?;
        Ok(folders.len())
    })
}

/// Write one batch of notes, their tags, and their attachments.
pub fn write_batch(
    db: &Db,
    batch: Vec<PreparedNote>,
    destination: Option<&str>,
    share_scope_id: Option<&str>,
    positions: &mut PositionCounters,
) -> AppResult<BatchOutcome> {
    if batch.is_empty() {
        return Ok(BatchOutcome::default());
    }
    db.with_conn_mut(|conn| {
        let tx = conn.transaction()?;
        let now = chrono::Utc::now().to_rfc3339();
        let mut outcome = BatchOutcome::default();

        for prepared in batch {
            let note = &prepared.note;
            let parent = note.folder_id.as_deref().or(destination);
            let position = positions.take(&tx, parent, "notes")?;
            let created = note.created.clone().unwrap_or_else(|| now.clone());
            let modified = note.modified.clone().unwrap_or_else(|| created.clone());

            // yrs_state is left empty exactly as notes::create leaves it: the
            // editor hydrates a Y.Doc from the body on first open. Seeding one
            // per note here would cost a CRDT encode for every note in the
            // vault to produce state the editor may never look at.
            tx.prepare_cached(
                "INSERT INTO notes(id, parent_collection_id, title, body, position,
                                   created, modified, dirty, note_kind, share_scope_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9)",
            )?
            .execute(params![
                note.note_id,
                parent,
                note.title,
                note.body,
                position,
                created,
                modified,
                NoteKind::Markdown,
                share_scope_id,
            ])?;

            for tag in &note.tags {
                tx.prepare_cached("INSERT OR IGNORE INTO note_tags(note_id, tag) VALUES (?1, ?2)")?
                    .execute(params![note.note_id, tag])?;
            }

            if !prepared.attachments.is_empty() {
                let stored = store_attachments(&tx, note, &prepared.attachments)?;
                outcome.attachments += stored.written;
                outcome.attachments_deduplicated += stored.deduplicated;
            }
            outcome.notes += 1;
        }

        tx.commit()?;
        Ok(outcome)
    })
}

struct StoredAttachments {
    written: usize,
    deduplicated: usize,
}

/// Store each attachment and patch the body to point at the asset ids.
///
/// This runs after the note row exists because `store_deduped` writes a
/// reference row against it. Notes without attachments — the overwhelming
/// majority in a wiki-scale import — never reach here and cost exactly one
/// INSERT.
fn store_attachments(
    conn: &Connection,
    note: &StagedNote,
    attachments: &[(AttachmentRef, Vec<u8>)],
) -> AppResult<StoredAttachments> {
    let mut body = note.body.clone();
    let mut written = 0usize;
    let mut deduplicated = 0usize;

    for (reference, bytes) in attachments {
        let stored =
            crate::assets::store_deduped(conn, &note.note_id, &reference.mime_type, bytes)?;
        if stored.deduplicated {
            deduplicated += 1;
        } else {
            written += 1;
        }
        body = replace_link_target(
            &body,
            &reference.placeholder,
            &format!("asset:mindstream/{}", stored.id),
        );
    }

    conn.execute(
        "UPDATE notes SET body = ?1 WHERE id = ?2",
        params![body, note.note_id],
    )?;
    Ok(StoredAttachments {
        written,
        deduplicated,
    })
}

/// Swap a link's *target* for `replacement`, leaving its text alone.
///
/// A plain `str::replace` is wrong here, and quietly so: `![pic.png](pic.png)`
/// — which is exactly what an Obsidian `![[pic.png]]` embed expands to — would
/// have its alt text rewritten into an asset URL too. Anchoring on the `](`
/// that opens a target, and requiring the match to end the target, confines
/// the edit to where it belongs.
///
/// Every occurrence is replaced, since a note may embed the same image twice.
fn replace_link_target(body: &str, target: &str, replacement: &str) -> String {
    if target.is_empty() {
        return body.to_string();
    }
    let opener = format!("]({target}");
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(at) = rest.find(&opener) {
        let after = &rest[at + opener.len()..];
        // A title can follow the target (`](a.png "Caption")`), so accept a
        // space as well as the closing paren.
        let ends_target = matches!(after.chars().next(), Some(')') | Some(' ') | Some('\t'));
        if !ends_target {
            let consumed = at + opener.len();
            out.push_str(&rest[..consumed]);
            rest = after;
            continue;
        }
        out.push_str(&rest[..at]);
        out.push_str("](");
        out.push_str(replacement);
        rest = after;
    }
    out.push_str(rest);
    out
}

/// Create the empty notes minted for link targets the source never defined.
pub fn write_placeholders(
    db: &Db,
    placeholders: &[super::links::Placeholder],
    destination: Option<&str>,
    share_scope_id: Option<&str>,
    positions: &mut PositionCounters,
) -> AppResult<usize> {
    if placeholders.is_empty() {
        return Ok(0);
    }
    db.with_conn_mut(|conn| {
        let tx = conn.transaction()?;
        let now = chrono::Utc::now().to_rfc3339();
        {
            let mut stmt = tx.prepare_cached(
                "INSERT INTO notes(id, parent_collection_id, title, body, position,
                                   created, modified, dirty, note_kind, share_scope_id)
                 VALUES (?1, ?2, ?3, '', ?4, ?5, ?5, 1, ?6, ?7)",
            )?;
            for placeholder in placeholders {
                let position = positions.take(&tx, destination, "notes")?;
                let title = if placeholder.title.is_empty() {
                    "Untitled"
                } else {
                    &placeholder.title
                };
                stmt.execute(params![
                    placeholder.note_id,
                    destination,
                    title,
                    position,
                    now,
                    NoteKind::Markdown,
                    share_scope_id,
                ])?;
            }
        }
        tx.commit()?;
        Ok(placeholders.len())
    })
}
