//! Notes — CRUD + Tauri commands.
//!
//! Two views of a note:
//!   - `NoteSummary`: id, title, parent, modified, position. Cheap to list
//!     and render in the file tree / metadata panel.
//!   - `Note`: NoteSummary + body. Loaded on demand when an editor opens.
//!
//! Soft-delete via `trashed_at`; listing skips trashed unless asked.

use crate::db::Db;
use crate::error::{AppError, AppResult, CommandResult};
use crate::sync::{tags_crdt, yrs_doc};
use chrono::Utc;
pub use mindstream_storage_core::notes::{
    default_note_kind, default_note_kind_string, is_valid_plugin_note_kind, CreateNote, Note,
    NoteKind, NoteSummary, UpdateNote,
};
use rusqlite::{params, Connection, OptionalExtension};
#[cfg(test)]
use std::str::FromStr;

pub fn list(conn: &Connection, include_trashed: bool) -> AppResult<Vec<NoteSummary>> {
    mindstream_storage_core::notes::list(conn, include_trashed).map_err(Into::into)
}

fn load_tags(conn: &Connection, id: &str) -> AppResult<Vec<String>> {
    mindstream_storage_core::notes::load_tags(conn, id).map_err(Into::into)
}

pub fn load_yrs_state(conn: &Connection, id: &str) -> AppResult<Vec<u8>> {
    mindstream_storage_core::notes::load_yrs_state(conn, id).map_err(Into::into)
}

pub fn load(conn: &Connection, id: &str) -> AppResult<Note> {
    mindstream_storage_core::notes::load(conn, id).map_err(Into::into)
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
    crate::sharing::ensure_note_writable(conn, id)?;
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
    let (_, normalized) = crate::assets::normalize_asset_ids_for_note(&tx, id, "", Some(bytes))?;
    let bytes = normalized.as_deref().unwrap_or(bytes);
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
    crate::assets::register_body_refs(&tx, id, "")?;
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
pub fn create(conn: &Connection, input: CreateNote) -> AppResult<Note> {
    crate::sharing::ensure_parent_writable(conn, input.parent_collection_id.as_deref())?;
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
    // Inherit the parent folder's share scope so a note created inside a shared
    // folder is routed into that scope's collection (and pulled by recipients)
    // rather than the vault. Root / vault parent → NULL, i.e. vault-local.
    let share_scope_id = match input.parent_collection_id.as_deref() {
        Some(parent) => crate::sharing::collection_scope(conn, parent)?,
        None => None,
    };
    conn.execute(
        "INSERT INTO notes(id, parent_collection_id, title, body, position,
                            created, modified, dirty, note_kind, trashed_at, share_scope_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 1, ?7, ?8, ?9)",
        params![
            id,
            input.parent_collection_id,
            title,
            body,
            position,
            now,
            note_kind,
            trashed_at,
            share_scope_id,
        ],
    )?;
    load(conn, &id)
}

