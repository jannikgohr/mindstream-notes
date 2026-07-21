//! Applying a pulled signature item. Signatures are user-global, so
//! there is no FK to orphan against — every item either writes a row or
//! is a delete.

use super::*;

/// Apply one pulled signature item to local SQLite. Returns `true` when a
/// row was inserted/updated (so the caller can bump the pulled counter),
/// `false` for deletes and missing-content items. No FK gate — signatures
/// are user-global, so there's nothing to orphan against.
pub(in crate::sync) fn apply_signature(db: &Db, item: &Item) -> AppResult<bool> {
    if item.is_deleted() {
        db.with_conn(|c| {
            c.execute(
                "DELETE FROM signatures WHERE etebase_uid = ?1",
                params![item.uid()],
            )?;
            Ok(())
        })?;
        return Ok(false);
    }
    if item.is_missing_content() {
        return Ok(false);
    }
    let raw = item
        .content()
        .map_err(|e| AppError::InvalidArg(format!("signature content: {e}")))?;
    let payload: SignaturePayload = rmp_serde::from_slice(&raw)
        .map_err(|e| AppError::InvalidArg(format!("signature msgpack: {e}")))?;
    let etag = item.etag().to_string();
    let uid = item.uid().to_string();

    db.with_conn_mut(|c| {
        let tx = c.transaction()?;
        let exists = tx
            .query_row(
                "SELECT 1 FROM signatures WHERE id = ?1",
                params![payload.id],
                |_| Ok(true),
            )
            .optional()?
            .is_some();
        if exists {
            // Geometry blob, not a CRDT — last-write-wins on the remote copy.
            tx.execute(
                "UPDATE signatures
                 SET data = ?1, modified = ?2, etebase_uid = ?3,
                     etebase_etag = ?4, dirty = 0
                 WHERE id = ?5",
                params![payload.data, payload.modified, uid, etag, payload.id],
            )?;
        } else {
            tx.execute(
                "INSERT INTO signatures(id, data, created, modified,
                                        etebase_uid, etebase_etag, dirty)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
                params![
                    payload.id,
                    payload.data,
                    payload.created,
                    payload.modified,
                    uid,
                    etag,
                ],
            )?;
        }
        tx.commit()?;
        Ok(true)
    })
}
