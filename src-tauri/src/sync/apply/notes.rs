//! Applying a pulled note item — the one genuinely conflict-free merge
//! in the sync loop.
//!
//! The body is a Yjs document, so remote and local state are merged
//! rather than chosen between. Everything around it (title, placement,
//! trash, favourite, tags) is last-write-wins, except while the local
//! row is dirty: then unpushed local edits win so a pull can't clobber
//! them before push gets a chance to send them.

use super::*;

/// Local note fields read before applying a pulled item: yrs_state + schema
/// drive the CRDT body merge, and the rest is the last-write-wins metadata we
/// must preserve when the row is locally dirty so a pull can't clobber an
/// unpushed trash / move / rename / favourite change.
pub(in crate::sync) struct LocalNoteState {
    pub(super) yrs_state: Vec<u8>,
    pub(super) dirty: i64,
    pub(super) schema: i64,
    pub(super) created: String,
    pub(super) modified: String,
    pub(super) parent_collection_id: Option<String>,
    pub(super) trashed_at: Option<String>,
    pub(super) title: String,
    pub(super) body: String,
    pub(super) position: i64,
    pub(super) favourite: i64,
    pub(super) note_kind: String,
    pub(super) tags_state: Vec<u8>,
}

/// Apply one pulled note item. Returns Some(note_id) when a row was
/// written (insert or update) so the caller can include it in the
/// `sync-completed` event payload — open editors merge the new
/// yrs_state into their live Y.Doc instead of going stale. Returns None
/// for deletes (no live editor to refresh) and missing-content items.
pub(in crate::sync) fn apply_note(
    db: &Db,
    item: &Item,
    scope: Option<&str>,
    preserve_dirty_local_edits: bool,
) -> AppResult<Option<String>> {
    if item.is_deleted() {
        db.with_conn(|c| apply_remote_delete(c, "notes", item.uid()))?;
        return Ok(None);
    }
    if item.is_missing_content() {
        return Ok(None);
    }
    let raw = item
        .content()
        .map_err(|e| AppError::InvalidArg(format!("note content: {e}")))?;
    let payload: NotePayload = rmp_serde::from_slice(&raw)
        .map_err(|e| AppError::InvalidArg(format!("note msgpack: {e}")))?;
    let etag = item.etag().to_string();
    apply_note_payload(
        db,
        &payload,
        item.uid(),
        &etag,
        scope,
        preserve_dirty_local_edits,
    )
}