pub fn update(conn: &mut Connection, input: UpdateNote) -> AppResult<Note> {
    crate::sharing::ensure_note_writable(conn, &input.id)?;
    if let Some(parent) = &input.parent_collection_id {
        crate::sharing::ensure_parent_writable(conn, parent.as_deref())?;
    }
    let now = Utc::now().to_rfc3339();
    let tx = conn.transaction()?;

    if let Some(title) = &input.title {
        tx.execute(
            "UPDATE notes SET title = ?1, modified = ?2 WHERE id = ?3",
            params![title, now, input.id],
        )?;
    }
    if let Some(new_body) = &input.body {
        let (new_body, supplied_state) = crate::assets::normalize_asset_ids_for_note(
            &tx,
            &input.id,
            new_body,
            input.yrs_state.as_deref(),
        )?;
        // Two paths converge here:
        //   * The live-collab editor supplies its own yrs_state — it
        //     already owns the Doc, has applied the user's keystrokes
        //     through y-prosemirror, and computed the new state directly.
        //     We trust those bytes and stamp payload_schema=2.
        //   * Legacy callers (browser fallback, programmatic edits) just
        //     send the new markdown body. We diff old → new at byte
        //     granularity and replay against the v1 Y.Text Doc for CRDT
        //     correctness on offline-edit reconciliation.
        if let Some(supplied_state) = &supplied_state {
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
            let new_state = yrs_doc::apply_local_edit(&base_state, &old_body, &new_body);
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
        // Claim every asset the new body mentions. Additive only — an image
        // the user just deleted keeps its (now stale) row until the
        // reconciliation sweep, because the authoritative check also has to
        // read the note's history snapshots and that is far too expensive to
        // do on a save. See assets::register_body_refs.
        crate::assets::register_body_refs(&tx, &input.id, &new_body)?;
    } else if let Some(supplied_state) = &input.yrs_state {
        // Editor supplies a fresh yrs_state but no body — used by
        // note kinds whose document content lives entirely in the
        // CRDT and has no body equivalent (ink notes from C2 of the
        // native-egui-layer roadmap; future shape-only kinds). We
        // trust the supplied bytes verbatim; nothing about the
        // payload_schema discriminator (markdown v1 / v2) applies
        // here so we leave it alone.
        let body: String = tx.query_row(
            "SELECT body FROM notes WHERE id = ?1",
            params![input.id],
            |r| r.get(0),
        )?;
        let (_, normalized_state) = crate::assets::normalize_asset_ids_for_note(
            &tx,
            &input.id,
            &body,
            Some(supplied_state),
        )?;
        tx.execute(
            "UPDATE notes
             SET yrs_state = ?1, modified = ?2
             WHERE id = ?3",
            params![normalized_state, now, input.id],
        )?;
    }
    crate::assets::register_body_refs(&tx, &input.id, "")?;
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
            crate::collections::TrashTable::Notes,
            &input.id,
            parent.as_deref(),
            &now,
        )?;
        // Re-home the note (and its assets) if the move crossed a share-scope
        // boundary — same reasoning as the collection move path. A note is
        // never a share anchor, so no anchor guard is needed here.
        let new_scope = match parent.as_deref() {
            Some(parent_id) => crate::sharing::collection_scope(&tx, parent_id)?,
            None => None,
        };
        let old_scope = crate::sharing::note_scope(&tx, &input.id)?;
        if new_scope != old_scope {
            crate::sharing::rehome_note_subtree(&tx, &input.id, new_scope.as_deref())?;
        }
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
    crate::sharing::ensure_note_writable(conn, id)?;
    let now = Utc::now().to_rfc3339();
    let n = conn.execute(
        "UPDATE notes SET parent_collection_id = 'trash', trashed_at = ?1, modified = ?1, dirty = 1 WHERE id = ?2",
        params![now, id],
    )?;
    if n == 0 {
        return Err(AppError::NotFound(format!("note {id}")));
    }
    Ok(())
}

pub fn restore(conn: &Connection, id: &str) -> AppResult<()> {
    crate::sharing::ensure_note_writable(conn, id)?;
    let now = Utc::now().to_rfc3339();
    let n = conn.execute(
        "UPDATE notes SET parent_collection_id = NULL, trashed_at = NULL, modified = ?1, dirty = 1 WHERE id = ?2",
        params![now, id],
    )?;
    if n == 0 {
        return Err(AppError::NotFound(format!("note {id}")));
    }
    Ok(())
}

pub fn purge(conn: &Connection, id: &str) -> AppResult<()> {
    crate::sharing::ensure_note_writable(conn, id)?;
    if conn.is_autocommit() {
        let tx = conn.unchecked_transaction()?;
        purge(&tx, id)?;
        tx.commit()?;
        return Ok(());
    }
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

    // Release this note's claim on its assets BEFORE the DELETE, while both
    // the reference rows and the assets' etebase_uids are still readable.
    //
    // Assets no longer cascade off the owning note (see the assets module
    // docs): an image pasted into two notes has to survive the first one
    // being purged. `release_note_assets` deletes only what nothing else
    // references, tombstones those, and re-anchors the survivors.
    crate::assets::release_note_assets(conn, id)?;

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
) -> CommandResult<Vec<NoteSummary>> {
    db.with_conn(|c| list(c, include_trashed.unwrap_or(false)))
        .map_err(Into::into)
}

#[tauri::command]
pub fn load_note(db: tauri::State<'_, Db>, id: String) -> CommandResult<Note> {
    db.with_conn(|c| load(c, &id)).map_err(Into::into)
}

#[tauri::command]
pub fn create_note(db: tauri::State<'_, Db>, input: CreateNote) -> CommandResult<Note> {
    db.with_conn(|c| create(c, input)).map_err(Into::into)
}

#[tauri::command]
pub fn save_note(db: tauri::State<'_, Db>, input: UpdateNote) -> CommandResult<Note> {
    db.with_conn_mut(|c| update(c, input)).map_err(Into::into)
}

#[tauri::command]
pub fn trash_note(db: tauri::State<'_, Db>, id: String) -> CommandResult<()> {
    db.with_conn(|c| trash(c, &id)).map_err(Into::into)
}

#[tauri::command]
pub fn restore_note(db: tauri::State<'_, Db>, id: String) -> CommandResult<()> {
    db.with_conn(|c| restore(c, &id)).map_err(Into::into)
}

#[tauri::command]
pub fn purge_note(db: tauri::State<'_, Db>, id: String) -> CommandResult<()> {
    db.with_conn(|c| purge(c, &id)).map_err(Into::into)
}

#[cfg(test)]
mod tests;
