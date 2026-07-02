//! Notes — CRUD + Tauri commands.
//!
//! Two views of a note:
//!   - `NoteSummary`: id, title, parent, modified, position. Cheap to list
//!     and render in the file tree / metadata panel.
//!   - `Note`: NoteSummary + body. Loaded on demand when an editor opens.
//!
//! Soft-delete via `trashed_at`; listing skips trashed unless asked.

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::serde_helpers::double_option;
use crate::sync::{tags_crdt, yrs_doc};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteSummary {
    pub id: String,
    pub parent_collection_id: Option<String>,
    pub title: String,
    pub position: i64,
    pub created: String,
    pub modified: String,
    pub tags: Vec<String>,
    pub trashed: bool,
    pub favourite: bool,
    /// True once the note has been pushed to the remote at least once
    /// (i.e. `etebase_uid IS NOT NULL`). The frontend watches this to
    /// know when live collab becomes reachable for a fresh note —
    /// `note_room_info` resolves the room key off the server payload,
    /// which only exists post-push. Doesn't track dirty-ness; a synced
    /// row with unsynced edits still reports `pushed: true`.
    pub pushed: bool,
    /// Discriminator that tells the frontend which editor component to
    /// render. Values in use today: `"markdown"` (Crepe / y-prosemirror),
    /// `"freeform"` / `"ink"` (drawing surfaces), and `"pdf"` (PDF bytes
    /// stored as a separate asset, annotations in yrs_state).
    /// On the summary so the file tree / dispatch can branch without
    /// loading the full note. Serde-defaulted to "markdown" so legacy
    /// rows decoded before the column existed still parse cleanly.
    #[serde(default = "default_note_kind")]
    pub note_kind: String,
}

pub fn default_note_kind() -> String {
    "markdown".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    #[serde(flatten)]
    pub summary: NoteSummary,
    pub body: String,
    /// Encoded yrs Doc state. Empty for never-edited notes. The editor
    /// uses this to hydrate the y-prosemirror Doc on open.
    #[serde(default)]
    pub yrs_state: Vec<u8>,
    /// 1 = legacy Y.Text format, 2 = y-prosemirror XmlFragment.
    /// The editor reads this to decide whether to migrate.
    #[serde(default = "default_payload_schema")]
    pub payload_schema: u32,
}

