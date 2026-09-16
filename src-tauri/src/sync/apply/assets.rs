//! Applying a pulled drawing-asset item.
//!
//! An asset row carries an FK to its owning note, so an asset that
//! arrives before its note is reported as orphaned rather than dropped —
//! the caller then leaves the stoken where it is and retries next sync.

use super::*;

pub(in crate::sync) enum ApplyAssetOutcome {
    /// Row was written (insert or update). Carries the asset id so the
    /// caller can emit a `sync-completed` event listing what changed —
    /// open editors evict their cached blob URL and re-resolve so
    /// freshly-arrived bytes paint on the open canvas / image instead
    /// of staying broken until the user reopens the note.
    Applied(String),
    /// Asset references a note we don't have yet — keep the stoken at
    /// its previous value so the next sync retries.
    Orphaned,
    /// Delete tombstone or missing-content item — nothing to do, but no
    /// reason to pin the stoken.
    Skipped,
}

pub(in crate::sync) fn item_type(item: &Item) -> Option<String> {
    item.meta()
        .ok()
        .and_then(|meta| meta.item_type().map(str::to_string))
}

/// Apply one pulled asset item to local SQLite. Returns the outcome so
/// the caller can decide whether to advance the stoken (orphans pin it).
pub(in crate::sync) fn apply_asset(
    db: &Db,
    item: &Item,
    scope: Option<&str>,
) -> AppResult<ApplyAssetOutcome> {
    if item_type(item)
        .as_deref()
        .is_some_and(|kind| kind != ITEM_TYPE_ASSET)
    {
        return Ok(ApplyAssetOutcome::Skipped);
    }
    if item.is_deleted() {
        db.with_conn(|c| apply_remote_delete(c, "assets", item.uid()))?;
        return Ok(ApplyAssetOutcome::Skipped);
    }
    if item.is_missing_content() {
        return Ok(ApplyAssetOutcome::Skipped);
    }
    let raw = item
        .content()
        .map_err(|e| AppError::InvalidArg(format!("asset content: {e}")))?;
    let payload: AssetPayload = rmp_serde::from_slice(&raw)
        .map_err(|e| AppError::InvalidArg(format!("asset msgpack: {e}")))?;
    let etag = item.etag().to_string();
    let uid = item.uid().to_string();

    apply_asset_payload(db, &payload, &uid, &etag, scope)
}

/// Apply a decoded asset payload to local SQLite. Split out from `apply_asset`
/// so reference reconciliation can be tested without constructing an Etebase
/// item.
pub(in crate::sync) fn apply_asset_payload(
    db: &Db,
    payload: &AssetPayload,
    uid: &str,
    etag: &str,
    scope: Option<&str>,
) -> AppResult<ApplyAssetOutcome> {
    let content_hash = crate::assets::content_hash(&payload.bytes);

    db.with_conn_mut(|c| {
        let tx = c.transaction()?;

        // FK gate: skip orphan assets rather than aborting the whole
        // pull. The orphan flag in pull_assets keeps the stoken pinned
        // so we retry on the next sync after the missing note arrives.
        let note_exists: bool = tx
            .query_row(
                "SELECT 1 FROM notes WHERE id = ?1",
                params![payload.owning_note_id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !note_exists {
            log::debug!(
                "[sync] asset {} references missing note {}; deferring",
                payload.id,
                payload.owning_note_id
            );
            tx.commit()?;
            return Ok(ApplyAssetOutcome::Orphaned);
        }

        let exists = tx
            .query_row(
                "SELECT 1 FROM assets WHERE id = ?1",
                params![payload.id],
                |_| Ok(true),
            )
            .optional()?
            .is_some();

        if exists {
            // Asset rows are big blobs, not CRDTs — no merge to do.
            // Last-write-wins: take the remote bytes verbatim and
            // clear dirty so we don't immediately re-push.
            tx.execute(
                "UPDATE assets
                 SET owning_note_id = ?1, mime_type = ?2, bytes = ?3,
                     size = ?4, modified = ?5, etebase_uid = ?6,
                     etebase_etag = ?7, dirty = 0, share_scope_id = ?8,
                     content_hash = ?9
                 WHERE id = ?10",
                params![
                    payload.owning_note_id,
                    payload.mime_type,
                    payload.bytes,
                    payload.size,
                    payload.modified,
                    uid,
                    etag,
                    scope,
                    content_hash,
                    payload.id,
                ],
            )?;
        } else {
            tx.execute(
                "INSERT INTO assets(id, owning_note_id, mime_type, bytes,
                                    size, created, modified, etebase_uid,
                                    etebase_etag, dirty, share_scope_id,
                                    content_hash)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11)",
                params![
                    payload.id,
                    payload.owning_note_id,
                    payload.mime_type,
                    payload.bytes,
                    payload.size,
                    payload.created,
                    payload.modified,
                    uid,
                    etag,
                    scope,
                    content_hash,
                ],
            )?;
        }
        // Asset lifetime is driven by asset_refs, so a freshly pulled blob
        // needs a row or the next sweep would treat it as unreferenced and
        // delete what we just downloaded. The payload's owning note is
        // confirmed to exist by the FK gate above.
        crate::assets::add_ref(&tx, &payload.id, &payload.owning_note_id)?;

        // Notes and assets live in separate remote collections. Notes are
        // normally pulled first, so every already-present body that names this
        // asset must gain its reference now. The LIKE probe avoids parsing
        // every note for every blob; register_body_refs performs the exact
        // markdown/PDF parse and harmlessly rejects false candidates.
        let candidate_notes = {
            let pattern = format!("%{}%", payload.id);
            let mut stmt = tx.prepare(
                "SELECT id, body FROM notes
                 WHERE body LIKE ?1 AND share_scope_id IS ?2",
            )?;
            let rows = stmt.query_map(params![pattern, scope], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (note_id, body) in candidate_notes {
            crate::assets::register_body_refs(&tx, &note_id, &body)?;
        }
        tx.commit()?;
        Ok(ApplyAssetOutcome::Applied(payload.id.clone()))
    })
}
