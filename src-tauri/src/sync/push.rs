//! Push half of the sync loop: send dirty local rows to Etebase.
//!
//! Every `push_*` builds items from the rows `local_rows` hands it and
//! commits them through [`transact_or_resolve`], which retries a
//! conflicting transaction after re-merging the server's copy.

use super::*;

// ---------- Push ----------

pub(super) fn push_folders(
    db: &Db,
    im: &ItemManager,
    report: &mut SyncReport,
    scope: Option<&str>,
) -> AppResult<()> {
    let dirty = load_dirty_folders(db, scope)?;
    if dirty.is_empty() {
        return drain_tombstones(db, im, "folder", scope);
    }

    // Build (Item, payload, local_id) tuples for each dirty row.
    let mut prepared: Vec<(Item, String)> = Vec::with_capacity(dirty.len());
    for row in &dirty {
        let payload = FolderPayload {
            schema: PAYLOAD_SCHEMA,
            id: row.id.clone(),
            parent_folder_id: row.parent_collection_id.clone(),
            name: row.name.clone(),
            position: row.position,
            created: Some(row.created.clone()),
            modified: Some(row.modified.clone()),
        };
        let bytes = rmp_serde::to_vec_named(&payload)
            .map_err(|e| AppError::InvalidArg(format!("encode folder: {e}")))?;
        let mut meta = ItemMetadata::new();
        meta.set_item_type(Some(ITEM_TYPE_FOLDER))
            .set_name(Some(row.name.clone()))
            .set_mtime(Some(now_unix_ms()));
        let item = if let Some(uid) = &row.etebase_uid {
            let mut existing = im
                .fetch(uid, None)
                .map_err(|e| AppError::InvalidArg(format!("fetch folder {uid}: {e}")))?;
            existing
                .set_meta(&meta)
                .map_err(|e| AppError::InvalidArg(format!("set_meta folder: {e}")))?;
            existing
                .set_content(&bytes)
                .map_err(|e| AppError::InvalidArg(format!("set_content folder: {e}")))?;
            existing
        } else {
            im.create(&meta, &bytes)
                .map_err(|e| AppError::InvalidArg(format!("create folder item: {e}")))?
        };
        prepared.push((item, row.id.clone()));
    }

    let local_ids: Vec<String> = prepared.iter().map(|(_, id)| id.clone()).collect();
    let mut items: Vec<Item> = prepared.into_iter().map(|(i, _)| i).collect();
    transact_or_resolve(im, &mut items, &mut report.conflicts_resolved)
        .map_err(|e| AppError::InvalidArg(format!("transaction folders: {e}")))?;

    let pushed = items.len();
    // Persist new uids/etags + clear dirty flag.
    db.with_conn_mut(|c| {
        let tx = c.transaction()?;
        for (item, local_id) in items.iter().zip(local_ids.iter()) {
            tx.execute(
                "UPDATE collections
                 SET etebase_uid = ?1, etebase_etag = ?2, dirty = 0
                 WHERE id = ?3",
                params![item.uid(), item.etag(), local_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    })?;
    report.folders_pushed += pushed;

    drain_tombstones(db, im, "folder", scope)
}

pub(super) fn push_notes(
    db: &Db,
    im: &ItemManager,
    report: &mut SyncReport,
    scope: Option<&str>,
) -> AppResult<()> {
    let dirty = load_dirty_notes(db, scope)?;
    if dirty.is_empty() {
        return drain_tombstones(db, im, "note", scope);
    }

    let mut prepared: Vec<(Item, String)> = Vec::with_capacity(dirty.len());
    for row in &dirty {
        // For existing items we fetch first so we can extract the live
        // crypto_key off the server-side payload and re-use it in the
        // new one. Rotating the key on every push would break peers'
        // in-progress live sessions. We'd need the fetch anyway to
        // call set_meta/set_content, so there's no extra round-trip.
        // For first-time pushes we mint a fresh key.
        let (existing_item, key_for_payload): (Option<Item>, Vec<u8>) = match &row.etebase_uid {
            Some(uid) => {
                let existing = im
                    .fetch(uid, None)
                    .map_err(|e| AppError::InvalidArg(format!("fetch note {uid}: {e}")))?;
                let extracted = if !existing.is_deleted() && !existing.is_missing_content() {
                    existing
                        .content()
                        .ok()
                        .and_then(|raw| rmp_serde::from_slice::<NotePayload>(&raw).ok())
                        .map(|p| p.crypto_key)
                        .filter(|k| !k.is_empty())
                } else {
                    None
                };
                (Some(existing), extracted.unwrap_or_else(|| randombytes(32)))
            }
            None => (None, randombytes(32)),
        };

        let payload = NotePayload {
            schema: PAYLOAD_SCHEMA,
            id: row.id.clone(),
            parent_folder_id: row.parent_collection_id.clone(),
            title: row.title.clone(),
            position: row.position,
            created: Some(row.created.clone()),
            modified: Some(row.modified.clone()),
            tags: row.tags.clone(),
            tags_state: row.tags_state.clone(),
            trashed_at: row.trashed_at.clone(),
            yrs_state: row.yrs_state.clone(),
            body: row.body.clone(),
            crypto_key: key_for_payload,
            favourite: row.favourite,
            note_kind: row.note_kind.clone(),
        };
        let bytes = rmp_serde::to_vec_named(&payload)
            .map_err(|e| AppError::InvalidArg(format!("encode note: {e}")))?;
        let mut meta = ItemMetadata::new();
        meta.set_item_type(Some(ITEM_TYPE_NOTE))
            .set_name(Some(row.title.clone()))
            .set_mtime(Some(now_unix_ms()));
        let item = if let Some(mut existing) = existing_item {
            existing
                .set_meta(&meta)
                .map_err(|e| AppError::InvalidArg(format!("set_meta note: {e}")))?;
            existing
                .set_content(&bytes)
                .map_err(|e| AppError::InvalidArg(format!("set_content note: {e}")))?;
            existing
        } else {
            im.create(&meta, &bytes)
                .map_err(|e| AppError::InvalidArg(format!("create note item: {e}")))?
        };
        prepared.push((item, row.id.clone()));
    }

    let local_ids: Vec<String> = prepared.iter().map(|(_, id)| id.clone()).collect();
    let local_tag_states: Vec<Vec<u8>> = dirty.iter().map(|row| row.tags_state.clone()).collect();
    let mut items: Vec<Item> = prepared.into_iter().map(|(i, _)| i).collect();
    transact_or_resolve(im, &mut items, &mut report.conflicts_resolved)
        .map_err(|e| AppError::InvalidArg(format!("transaction notes: {e}")))?;

    let pushed = items.len();
    db.with_conn_mut(|c| {
        let tx = c.transaction()?;
        for ((item, local_id), tags_state) in items
            .iter()
            .zip(local_ids.iter())
            .zip(local_tag_states.iter())
        {
            tx.execute(
                "UPDATE notes
                 SET etebase_uid = ?1, etebase_etag = ?2, dirty = 0,
                     payload_schema = ?3, tags_state = ?4
                 WHERE id = ?5",
                params![
                    item.uid(),
                    item.etag(),
                    PAYLOAD_SCHEMA as i64,
                    tags_state,
                    local_id,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    })?;
    report.notes_pushed += pushed;

    drain_tombstones(db, im, "note", scope)
}

/// Upload dirty asset rows to the assets Etebase collection.
///
/// Mirrors push_notes but simpler: no key/encryption metadata to roll
/// over (Etebase's per-collection key handles E2EE itself), and no
/// schema flip-flop (assets have one payload version for now). After
/// the batch transaction we clear `dirty` and stamp the assigned
/// etebase_uid / etag on each local row.
///
/// Drains the asset tombstone queue at the end — entries are added by
/// notes::purge when a freeform note with synced assets gets purged.
pub(super) fn push_assets(
    db: &Db,
    im: &ItemManager,
    report: &mut SyncReport,
    scope: Option<&str>,
) -> AppResult<()> {
    let dirty = load_dirty_assets(db, scope)?;
    if dirty.is_empty() {
        return drain_tombstones(db, im, "asset", scope);
    }

    let mut prepared: Vec<(Item, String)> = Vec::with_capacity(dirty.len());
    for row in &dirty {
        let payload = AssetPayload {
            schema: 1,
            id: row.id.clone(),
            owning_note_id: row.owning_note_id.clone(),
            mime_type: row.mime_type.clone(),
            bytes: row.bytes.clone(),
            size: row.size,
            created: row.created.clone(),
            modified: row.modified.clone(),
        };
        let bytes = rmp_serde::to_vec_named(&payload)
            .map_err(|e| AppError::InvalidArg(format!("encode asset: {e}")))?;
        let mut meta = ItemMetadata::new();
        meta.set_item_type(Some(ITEM_TYPE_ASSET))
            // Asset items don't have a human-facing name; use the id
            // (matches the URL drawing records can carry) so the
            // server-side metadata is at least debuggable.
            .set_name(Some(row.id.clone()))
            .set_mtime(Some(now_unix_ms()));
        let item = if let Some(uid) = &row.etebase_uid {
            let mut existing = im
                .fetch(uid, None)
                .map_err(|e| AppError::InvalidArg(format!("fetch asset {uid}: {e}")))?;
            existing
                .set_meta(&meta)
                .map_err(|e| AppError::InvalidArg(format!("set_meta asset: {e}")))?;
            existing
                .set_content(&bytes)
                .map_err(|e| AppError::InvalidArg(format!("set_content asset: {e}")))?;
            existing
        } else {
            im.create(&meta, &bytes)
                .map_err(|e| AppError::InvalidArg(format!("create asset item: {e}")))?
        };
        prepared.push((item, row.id.clone()));
    }

    let local_ids: Vec<String> = prepared.iter().map(|(_, id)| id.clone()).collect();
    let mut items: Vec<Item> = prepared.into_iter().map(|(i, _)| i).collect();
    transact_or_resolve(im, &mut items, &mut report.conflicts_resolved)
        .map_err(|e| AppError::InvalidArg(format!("transaction assets: {e}")))?;

    let pushed = items.len();
    db.with_conn_mut(|c| {
        let tx = c.transaction()?;
        for (item, local_id) in items.iter().zip(local_ids.iter()) {
            tx.execute(
                "UPDATE assets
                 SET etebase_uid = ?1, etebase_etag = ?2, dirty = 0
                 WHERE id = ?3",
                params![item.uid(), item.etag(), local_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    })?;
    report.assets_pushed += pushed;

    drain_tombstones(db, im, "asset", scope)
}

/// Push dirty signatures as per-signature items, then drain the signature
/// tombstone queue. Mirrors `push_assets` — the geometry blob is small but
/// the lifecycle (create vs fetch+set_content, etag round-trip, conflict
/// resolution) is identical.
pub(super) fn push_signatures(db: &Db, im: &ItemManager, report: &mut SyncReport) -> AppResult<()> {
    let dirty = load_dirty_signatures(db)?;
    if dirty.is_empty() {
        return drain_tombstones(db, im, "signature", None);
    }

    let mut prepared: Vec<(Item, String)> = Vec::with_capacity(dirty.len());
    for row in &dirty {
        let payload = SignaturePayload {
            schema: 1,
            id: row.id.clone(),
            data: row.data.clone(),
            created: row.created.clone(),
            modified: row.modified.clone(),
        };
        let bytes = rmp_serde::to_vec_named(&payload)
            .map_err(|e| AppError::InvalidArg(format!("encode signature: {e}")))?;
        let mut meta = ItemMetadata::new();
        meta.set_item_type(Some(ITEM_TYPE_SIGNATURE))
            .set_name(Some(row.id.clone()))
            .set_mtime(Some(now_unix_ms()));
        let item = if let Some(uid) = &row.etebase_uid {
            let mut existing = im
                .fetch(uid, None)
                .map_err(|e| AppError::InvalidArg(format!("fetch signature {uid}: {e}")))?;
            existing
                .set_meta(&meta)
                .map_err(|e| AppError::InvalidArg(format!("set_meta signature: {e}")))?;
            existing
                .set_content(&bytes)
                .map_err(|e| AppError::InvalidArg(format!("set_content signature: {e}")))?;
            existing
        } else {
            im.create(&meta, &bytes)
                .map_err(|e| AppError::InvalidArg(format!("create signature item: {e}")))?
        };
        prepared.push((item, row.id.clone()));
    }

    let local_ids: Vec<String> = prepared.iter().map(|(_, id)| id.clone()).collect();
    let mut items: Vec<Item> = prepared.into_iter().map(|(i, _)| i).collect();
    transact_or_resolve(im, &mut items, &mut report.conflicts_resolved)
        .map_err(|e| AppError::InvalidArg(format!("transaction signatures: {e}")))?;

    let pushed = items.len();
    db.with_conn_mut(|c| {
        let tx = c.transaction()?;
        for (item, local_id) in items.iter().zip(local_ids.iter()) {
            tx.execute(
                "UPDATE signatures
                 SET etebase_uid = ?1, etebase_etag = ?2, dirty = 0
                 WHERE id = ?3",
                params![item.uid(), item.etag(), local_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    })?;
    report.signatures_pushed += pushed;

    drain_tombstones(db, im, "signature", None)
}

/// Try a transaction; on `Error::Conflict`, refetch the colliding items,
/// CRDT-merge any note bodies, and retry. Bounded retry count so a
/// pathological case doesn't loop forever.
pub(super) fn transact_or_resolve(
    im: &ItemManager,
    items: &mut [Item],
    conflicts: &mut usize,
) -> Result<(), EtebaseError> {
    const MAX_ATTEMPTS: usize = 5;
    for attempt in 0..MAX_ATTEMPTS {
        let result = im.transaction(items.iter(), None);
        match result {
            Ok(()) => return Ok(()),
            Err(EtebaseError::Conflict(msg)) => {
                log::warn!(
                    "[sync] transaction conflict (attempt {}): {msg}",
                    attempt + 1
                );
                *conflicts += 1;
                refetch_and_remerge(im, items)?;
            }
            Err(e) => return Err(e),
        }
    }
    Err(EtebaseError::Conflict(
        "exceeded retry budget for transaction".into(),
    ))
}

pub(super) fn refetch_and_remerge(
    im: &ItemManager,
    items: &mut [Item],
) -> Result<(), EtebaseError> {
    // Fetch the latest server copy of each item we tried to push; if
    // it's a note, merge its yrs state into ours so neither side wins
    // outright. For folders, last-write-wins on the metadata is fine —
    // folders are placeholders, not user-editable content.
    for item in items.iter_mut() {
        let server = im.fetch(item.uid(), None)?;
        if server.is_deleted() || server.is_missing_content() {
            // Server has nothing newer than what we're pushing, but our
            // etag was stale. Inherit the new etag and retry.
            let bytes = item.content()?;
            let meta = item.meta()?;
            *item = im.fetch(server.uid(), None)?;
            item.set_meta(&meta)?;
            item.set_content(&bytes)?;
            continue;
        }

        let server_bytes = server.content()?;
        // Try note first; fall back to folder.
        if let Ok(server_payload) = rmp_serde::from_slice::<NotePayload>(&server_bytes) {
            let local_bytes = item.content()?;
            if let Ok(mut local_payload) = rmp_serde::from_slice::<NotePayload>(&local_bytes) {
                local_payload.yrs_state =
                    yrs_doc::merge_remote(&local_payload.yrs_state, &server_payload.yrs_state);
                let local_tags_state = if local_payload.tags_state.is_empty() {
                    tags_crdt::init(&local_payload.tags)
                } else {
                    local_payload.tags_state.clone()
                };
                let server_tags_state = if server_payload.tags_state.is_empty() {
                    tags_crdt::init(&server_payload.tags)
                } else {
                    server_payload.tags_state
                };
                local_payload.tags_state = tags_crdt::merge(&local_tags_state, &server_tags_state);
                local_payload.tags = tags_crdt::tags(&local_payload.tags_state);
                let merged = rmp_serde::to_vec_named(&local_payload)
                    .map_err(|e| EtebaseError::Generic(format!("re-encode merged note: {e}")))?;
                *item = im.fetch(server.uid(), None)?;
                let local_meta = item.meta()?;
                item.set_meta(&local_meta)?;
                item.set_content(&merged)?;
                continue;
            }
        }
        // Folder (or unknown): take the local payload, ride the server etag.
        let local_bytes = item.content()?;
        let local_meta = item.meta()?;
        *item = im.fetch(server.uid(), None)?;
        item.set_meta(&local_meta)?;
        item.set_content(&local_bytes)?;
    }
    Ok(())
}

/// Drain queued deletes for `kind` against the collection `im` is bound to.
/// `scope` selects which tombstones belong here: `None` = the vault-wide
/// collection (`share_scope_id IS NULL`), `Some(id)` = that share scope's
/// collection. Routing by scope keeps a scoped delete from being fired at the
/// vault collection (where its uid doesn't exist) and vice versa.
pub(super) fn drain_tombstones(
    db: &Db,
    im: &ItemManager,
    kind: &str,
    scope: Option<&str>,
) -> AppResult<()> {
    let uids: Vec<String> = db.with_conn(|c| {
        let rows = match scope {
            None => {
                let mut stmt = c.prepare(
                    "SELECT etebase_uid FROM tombstones
                     WHERE kind = ?1 AND share_scope_id IS NULL",
                )?;
                let rows = stmt.query_map(params![kind], |r| r.get::<_, String>(0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            }
            Some(id) => {
                let mut stmt = c.prepare(
                    "SELECT etebase_uid FROM tombstones
                     WHERE kind = ?1 AND share_scope_id = ?2",
                )?;
                let rows = stmt.query_map(params![kind, id], |r| r.get::<_, String>(0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            }
        };
        Ok(rows)
    })?;
    if uids.is_empty() {
        return Ok(());
    }

    let mut items: Vec<Item> = Vec::with_capacity(uids.len());
    for uid in &uids {
        match im.fetch(uid, None) {
            Ok(mut item) => {
                if !item.is_deleted() {
                    item.delete()
                        .map_err(|e| AppError::InvalidArg(format!("mark deleted {uid}: {e}")))?;
                }
                items.push(item);
            }
            Err(e) => log::warn!("[sync] tombstone fetch {uid} failed: {e}"),
        }
    }

    if !items.is_empty() {
        im.transaction(items.iter(), None)
            .map_err(|e| AppError::InvalidArg(format!("transaction delete {kind}s: {e}")))?;
    }

    db.with_conn(|c| {
        let mut stmt = c.prepare("DELETE FROM tombstones WHERE kind = ?1 AND etebase_uid = ?2")?;
        for uid in &uids {
            stmt.execute(params![kind, uid])?;
        }
        Ok(())
    })?;
    Ok(())
}