fn default_payload_schema() -> u32 {
    1
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateNote {
    pub title: Option<String>,
    pub body: Option<String>,
    pub parent_collection_id: Option<String>,
    /// Optional discriminator. Omitted ⇒ defaults to "markdown" in
    /// `create()`, matching existing call sites that don't know about
    /// kinds. The frontend sets this for non-markdown note variants such
    /// as drawings, ink notes, and imported PDFs.
    #[serde(default)]
    pub note_kind: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateNote {
    pub id: String,
    pub title: Option<String>,
    pub body: Option<String>,
    /// Outer Some => change parent. Inner Option is the new value (None = root).
    /// Outer Some => change parent. Inner Option = the new value
    /// (`Some(id)` to a specific folder, `None` for root).
    /// The custom deserializer is needed because plain
    /// `Option<Option<T>>` collapses `null` into outer `None`,
    /// which would silently turn a 'move to root' into a no-op.
    #[serde(default, deserialize_with = "double_option")]
    pub parent_collection_id: Option<Option<String>>,
    pub position: Option<i64>,
    pub tags: Option<Vec<String>>,
    /// When the live-collab editor is driving the save, it supplies the
    /// yrs Doc state alongside the rendered markdown body. Presence of
    /// this field also flips the row's payload_schema to 2, so future
    /// pushes use the v2 NotePayload format. Absence preserves the
    /// legacy Rust-side "diff old vs new markdown into Y.Text" path.
    #[serde(default)]
    pub yrs_state: Option<Vec<u8>>,
    /// Toggle the favourite bit. Some(true)/Some(false) writes; None
    /// leaves the existing value untouched.
    pub favourite: Option<bool>,
}

fn row_to_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<NoteSummary> {
    let trashed_at: Option<String> = row.get("trashed_at")?;
    let favourite: i64 = row.get("favourite")?;
    let etebase_uid: Option<String> = row.get("etebase_uid")?;
    Ok(NoteSummary {
        id: row.get("id")?,
        parent_collection_id: row.get("parent_collection_id")?,
        title: row.get("title")?,
        position: row.get("position")?,
        created: row.get("created")?,
        modified: row.get("modified")?,
        tags: Vec::new(),
        trashed: trashed_at.is_some(),
        favourite: favourite != 0,
        pushed: etebase_uid.is_some(),
        note_kind: row.get("note_kind")?,
    })
}

fn load_tags(conn: &Connection, note_id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT tag FROM note_tags WHERE note_id = ?1 ORDER BY tag")?;
    let rows = stmt.query_map(params![note_id], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn list(conn: &Connection, include_trashed: bool) -> AppResult<Vec<NoteSummary>> {
    let sql = if include_trashed {
        "SELECT id, parent_collection_id, title, position, created, modified,
                trashed_at, favourite, etebase_uid, note_kind
         FROM notes
         ORDER BY parent_collection_id IS NOT NULL, parent_collection_id, position, title"
    } else {
        "SELECT id, parent_collection_id, title, position, created, modified,
                trashed_at, favourite, etebase_uid, note_kind
         FROM notes
         WHERE trashed_at IS NULL
         ORDER BY parent_collection_id IS NOT NULL, parent_collection_id, position, title"
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], row_to_summary)?;
    let mut summaries = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    for s in &mut summaries {
        s.tags = load_tags(conn, &s.id)?;
    }
    Ok(summaries)
}

/// Cheap-write helper for ink notes: merges incoming Yrs bytes into
/// the existing `yrs_state`, then updates JUST that column plus
/// `modified` / `dirty`, no body / tags / parent shuffling.
/// Used by the drawing save worker to flush in-memory `StrokesDoc`
/// bytes to disk without going through the full `update` path
/// (which is shaped for general note updates incl. body diffing,
/// payload-schema bumping, parent moves, …).
///
/// The merge matters because Android/native and desktop web can both
/// produce full-state Yrs updates for the same note. Overwriting here
/// would make the last saver win; applying the incoming state onto
/// the row's current state lets Yjs/Yrs converge instead.
///
/// Returns `Ok(false)` if the note id doesn't exist (caller's
/// pending save has nothing to land on — note was deleted while the
/// debounce was pending). Returns `Ok(true)` on a successful row
/// update.
pub fn save_yrs_state(conn: &mut Connection, id: &str, bytes: &[u8]) -> AppResult<bool> {
    let now = chrono::Utc::now().to_rfc3339();
    let tx = conn.transaction()?;
    let existing_row: Option<Option<Vec<u8>>> = tx
        .query_row(
            "SELECT yrs_state FROM notes WHERE id = ?1",
            params![id],
            |row| row.get::<_, Option<Vec<u8>>>(0),
        )
        .optional()?;
    let Some(existing_state) = existing_row else {
        return Ok(false);
    };
    let existing_state = existing_state.unwrap_or_default();
    let merged_state = if existing_state.is_empty() {
        bytes.to_vec()
    } else if bytes.is_empty() {
        existing_state
    } else {
        yrs_doc::merge_remote(&existing_state, bytes)
    };
    tx.execute(
        "UPDATE notes SET yrs_state = ?1, modified = ?2, dirty = 1 WHERE id = ?3",
        params![merged_state, now, id],
    )?;
    tx.commit()?;
    Ok(true)
}

/// Cheap fetch of just the `yrs_state` blob for a note id, skipping
/// the rest of the row + the serde-derive overhead of building a
/// `Note`. Used by ink-note open (`drawing_show`) to dodge the
/// ~200KB/MB-class IPC cost of shipping a heavy `yrs_state` from
/// SQLite → JS → back across Tauri's JSON-encoded IPC. Returns an
/// empty `Vec` for a missing note or a null yrs_state column —
/// matching the "fresh doc" treatment downstream.
pub fn load_yrs_state(conn: &Connection, id: &str) -> AppResult<Vec<u8>> {
    let state: Option<Option<Vec<u8>>> = conn
        .query_row(
            "SELECT yrs_state FROM notes WHERE id = ?1",
            params![id],
            |row| row.get::<_, Option<Vec<u8>>>(0),
        )
        .optional()?;
    Ok(state.flatten().unwrap_or_default())
}

pub fn load(conn: &Connection, id: &str) -> AppResult<Note> {
    let mut stmt = conn.prepare(
        "SELECT id, parent_collection_id, title, position, created, modified,
                trashed_at, favourite, etebase_uid, note_kind,
                body, yrs_state, payload_schema
         FROM notes WHERE id = ?1",
    )?;
    let row_data = stmt
        .query_row(params![id], |row| {
            let summary = row_to_summary(row)?;
            let body: String = row.get("body")?;
            let yrs_state: Option<Vec<u8>> = row.get("yrs_state")?;
            let payload_schema: i64 = row.get("payload_schema")?;
            Ok((summary, body, yrs_state, payload_schema))
        })
        .optional()?;

    match row_data {
        Some((mut summary, body, yrs_state, payload_schema)) => {
            summary.tags = load_tags(conn, id)?;
            Ok(Note {
                summary,
                body,
                yrs_state: yrs_state.unwrap_or_default(),
                payload_schema: payload_schema.max(1) as u32,
            })
        }
        None => Err(AppError::NotFound(format!("note {id}"))),
    }
}

pub fn create(conn: &Connection, input: CreateNote) -> AppResult<Note> {
    let id = format!("note_{}", uuid::Uuid::new_v4());
    let now = Utc::now().to_rfc3339();
    let position = next_position(conn, input.parent_collection_id.as_deref())?;
    let title = input.title.unwrap_or_else(|| "Untitled".to_string());
    let body = input.body.unwrap_or_default();
    let note_kind = input.note_kind.unwrap_or_else(default_note_kind);
    // Leave yrs_state empty for new notes — the live editor (markdown OR
    // freeform) will hydrate a fresh Y.Doc on first open and write the
    // resulting v2 state back through `update`. Pre-seeding a v1 Y.Text
    // here would fight the editor's initialisation, and is meaningless
    // for freeform notes anyway.
    // If the new note is being created directly under the trash
    // collection (rare in practice — UI normally moves an existing note
    // there), stamp `trashed_at` up front so the retention sweep can
    // age it out. Saves a separate stamping pass through the
    // collections::stamp_trashed_at_on_parent_change helper.
    let trashed_at: Option<&str> =
        if input.parent_collection_id.as_deref() == Some(crate::collections::TRASH_ID) {
            Some(&now)
        } else {
            None
        };
    conn.execute(
        "INSERT INTO notes(id, parent_collection_id, title, body, position,
                            created, modified, dirty, note_kind, trashed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 1, ?7, ?8)",
        params![
            id,
            input.parent_collection_id,
            title,
            body,
            position,
            now,
            note_kind,
            trashed_at,
        ],
    )?;
    load(conn, &id)
}

pub fn update(conn: &mut Connection, input: UpdateNote) -> AppResult<Note> {
    let now = Utc::now().to_rfc3339();
    let tx = conn.transaction()?;

    if let Some(title) = &input.title {
        tx.execute(
            "UPDATE notes SET title = ?1, modified = ?2 WHERE id = ?3",
            params![title, now, input.id],
        )?;
    }
    if let Some(new_body) = &input.body {
        // Two paths converge here:
        //   * The live-collab editor supplies its own yrs_state — it
        //     already owns the Doc, has applied the user's keystrokes
        //     through y-prosemirror, and computed the new state directly.
        //     We trust those bytes and stamp payload_schema=2.
        //   * Legacy callers (browser fallback, programmatic edits) just
        //     send the new markdown body. We diff old → new at byte
        //     granularity and replay against the v1 Y.Text Doc for CRDT
        //     correctness on offline-edit reconciliation.
        if let Some(supplied_state) = &input.yrs_state {
            tx.execute(
                "UPDATE notes
                 SET body = ?1, yrs_state = ?2, modified = ?3, payload_schema = 2
                 WHERE id = ?4",
                params![new_body, supplied_state, now, input.id],
            )?;
        } else {
            let (old_body, old_state) = tx.query_row(
                "SELECT body, yrs_state FROM notes WHERE id = ?1",
                params![input.id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<Vec<u8>>>(1)?)),
            )?;
            let base_state = match old_state {
                Some(s) if !s.is_empty() => s,
                _ => yrs_doc::init_with_markdown(&old_body),
            };
            let new_state = yrs_doc::apply_local_edit(&base_state, &old_body, new_body);
            // The diff path produces a Y.Text "body" doc — the v1 NotePayload
            // shape — so any row that gets here has to be marked v1, even if
            // it was previously a v2 (y-prosemirror) row. Otherwise the next
            // editor open would see payload_schema=2 + a v1-shaped state,
            // try to hydrate it as XmlFragment, get nothing, and silently
            // fall back to the body field. Stamping the schema keeps row
            // metadata in sync with the bytes we actually wrote.
            tx.execute(
                "UPDATE notes
                 SET body = ?1, yrs_state = ?2, modified = ?3, payload_schema = 1
                 WHERE id = ?4",
                params![new_body, new_state, now, input.id],
            )?;
        }
    } else if let Some(supplied_state) = &input.yrs_state {
        // Editor supplies a fresh yrs_state but no body — used by
        // note kinds whose document content lives entirely in the
        // CRDT and has no body equivalent (ink notes from C2 of the
        // native-egui-layer roadmap; future shape-only kinds). We
        // trust the supplied bytes verbatim; nothing about the
        // payload_schema discriminator (markdown v1 / v2) applies
        // here so we leave it alone.
        tx.execute(
            "UPDATE notes
             SET yrs_state = ?1, modified = ?2
             WHERE id = ?3",
            params![supplied_state, now, input.id],
        )?;
    }
    if let Some(parent) = &input.parent_collection_id {
        tx.execute(
            "UPDATE notes SET parent_collection_id = ?1, modified = ?2 WHERE id = ?3",
            params![parent, now, input.id],
        )?;
        // Mirror of the collection path: stamp `trashed_at` when the note
        // moves into the trash, clear it on the way out. The soft-delete
        // path in `notes::trash` keeps its own behaviour (writes
        // `trashed_at` without moving) for direct-trash operations.
        crate::collections::stamp_trashed_at_on_parent_change(
            &tx,
            "notes",
            &input.id,
            parent.as_deref(),
            &now,
        )?;
    }
    if let Some(position) = input.position {
        tx.execute(
            "UPDATE notes SET position = ?1, modified = ?2 WHERE id = ?3",
            params![position, now, input.id],
        )?;
    }
    if let Some(tags) = &input.tags {
        let old_tags = load_tags(&tx, &input.id)?;
        let old_tags_state: Vec<u8> = tx
            .query_row(
                "SELECT tags_state FROM notes WHERE id = ?1",
                params![input.id],
                |r| r.get::<_, Option<Vec<u8>>>(0),
            )?
            .unwrap_or_default();
        let tags_state = tags_crdt::apply_full_list(&old_tags_state, &old_tags, tags);
        tx.execute(
            "DELETE FROM note_tags WHERE note_id = ?1",
            params![input.id],
        )?;
        let mut stmt = tx.prepare("INSERT INTO note_tags(note_id, tag) VALUES (?1, ?2)")?;
        for tag in tags {
            stmt.execute(params![input.id, tag])?;
        }
        drop(stmt);
        tx.execute(
            "UPDATE notes SET tags_state = ?1, modified = ?2 WHERE id = ?3",
            params![tags_state, now, input.id],
        )?;
    }
    if let Some(fav) = input.favourite {
        tx.execute(
            "UPDATE notes SET favourite = ?1, modified = ?2 WHERE id = ?3",
            params![fav as i64, now, input.id],
        )?;
    }
    if input.body.is_some() {
        crate::assets::purge_unreferenced_markdown_assets(&tx, &input.id)?;
    }

    // Any update is a sync candidate. Doing this once at the end keeps the
    // per-field UPDATEs above unchanged and avoids a half-marked row if one
    // of them no-ops (e.g. UpdateNote with everything None).
    tx.execute(
        "UPDATE notes SET dirty = 1 WHERE id = ?1",
        params![input.id],
    )?;

    tx.commit()?;
    load(conn, &input.id)
}

pub fn trash(conn: &Connection, id: &str) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    let n = conn.execute(
        "UPDATE notes SET trashed_at = ?1, modified = ?1, dirty = 1 WHERE id = ?2",
        params![now, id],
    )?;
    if n == 0 {
        return Err(AppError::NotFound(format!("note {id}")));
    }
    Ok(())
}

