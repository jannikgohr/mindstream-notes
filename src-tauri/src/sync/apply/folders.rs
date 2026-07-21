//! Applying a pulled folder item, plus the parent re-linking pass.
//!
//! Folder placement is last-write-wins on `modified`, with the local row
//! winning while it is dirty. Parents that haven't been pulled yet are
//! left NULL and stitched back up by [`repair_folder_parents`] once the
//! whole batch has landed.

use super::*;

/// Apply one pulled folder item to the local DB.
///
/// Returns `Some(payload)` if we wrote a row (so `pull_folders` can
/// queue it for the repair pass), `None` for deletes and missing-
/// content items where there's nothing to re-link.
pub(in crate::sync) fn apply_folder(
    db: &Db,
    item: &Item,
    scope: Option<&str>,
    preserve_dirty_local_edits: bool,
) -> AppResult<Option<FolderPayload>> {
    if item.is_deleted() {
        // Server-side delete: drop our row if we have one matched by uid,
        // unless it has unpushed edits — see `apply_remote_delete`.
        db.with_conn(|c| apply_remote_delete(c, "collections", item.uid()))?;
        return Ok(None);
    }
    if item.is_missing_content() {
        return Ok(None);
    }
    let raw = item
        .content()
        .map_err(|e| AppError::InvalidArg(format!("folder content: {e}")))?;
    let payload: FolderPayload = rmp_serde::from_slice(&raw)
        .map_err(|e| AppError::InvalidArg(format!("folder msgpack: {e}")))?;
    let etag = item.etag().to_string();
    apply_folder_payload(
        db,
        payload,
        item.uid(),
        &etag,
        scope,
        preserve_dirty_local_edits,
    )
}

/// Apply a decoded folder payload to local SQLite. Split out from
/// `apply_folder` so the local-vs-remote metadata logic can be unit-tested
/// without constructing an etebase `Item`.
pub(in crate::sync) fn apply_folder_payload(
    db: &Db,
    payload: FolderPayload,
    uid: &str,
    etag: &str,
    scope: Option<&str>,
    preserve_dirty_local_edits: bool,
) -> AppResult<Option<FolderPayload>> {
    let now = Utc::now().to_rfc3339();

    // Folder metadata (parent / name / position) is last-write-wins, not a
    // CRDT. When the local row has unpushed edits (dirty), a pull must NOT
    // overwrite that metadata with the remote's older copy — otherwise an
    // offline rename / move / reorder silently reverts. Mirrors the note
    // metadata-preservation path in `apply_note_payload`.
    let existing: Option<(i64, String, String)> = db.with_conn(|c| {
        Ok(c.query_row(
            "SELECT dirty, created, modified FROM collections WHERE id = ?1",
            params![payload.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?)
    })?;
    let keep_local_meta =
        preserve_dirty_local_edits && matches!(existing, Some((dirty, _, _)) if dirty != 0);
    let remote_created = payload
        .created
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or(&now);
    let remote_modified = payload
        .modified
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            existing
                .as_ref()
                .map(|(_, _, modified)| modified.as_str())
                .unwrap_or(&now)
        });

    db.with_conn(|c| {
        // Defensive: if the payload's parent folder isn't in collections
        // yet (subfolder arrived before its parent in this pull, or the
        // server orphaned it), store NULL for now. `repair_folder_parents`
        // re-links us once the parent lands later in the same pull.
        // Without this, the INSERT would hit a FOREIGN KEY violation and
        // abort the entire sync.
        let resolved_parent = resolve_parent_id(c, payload.parent_folder_id.as_deref())?;
        match existing {
            Some(_) if keep_local_meta => {
                // Keep the local metadata; only (re)stamp the server identity
                // and scope, forcing dirty=1 so the next push reconciles. This
                // is what makes an offline rename survive a re-home: the row is
                // reclaimed into its scope without losing the local name.
                c.execute(
                    "UPDATE collections
                     SET etebase_uid = ?1, etebase_etag = ?2, dirty = 1, share_scope_id = ?3
                     WHERE id = ?4",
                    params![uid, etag, scope, payload.id],
                )?;
            }
            Some(_) => {
                c.execute(
                    "UPDATE collections
                     SET parent_collection_id = ?1, name = ?2, position = ?3,
                         created = ?4, modified = ?5, etebase_uid = ?6,
                         etebase_etag = ?7, dirty = 0, share_scope_id = ?8
                     WHERE id = ?9",
                    params![
                        resolved_parent,
                        payload.name,
                        payload.position,
                        remote_created,
                        remote_modified,
                        uid,
                        etag,
                        scope,
                        payload.id,
                    ],
                )?;
            }
            None => {
                c.execute(
                    "INSERT INTO collections (id, parent_collection_id, name, position,
                                               created, modified, etebase_uid, etebase_etag, dirty,
                                               share_scope_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9)",
                    params![
                        payload.id,
                        resolved_parent,
                        payload.name,
                        payload.position,
                        remote_created,
                        remote_modified,
                        uid,
                        etag,
                        scope,
                    ],
                )?;
            }
        }
        Ok(())
    })?;

    // When we preserved local metadata, the local parent is authoritative —
    // return None so `repair_folder_parents` won't reattach it from the remote
    // payload (a folder moved to root offline must stay at root).
    if keep_local_meta {
        Ok(None)
    } else {
        Ok(Some(payload))
    }
}

/// Returns the parent id unchanged if a collection with that id exists
/// locally, or `None` if it's missing — used by `apply_folder`/`apply_note`
/// during pull so a dangling `parent_folder_id` on the server doesn't
/// abort the sync with `FOREIGN KEY constraint failed`. The original
/// payload value is preserved by `pull_folders` so the repair pass can
/// reattach folders once the parent arrives.
pub(in crate::sync) fn resolve_parent_id(
    conn: &Connection,
    parent: Option<&str>,
) -> rusqlite::Result<Option<String>> {
    let Some(p) = parent else {
        return Ok(None);
    };
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM collections WHERE id = ?1",
            params![p],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if exists {
        Ok(Some(p.to_string()))
    } else {
        log::warn!("[sync] parent collection {p} not present locally; orphaning to root");
        Ok(None)
    }
}

/// After all folders in this pull have been applied, walk the buffered
/// payloads and reattach any row we had to nullify because its parent
/// wasn't yet known. We only touch rows whose parent is currently NULL
/// to avoid clobbering a user-initiated move that ran concurrently —
/// since folder upserts in this pull set parent to NULL only when the
/// parent was missing at apply time, NULL here unambiguously means
/// "we orphaned this one".
pub(in crate::sync) fn repair_folder_parents(db: &Db, applied: &[FolderPayload]) -> AppResult<()> {
    if applied.is_empty() {
        return Ok(());
    }
    db.with_conn_mut(|c| {
        let tx = c.transaction()?;
        for p in applied {
            let Some(parent) = &p.parent_folder_id else {
                continue;
            };
            tx.execute(
                "UPDATE collections SET parent_collection_id = ?1
                 WHERE id = ?2
                   AND parent_collection_id IS NULL
                   AND EXISTS (SELECT 1 FROM collections WHERE id = ?1)",
                params![parent, p.id],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
}