/// Apply a decoded note payload to local SQLite. Split out from `apply_note`
/// so the local-vs-remote metadata logic can be unit-tested without
/// constructing an etebase `Item`.
pub(in crate::sync) fn apply_note_payload(
    db: &Db,
    payload: &NotePayload,
    uid: &str,
    etag: &str,
    scope: Option<&str>,
    preserve_dirty_local_edits: bool,
) -> AppResult<Option<String>> {
    db.with_conn_mut(|c| {
        let tx = c.transaction()?;

        // Existing local row, if any. We need yrs_state + schema to merge the
        // body, plus the LWW metadata to preserve when the row is dirty.
        let existing: Option<LocalNoteState> = tx
            .query_row(
                "SELECT yrs_state, dirty, payload_schema, created, modified,
                        parent_collection_id, trashed_at, title, body, position,
                        favourite, note_kind, tags_state
                 FROM notes WHERE id = ?1",
                params![payload.id],
                |r| {
                    Ok(LocalNoteState {
                        yrs_state: r.get::<_, Option<Vec<u8>>>(0)?.unwrap_or_default(),
                        dirty: r.get(1)?,
                        schema: r.get(2)?,
                        created: r.get(3)?,
                        modified: r.get(4)?,
                        parent_collection_id: r.get(5)?,
                        trashed_at: r.get(6)?,
                        title: r.get(7)?,
                        body: r.get(8)?,
                        position: r.get(9)?,
                        favourite: r.get(10)?,
                        note_kind: r.get(11)?,
                        tags_state: r.get::<_, Option<Vec<u8>>>(12)?.unwrap_or_default(),
                    })
                },
            )
            .optional()?;
        let local_tags = if existing.is_some() {
            load_tags_for_note(&tx, &payload.id)?
        } else {
            Vec::new()
        };

        let incoming_schema = payload.schema as i64;
        let remote_authoritative = !preserve_dirty_local_edits;
        let (merged_state, dirty_after) = match &existing {
            // View-only/read-only shares must discard any local state. Those
            // local edits should be impossible in the UI; if they appear, the
            // server copy is the only source we are allowed to keep.
            Some(_) if remote_authoritative => (payload.yrs_state.clone(), 0),
            // Same-schema CRDT merge: this is the common case once both
            // devices are on the same payload version.
            Some(local) if !local.yrs_state.is_empty() && local.schema == incoming_schema => {
                let merged = yrs_doc::merge_remote(&local.yrs_state, &payload.yrs_state);
                // If we had unpushed local edits, the merge contains both sides —
                // keep dirty=1 so the next push uploads the merged state and lets
                // the *server* converge with anyone else's offline edits.
                (merged, local.dirty)
            }
            // Either no local state, or the schema changed under us
            // (legacy v1 row got a v2 push from another device, or vice
            // versa). Take the remote bytes wholesale — yrs can't merge
            // across formats. Local body becomes whatever the new schema
            // dictates below.
            _ => (payload.yrs_state.clone(), 0),
        };

        // Metadata (parent / trashed_at / title / position / favourite /
        // note_kind) is last-write-wins, not a CRDT. When the local row has
        // unpushed changes (dirty), a pull must NOT overwrite that metadata
        // with the remote's older copy — otherwise a note trashed (or moved /
        // renamed) locally but not yet pushed silently reverts on the next
        // pull, e.g. the full re-pull triggered by a bad_stoken reset. Keep
        // the local metadata and force dirty=1 so the next push reconciles the
        // server. The body above is still CRDT-merged regardless.
        let keep_local_meta =
            preserve_dirty_local_edits && existing.as_ref().is_some_and(|l| l.dirty != 0);
        // For v2 payloads the remote ships the rendered markdown alongside
        // the prosemirror state — Rust can't render markdown from XmlFragment.
        // If this row has unpushed local edits, keep the local rendered body
        // through the pull-before-push cycle; otherwise the next push would
        // upload the stale remote body even though the merged Yjs state still
        // contains the local edit. For v1 we still have the Rust-side Y.Text →
        // markdown helper.
        let body = if payload.schema >= 2 {
            if keep_local_meta {
                existing
                    .as_ref()
                    .map(|local| local.body.clone())
                    .unwrap_or_else(|| payload.body.clone())
            } else {
                payload.body.clone()
            }
        } else {
            yrs_doc::to_markdown(&merged_state)
        };
        // payload.crypto_key is intentionally ignored on pull — the
        // crypto_key column no longer exists locally. The editor fetches
        // the current key directly from the etebase Item each time it
        // opens a note (see note_room_info), so the server stays the
        // sole authority and nothing sensitive lands on disk.
        let now = Utc::now().to_rfc3339();
        let final_created = if keep_local_meta {
            existing
                .as_ref()
                .map(|l| l.created.clone())
                .unwrap_or_else(|| {
                    payload
                        .created
                        .clone()
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| now.clone())
                })
        } else {
            payload
                .created
                .clone()
                .filter(|value| !value.is_empty())
                .or_else(|| existing.as_ref().map(|l| l.created.clone()))
                .unwrap_or_else(|| now.clone())
        };
        let final_modified = if keep_local_meta {
            existing
                .as_ref()
                .map(|l| l.modified.clone())
                .unwrap_or_else(|| {
                    payload
                        .modified
                        .clone()
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| now.clone())
                })
        } else {
            payload
                .modified
                .clone()
                .filter(|value| !value.is_empty())
                .or_else(|| existing.as_ref().map(|l| l.modified.clone()))
                .unwrap_or_else(|| now.clone())
        };

        // Pick each metadata field from local (when dirty) or remote. For the
        // remote parent, resolve_parent_id does the defensive nullification of
        // a dangling reference (see its doc) so one bad parent can't abort the
        // pull with a FOREIGN KEY violation; a kept-local parent is already a
        // valid local id, so it needs no resolving.
        let final_parent = if keep_local_meta {
            existing
                .as_ref()
                .and_then(|l| l.parent_collection_id.clone())
        } else {
            resolve_parent_id(&tx, payload.parent_folder_id.as_deref())?
        };
        let final_title = if keep_local_meta {
            existing
                .as_ref()
                .map(|l| l.title.clone())
                .unwrap_or_default()
        } else {
            payload.title.clone()
        };
        let final_position = if keep_local_meta {
            existing.as_ref().map_or(0, |l| l.position)
        } else {
            payload.position
        };
        let final_trashed_at = if keep_local_meta {
            existing.as_ref().and_then(|l| l.trashed_at.clone())
        } else {
            payload.trashed_at.clone()
        };
        let final_favourite = if keep_local_meta {
            existing.as_ref().map_or(0, |l| l.favourite)
        } else {
            payload.favourite as i64
        };
        let final_note_kind = if keep_local_meta {
            existing
                .as_ref()
                .map(|l| l.note_kind.clone())
                .unwrap_or_default()
        } else {
            payload.note_kind.clone()
        };
        let (final_tags_state, final_tags) = if remote_authoritative {
            tags_crdt::merge_or_resolve(&[], &[], &payload.tags_state, &payload.tags, false)
        } else {
            match &existing {
            Some(local) => tags_crdt::merge_or_resolve(
                &local.tags_state,
                &local_tags,
                &payload.tags_state,
                &payload.tags,
                keep_local_meta,
            ),
            None => {
                tags_crdt::merge_or_resolve(&[], &[], &payload.tags_state, &payload.tags, false)
            }
            }
        };
        // Keep dirty=1 when we preserved local metadata so the next push sends
        // it to the server; otherwise follow the body-merge's dirty decision.
        let tags_need_push = payload.tags_state.is_empty() || final_tags != payload.tags;
        let final_dirty = if keep_local_meta || (preserve_dirty_local_edits && tags_need_push) {
            1
        } else {
            dirty_after
        };

        let exists = existing.is_some();
        if exists {
            tx.execute(
                "UPDATE notes
                 SET parent_collection_id = ?1, title = ?2, body = ?3, position = ?4,
                     created = ?5, modified = ?6, trashed_at = ?7, yrs_state = ?8,
                     etebase_uid = ?9, etebase_etag = ?10, dirty = ?11,
                     payload_schema = ?12, favourite = ?13, note_kind = ?14,
                     tags_state = ?15, share_scope_id = ?16
                 WHERE id = ?17",
                params![
                    final_parent,
                    final_title,
                    body,
                    final_position,
                    final_created,
                    final_modified,
                    final_trashed_at,
                    merged_state,
                    uid,
                    etag,
                    final_dirty,
                    incoming_schema,
                    final_favourite,
                    final_note_kind,
                    final_tags_state,
                    scope,
                    payload.id,
                ],
            )?;
        } else {
            tx.execute(
                "INSERT INTO notes (id, parent_collection_id, title, body, position,
                                    created, modified, trashed_at, yrs_state,
                                    etebase_uid, etebase_etag, dirty,
                                    payload_schema, favourite, note_kind, tags_state,
                                    share_scope_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
                params![
                    payload.id,
                    final_parent,
                    final_title,
                    body,
                    final_position,
                    final_created,
                    final_modified,
                    final_trashed_at,
                    merged_state,
                    uid,
                    etag,
                    final_dirty,
                    incoming_schema,
                    final_favourite,
                    final_note_kind,
                    final_tags_state,
                    scope,
                ],
            )?;
        }

        // Refresh the query-friendly projection from the CRDT-visible tags.
        tx.execute(
            "DELETE FROM note_tags WHERE note_id = ?1",
            params![payload.id],
        )?;
        let mut stmt = tx.prepare("INSERT INTO note_tags(note_id, tag) VALUES (?1, ?2)")?;
        for tag in &final_tags {
            stmt.execute(params![payload.id, tag])?;
        }
        drop(stmt);

        tx.commit()?;
        Ok(Some(payload.id.clone()))
    })
}