pub fn restore(conn: &Connection, id: &str) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    let n = conn.execute(
        "UPDATE notes SET trashed_at = NULL, modified = ?1, dirty = 1 WHERE id = ?2",
        params![now, id],
    )?;
    if n == 0 {
        return Err(AppError::NotFound(format!("note {id}")));
    }
    Ok(())
}

pub fn purge(conn: &Connection, id: &str) -> AppResult<()> {
    // If the note had been pushed already, queue a server-side delete for
    // the next sync. We do tombstone-then-delete on a plain &Connection
    // (no transaction): tombstones is INSERT OR IGNORE and a stray
    // tombstone for a never-deleted row is harmless.
    let etebase_uid: Option<String> = conn
        .query_row(
            "SELECT etebase_uid FROM notes WHERE id = ?1",
            params![id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    if let Some(uid) = etebase_uid {
        crate::sync::queue_tombstone(conn, "note", &uid)?;
    }

    // Tombstone every asset that's been pushed for this note BEFORE the
    // DELETE — once the FK ON DELETE CASCADE fires, the asset rows are
    // gone and we can't recover their etebase_uids. Locally-only assets
    // (never pushed, etebase_uid IS NULL) need no server delete; the
    // cascade handles them.
    {
        let mut stmt = conn.prepare(
            "SELECT etebase_uid FROM assets
             WHERE owning_note_id = ?1 AND etebase_uid IS NOT NULL",
        )?;
        let rows = stmt.query_map(params![id], |r| r.get::<_, String>(0))?;
        for uid in rows {
            crate::sync::queue_tombstone(conn, "asset", &uid?)?;
        }
    }

    let n = conn.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
    if n == 0 {
        return Err(AppError::NotFound(format!("note {id}")));
    }
    Ok(())
}

fn next_position(conn: &Connection, parent: Option<&str>) -> AppResult<i64> {
    let max: Option<i64> = if let Some(p) = parent {
        conn.query_row(
            "SELECT MAX(position) FROM notes WHERE parent_collection_id = ?1",
            params![p],
            |r| r.get(0),
        )
        .optional()?
        .flatten()
    } else {
        conn.query_row(
            "SELECT MAX(position) FROM notes WHERE parent_collection_id IS NULL",
            [],
            |r| r.get(0),
        )
        .optional()?
        .flatten()
    };
    Ok(max.unwrap_or(-1) + 1)
}

// ---------- Tauri commands ----------

#[tauri::command]
pub fn list_notes(
    db: tauri::State<'_, Db>,
    include_trashed: Option<bool>,
) -> Result<Vec<NoteSummary>, String> {
    db.with_conn(|c| list(c, include_trashed.unwrap_or(false)))
        .map_err(Into::into)
}

#[tauri::command]
pub fn load_note(db: tauri::State<'_, Db>, id: String) -> Result<Note, String> {
    db.with_conn(|c| load(c, &id)).map_err(Into::into)
}

#[tauri::command]
pub fn create_note(db: tauri::State<'_, Db>, input: CreateNote) -> Result<Note, String> {
    db.with_conn(|c| create(c, input)).map_err(Into::into)
}

#[tauri::command]
pub fn save_note(db: tauri::State<'_, Db>, input: UpdateNote) -> Result<Note, String> {
    db.with_conn_mut(|c| update(c, input)).map_err(Into::into)
}

#[tauri::command]
pub fn trash_note(db: tauri::State<'_, Db>, id: String) -> Result<(), String> {
    db.with_conn(|c| trash(c, &id)).map_err(Into::into)
}

#[tauri::command]
pub fn restore_note(db: tauri::State<'_, Db>, id: String) -> Result<(), String> {
    db.with_conn(|c| restore(c, &id)).map_err(Into::into)
}

#[tauri::command]
pub fn purge_note(db: tauri::State<'_, Db>, id: String) -> Result<(), String> {
    db.with_conn(|c| purge(c, &id)).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collections::{create as create_collection, CreateCollection};
    use crate::db::open_memory_for_tests;

    fn empty_note(db: &Db, parent: Option<String>) -> Note {
        db.with_conn(|c| {
            create(
                c,
                CreateNote {
                    title: Some("Hello".into()),
                    body: Some("# Body".into()),
                    parent_collection_id: parent,
                    note_kind: None,
                },
            )
        })
        .unwrap()
    }

    #[test]
    fn create_then_load_round_trip() {
        let db = open_memory_for_tests();
        let n = empty_note(&db, None);
        let loaded = db.with_conn(|c| load(c, &n.summary.id)).unwrap();
        assert_eq!(loaded.summary.title, "Hello");
        assert_eq!(loaded.body, "# Body");
        assert!(loaded.summary.parent_collection_id.is_none());
        assert!(!loaded.summary.trashed);
    }

    #[test]
    fn save_updates_body_and_modified_changes() {
        let db = open_memory_for_tests();
        let n = empty_note(&db, None);
        let original_modified = n.summary.modified.clone();
        // sleep one millisecond so the second timestamp differs
        std::thread::sleep(std::time::Duration::from_millis(5));
        db.with_conn_mut(|c| {
            update(
                c,
                UpdateNote {
                    id: n.summary.id.clone(),
                    title: None,
                    body: Some("# New body".into()),
                    parent_collection_id: None,
                    position: None,
                    tags: None,
                    yrs_state: None,
                    favourite: None,
                },
            )
        })
        .unwrap();
        let loaded = db.with_conn(|c| load(c, &n.summary.id)).unwrap();
        assert_eq!(loaded.body, "# New body");
        assert_ne!(loaded.summary.modified, original_modified);
    }

    #[test]
    fn move_note_into_collection_then_back_to_root() {
        let db = open_memory_for_tests();
        let coll = db
            .with_conn(|c| {
                create_collection(
                    c,
                    CreateCollection {
                        name: "Folder".into(),
                        parent_collection_id: None,
                    },
                )
            })
            .unwrap();
        let n = empty_note(&db, None);

        // Move into folder.
        db.with_conn_mut(|c| {
            update(
                c,
                UpdateNote {
                    id: n.summary.id.clone(),
                    title: None,
                    body: None,
                    position: None,
                    tags: None,
                    parent_collection_id: Some(Some(coll.id.clone())),
                    yrs_state: None,
                    favourite: None,
                },
            )
        })
        .unwrap();
        let l = db.with_conn(|c| load(c, &n.summary.id)).unwrap();
        assert_eq!(
            l.summary.parent_collection_id.as_deref(),
            Some(coll.id.as_str())
        );

        // Move back to root via Some(None).
        db.with_conn_mut(|c| {
            update(
                c,
                UpdateNote {
                    id: n.summary.id.clone(),
                    title: None,
                    body: None,
                    position: None,
                    tags: None,
                    parent_collection_id: Some(None),
                    yrs_state: None,
                    favourite: None,
                },
            )
        })
        .unwrap();
        let l = db.with_conn(|c| load(c, &n.summary.id)).unwrap();
        assert!(
            l.summary.parent_collection_id.is_none(),
            "move-to-root must clear parent"
        );
    }

    #[test]
    fn trash_excludes_from_default_listing() {
        let db = open_memory_for_tests();
        let n = empty_note(&db, None);
        db.with_conn(|c| trash(c, &n.summary.id)).unwrap();
        let listed = db.with_conn(|c| list(c, false)).unwrap();
        assert!(listed.iter().all(|x| x.id != n.summary.id));
        let listed_with = db.with_conn(|c| list(c, true)).unwrap();
        assert!(listed_with
            .iter()
            .any(|x| x.id == n.summary.id && x.trashed));
    }

    #[test]
    fn restore_then_purge() {
        let db = open_memory_for_tests();
        let n = empty_note(&db, None);
        db.with_conn(|c| trash(c, &n.summary.id)).unwrap();
        db.with_conn(|c| restore(c, &n.summary.id)).unwrap();
        let loaded = db.with_conn(|c| load(c, &n.summary.id)).unwrap();
        assert!(!loaded.summary.trashed);
        db.with_conn(|c| purge(c, &n.summary.id)).unwrap();
        let res = db.with_conn(|c| load(c, &n.summary.id));
        assert!(res.is_err(), "purged note must be gone");
    }

    #[test]
    fn save_with_tags_persists_them() {
        let db = open_memory_for_tests();
        let n = empty_note(&db, None);
        db.with_conn_mut(|c| {
            update(
                c,
                UpdateNote {
                    id: n.summary.id.clone(),
                    title: None,
                    body: None,
                    position: None,
                    parent_collection_id: None,
                    tags: Some(vec!["work".into(), "urgent".into()]),
                    yrs_state: None,
                    favourite: None,
                },
            )
        })
        .unwrap();
        let loaded = db.with_conn(|c| load(c, &n.summary.id)).unwrap();
        assert_eq!(
            loaded.summary.tags,
            vec!["urgent".to_string(), "work".to_string()]
        );
    }

    fn dirty_flag(db: &Db, id: &str) -> i64 {
        db.with_conn(|c| {
            Ok(
                c.query_row("SELECT dirty FROM notes WHERE id = ?1", params![id], |r| {
                    r.get::<_, i64>(0)
                })?,
            )
        })
        .unwrap()
    }

    #[test]
    fn create_marks_note_dirty_with_empty_yrs_state() {
        // Post-collab: notes::create no longer pre-seeds the yrs_state.
        // The live editor hydrates a fresh y-prosemirror Doc from `body`
        // on first open and writes back a v2 state through update().
        // Until then we just want dirty=1 so the periodic push picks it up.
        let db = open_memory_for_tests();
        let n = empty_note(&db, None);
        assert_eq!(dirty_flag(&db, &n.summary.id), 1);
        let state: Vec<u8> = db
            .with_conn(|c| {
                Ok(c.query_row(
                    "SELECT yrs_state FROM notes WHERE id = ?1",
                    params![n.summary.id],
                    |r| r.get::<_, Option<Vec<u8>>>(0),
                )?
                .unwrap_or_default())
            })
            .unwrap();
        assert!(state.is_empty(), "yrs_state stays empty until first edit");
    }

    #[test]
    fn collab_save_path_writes_state_and_bumps_schema() {
        // When the live editor supplies yrs_state, update() takes the
        // bytes verbatim (no markdown diff) and flips payload_schema to 2.
        let db = open_memory_for_tests();
        let n = empty_note(&db, None);
        let supplied = vec![0xCA, 0xFE, 0xBA, 0xBE];
        db.with_conn_mut(|c| {
            update(
                c,
                UpdateNote {
                    id: n.summary.id.clone(),
                    title: None,
                    body: Some("body via collab".into()),
                    parent_collection_id: None,
                    position: None,
                    tags: None,
                    yrs_state: Some(supplied.clone()),
                    favourite: None,
                },
            )
        })
        .unwrap();
        let (state, schema) = db
            .with_conn(|c| {
                Ok(c.query_row(
                    "SELECT yrs_state, payload_schema FROM notes WHERE id = ?1",
                    params![n.summary.id],
                    |r| Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, i64>(1)?)),
                )?)
            })
            .unwrap();
        assert_eq!(state, supplied);
        assert_eq!(schema, 2);
    }

    #[test]
    fn ink_save_path_merges_yrs_state_and_marks_dirty() {
        // Two concurrent edits forked from the same base. `save_yrs_state`
        // must merge them into the existing row rather than overwriting,
        // and re-mark the row dirty so sync picks up the merged result.
        let db = open_memory_for_tests();
        let n = db
            .with_conn(|c| {
                create(
                    c,
                    CreateNote {
                        title: Some("Ink".into()),
                        body: None,
                        parent_collection_id: None,
                        note_kind: Some("ink".into()),
                    },
                )
            })
            .unwrap();

        db.with_conn(|c| {
            Ok(c.execute(
                "UPDATE notes SET dirty = 0 WHERE id = ?1",
                params![n.summary.id],
            )?)
        })
        .unwrap();
        assert_eq!(dirty_flag(&db, &n.summary.id), 0);

        let base = crate::sync::yrs_doc::init_with_markdown("base");
        let edit_a = crate::sync::yrs_doc::apply_local_edit(&base, "base", "base A");
        let edit_b = crate::sync::yrs_doc::apply_local_edit(&base, "base", "base B");
        db.with_conn_mut(|c| save_yrs_state(c, &n.summary.id, &edit_a))
            .unwrap();
        db.with_conn_mut(|c| save_yrs_state(c, &n.summary.id, &edit_b))
            .unwrap();

        let merged: Vec<u8> = db
            .with_conn(|c| {
                Ok(c.query_row(
                    "SELECT yrs_state FROM notes WHERE id = ?1",
                    params![n.summary.id],
                    |r| r.get::<_, Vec<u8>>(0),
                )?)
            })
            .unwrap();
        let merged_text = crate::sync::yrs_doc::to_markdown(&merged);
        assert!(merged_text.contains('A'), "lost edit_a in merged state");
        assert!(merged_text.contains('B'), "lost edit_b in merged state");
        assert_eq!(dirty_flag(&db, &n.summary.id), 1);
    }

    #[test]
    fn save_yrs_state_accepts_empty_update_for_fresh_note() {
        let db = open_memory_for_tests();
        let n = db
            .with_conn(|c| {
                create(
                    c,
                    CreateNote {
                        title: Some("Ink".into()),
                        body: None,
                        parent_collection_id: None,
                        note_kind: Some("ink".into()),
                    },
                )
            })
            .unwrap();

        db.with_conn_mut(|c| save_yrs_state(c, &n.summary.id, &[]))
            .unwrap();

        assert!(db
            .with_conn(|c| load_yrs_state(c, &n.summary.id))
            .unwrap()
            .is_empty());
        assert_eq!(dirty_flag(&db, &n.summary.id), 1);
    }

    #[test]
    fn save_yrs_state_keeps_existing_state_when_incoming_bytes_are_empty() {
        let db = open_memory_for_tests();
        let n = db
            .with_conn(|c| {
                create(
                    c,
                    CreateNote {
                        title: Some("Ink".into()),
                        body: None,
                        parent_collection_id: None,
                        note_kind: Some("ink".into()),
                    },
                )
            })
            .unwrap();

        let base = crate::sync::yrs_doc::init_with_markdown("base");
        let edit = crate::sync::yrs_doc::apply_local_edit(&base, "base", "base A");
        db.with_conn_mut(|c| save_yrs_state(c, &n.summary.id, &edit))
            .unwrap();
        db.with_conn_mut(|c| save_yrs_state(c, &n.summary.id, &[]))
            .unwrap();

        let merged = db.with_conn(|c| load_yrs_state(c, &n.summary.id)).unwrap();
        let merged_text = crate::sync::yrs_doc::to_markdown(&merged);
        assert!(merged_text.contains('A'));
        assert_eq!(dirty_flag(&db, &n.summary.id), 1);
    }

    #[test]
    fn load_yrs_state_returns_empty_for_missing_note() {
        let db = open_memory_for_tests();
        let state = db.with_conn(|c| load_yrs_state(c, "missing-note")).unwrap();
        assert!(state.is_empty());
    }

    #[test]
    fn body_edit_re_marks_dirty_and_updates_yrs_state() {
        let db = open_memory_for_tests();
        let n = empty_note(&db, None);
        // Pretend we just synced this row: clear dirty + capture state.
        db.with_conn(|c| {
            Ok(c.execute(
                "UPDATE notes SET dirty = 0 WHERE id = ?1",
                params![n.summary.id],
            )?)
        })
        .unwrap();
        assert_eq!(dirty_flag(&db, &n.summary.id), 0);

        db.with_conn_mut(|c| {
            update(
                c,
                UpdateNote {
                    id: n.summary.id.clone(),
                    title: None,
                    body: Some("# Body, edited".into()),
                    parent_collection_id: None,
                    position: None,
                    tags: None,
                    yrs_state: None,
                    favourite: None,
                },
            )
        })
        .unwrap();
        assert_eq!(
            dirty_flag(&db, &n.summary.id),
            1,
            "edit must re-mark the note dirty"
        );
    }

    /// End-to-end regression: serialize an UpdateNote with parent_collection_id=null
    /// and confirm Rust accepts it as Some(None) (the "move to root" intent).
    #[test]
    fn serde_null_parent_means_move_to_root() {
        let json = r#"{"id":"x","parent_collection_id":null}"#;
        let parsed: UpdateNote = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.parent_collection_id, Some(None));
    }

    #[test]
    fn deleting_a_collection_cascades_to_its_notes() {
        // Regression: previously notes' parent_collection_id had ON DELETE
        // SET NULL, so deleting a folder silently relocated its notes to
        // the root. We now expect them to disappear with the folder.
        let db = open_memory_for_tests();
        let coll = db
            .with_conn(|c| {
                crate::collections::create(
                    c,
                    crate::collections::CreateCollection {
                        name: "Doomed".into(),
                        parent_collection_id: None,
                    },
                )
            })
            .unwrap();
        let n1 = empty_note(&db, Some(coll.id.clone()));
        let n2 = empty_note(&db, Some(coll.id.clone()));

        db.with_conn(|c| crate::collections::delete(c, &coll.id))
            .unwrap();

        let listed = db.with_conn(|c| list(c, true)).unwrap();
        assert!(
            listed.iter().all(|x| x.id != n1.summary.id),
            "n1 should have been cascaded"
        );
        assert!(
            listed.iter().all(|x| x.id != n2.summary.id),
            "n2 should have been cascaded"
        );
    }

    #[test]
    fn moving_a_collection_does_not_delete_its_notes() {
        // The 'trash a folder' UX path moves the folder by updating its
        // parent — children should ride along, not get cascade-deleted.
        let db = open_memory_for_tests();
        let coll = db
            .with_conn(|c| {
                crate::collections::create(
                    c,
                    crate::collections::CreateCollection {
                        name: "Will be trashed".into(),
                        parent_collection_id: None,
                    },
                )
            })
            .unwrap();
        let note = empty_note(&db, Some(coll.id.clone()));

        db.with_conn(|c| {
            crate::collections::update(
                c,
                crate::collections::UpdateCollection {
                    id: coll.id.clone(),
                    name: None,
                    parent_collection_id: Some(Some("trash".into())),
                    position: None,
                },
            )
        })
        .unwrap();

        let loaded = db.with_conn(|c| load(c, &note.summary.id)).unwrap();
        assert_eq!(
            loaded.summary.parent_collection_id.as_deref(),
            Some(coll.id.as_str()),
            "note should still belong to its (now trashed) folder"
        );
    }

    #[test]
    fn purging_note_with_synced_assets_queues_asset_tombstones() {
        // When a freeform note is purged, every asset row owned by that
        // note has been queued as a server-side delete BEFORE the
        // ON DELETE CASCADE wipes the asset rows. Without this, synced
        // assets would linger on the Etebase server forever after the
        // note that owned them is gone.
        let db = open_memory_for_tests();
        let note = empty_note(&db, None);

        // Two assets: one previously pushed (has etebase_uid), one local
        // only. Only the pushed one should produce a tombstone.
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO assets(id, owning_note_id, mime_type, bytes,
                                    size, created, modified, etebase_uid)
                 VALUES (?1, ?2, 'image/png', X'89504E47', 4,
                         '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z',
                         'eb-uid-synced')",
                params!["asset_synced", note.summary.id],
            )?;
            c.execute(
                "INSERT INTO assets(id, owning_note_id, mime_type, bytes,
                                    size, created, modified, etebase_uid)
                 VALUES (?1, ?2, 'image/png', X'89504E47', 4,
                         '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z',
                         NULL)",
                params!["asset_local_only", note.summary.id],
            )?;
            Ok(())
        })
        .unwrap();

        db.with_conn(|c| purge(c, &note.summary.id)).unwrap();

        let tombstones: Vec<String> = db
            .with_conn(|c| {
                let mut stmt = c.prepare(
                    "SELECT etebase_uid FROM tombstones WHERE kind = 'asset' ORDER BY etebase_uid",
                )?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
                Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .unwrap();
        assert_eq!(
            tombstones,
            vec!["eb-uid-synced".to_string()],
            "only the previously-pushed asset should produce a tombstone"
        );

        // And the cascade should have happened.
        let any_assets_left: i64 = db
            .with_conn(|c| Ok(c.query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(any_assets_left, 0, "FK cascade should wipe asset rows");
    }
}
