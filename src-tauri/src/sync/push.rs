//! Push half of the sync loop: send dirty local rows to Etebase.
//!
//! Every `push_*` builds items from the rows `local_rows` hands it and
//! commits them through [`transact_or_resolve`], which retries a
//! conflicting transaction after re-merging the server's copy.

use super::*;

use etebase::PrefetchOption;

// ---------- Push ----------

/// How many items one request names when their content is not asked for.
/// Each comes back as its revision alone, a few hundred bytes.
const EXISTING_BATCH: usize = 500;

/// What a push needs of the items it is about to change.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Existing {
    /// The revision alone. Enough to put new content on an item or to
    /// delete it, and nothing of the old content is downloaded.
    Revision,
    /// The content too. A note's holds the key of its live sessions, which
    /// the next revision has to carry over.
    Content,
}

/// The items the server has under these uids, keyed by uid.
///
/// A push that changes an item builds on the item as the server has it.
/// Getting that used to be a request per item, each one downloading the
/// content the push was about to replace. This names a batch at a time.
///
/// An item the server does not have is left out. The caller decides what
/// that means.
fn fetch_existing(
    im: &ItemManager,
    uids: &[&str],
    need: Existing,
) -> AppResult<HashMap<String, Item>> {
    let mut found = HashMap::with_capacity(uids.len());
    let without_content = PrefetchOption::Medium;
    let batch = match need {
        Existing::Revision => EXISTING_BATCH,
        Existing::Content => ItemKind::Note.batch(),
    };
    for named in uids.chunks(batch) {
        let mut wanted: Vec<String> = named.iter().map(|uid| uid.to_string()).collect();
        // With content, the server gives it to as many items as fit one
        // answer, from the first. The rest are asked for again, as a pull
        // does it, see `Arrived`.
        while !wanted.is_empty() {
            let options = match need {
                Existing::Revision => Some(FetchOptions::new().prefetch(&without_content)),
                Existing::Content => None,
            };
            let fetched = im
                .fetch_multi(wanted.iter().map(String::as_str), options.as_ref())
                .map_err(|e| AppError::InvalidArg(format!("fetch items to push: {e}")))?;
            let mut again = Vec::new();
            for (place, item) in fetched.data().iter().enumerate() {
                let item = match need {
                    Existing::Revision => item.clone(),
                    Existing::Content => match Arrived::at(place, held_back(item)) {
                        Arrived::Whole => item.clone(),
                        Arrived::TooLarge => whole(im, item)?,
                        Arrived::Later => {
                            again.push(item.uid().to_string());
                            continue;
                        }
                    },
                };
                found.insert(item.uid().to_string(), item);
            }
            wanted = again;
        }
    }
    Ok(found)
}

/// The uids of the rows that are on the server already.
fn uids_on_server<'a>(uids: impl Iterator<Item = &'a Option<String>>) -> Vec<&'a str> {
    uids.filter_map(|uid| uid.as_deref()).collect()
}

/// Take the item a row is on the server as out of what was fetched.
fn take_existing(existing: &mut HashMap<String, Item>, what: &str, uid: &str) -> AppResult<Item> {
    existing.remove(uid).ok_or_else(|| {
        AppError::InvalidArg(format!("fetch {what} {uid}: the server does not have it"))
    })
}

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

    let mut existing = fetch_existing(
        im,
        &uids_on_server(dirty.iter().map(|row| &row.etebase_uid)),
        Existing::Revision,
    )?;

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
            let mut existing = take_existing(&mut existing, "folder", uid)?;
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

    let mut items: Vec<Item> = prepared.into_iter().map(|(i, _)| i).collect();
    transact_or_resolve(im, &mut items, &mut report.conflicts_resolved)
        .map_err(|e| AppError::InvalidArg(format!("transaction folders: {e}")))?;

    let pushed = items.len();
    // Persist new uids/etags + clear dirty flag.
    db.with_conn_mut(|c| {
        let tx = c.transaction()?;
        for (item, row) in items.iter().zip(&dirty) {
            acknowledge_push(
                &tx,
                PushReceipt {
                    kind: PushedKind::Folder,
                    id: &row.id,
                    modified: &row.modified,
                    previous_uid: row.etebase_uid.as_deref(),
                    scope,
                    uid: item.uid(),
                    etag: item.etag(),
                    tags_state: &[],
                },
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

    // For existing items we fetch first so we can extract the live
    // crypto_key off the server-side payload and re-use it in the new one.
    // Rotating the key on every push would break peers' in-progress live
    // sessions. So these come with their content, a batch per request.
    // For first-time pushes we mint a fresh key.
    let mut existing = fetch_existing(
        im,
        &uids_on_server(dirty.iter().map(|row| &row.etebase_uid)),
        Existing::Content,
    )?;

    let mut prepared: Vec<(Item, String)> = Vec::with_capacity(dirty.len());
    for row in &dirty {
        let (existing_item, key_for_payload): (Option<Item>, Vec<u8>) = match &row.etebase_uid {
            Some(uid) => {
                let existing = take_existing(&mut existing, "note", uid)?;
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

    let mut items: Vec<Item> = prepared.into_iter().map(|(i, _)| i).collect();
    transact_or_resolve(im, &mut items, &mut report.conflicts_resolved)
        .map_err(|e| AppError::InvalidArg(format!("transaction notes: {e}")))?;

    let pushed = items.len();
    db.with_conn_mut(|c| {
        let tx = c.transaction()?;
        for (item, row) in items.iter().zip(&dirty) {
            acknowledge_push(
                &tx,
                PushReceipt {
                    kind: PushedKind::Note,
                    id: &row.id,
                    modified: &row.modified,
                    previous_uid: row.etebase_uid.as_deref(),
                    scope,
                    uid: item.uid(),
                    etag: item.etag(),
                    tags_state: &row.tags_state,
                },
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

    // The revision alone: an attachment's old bytes are of no use to the
    // push that replaces them.
    let mut existing = fetch_existing(
        im,
        &uids_on_server(dirty.iter().map(|row| &row.etebase_uid)),
        Existing::Revision,
    )?;

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
            let mut existing = take_existing(&mut existing, "asset", uid)?;
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

    let mut items: Vec<Item> = prepared.into_iter().map(|(i, _)| i).collect();
    transact_or_resolve(im, &mut items, &mut report.conflicts_resolved)
        .map_err(|e| AppError::InvalidArg(format!("transaction assets: {e}")))?;

    let pushed = items.len();
    db.with_conn_mut(|c| {
        let tx = c.transaction()?;
        for (item, row) in items.iter().zip(&dirty) {
            acknowledge_push(
                &tx,
                PushReceipt {
                    kind: PushedKind::Asset,
                    id: &row.id,
                    modified: &row.modified,
                    previous_uid: row.etebase_uid.as_deref(),
                    scope,
                    uid: item.uid(),
                    etag: item.etag(),
                    tags_state: &[],
                },
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

    let mut existing = fetch_existing(
        im,
        &uids_on_server(dirty.iter().map(|row| &row.etebase_uid)),
        Existing::Revision,
    )?;

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
            let mut existing = take_existing(&mut existing, "signature", uid)?;
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

    let mut items: Vec<Item> = prepared.into_iter().map(|(i, _)| i).collect();
    transact_or_resolve(im, &mut items, &mut report.conflicts_resolved)
        .map_err(|e| AppError::InvalidArg(format!("transaction signatures: {e}")))?;

    let pushed = items.len();
    db.with_conn_mut(|c| {
        let tx = c.transaction()?;
        for (item, row) in items.iter().zip(&dirty) {
            acknowledge_push(
                &tx,
                PushReceipt {
                    kind: PushedKind::Signature,
                    id: &row.id,
                    modified: &row.modified,
                    previous_uid: row.etebase_uid.as_deref(),
                    scope: None,
                    uid: item.uid(),
                    etag: item.etag(),
                    tags_state: &[],
                },
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

    // Deleting an item takes its revision and none of its content.
    let named: Vec<&str> = uids.iter().map(String::as_str).collect();
    let mut existing = fetch_existing(im, &named, Existing::Revision)?;
    let mut items: Vec<Item> = Vec::with_capacity(uids.len());
    for uid in &uids {
        match existing.remove(uid) {
            Some(mut item) => {
                if !item.is_deleted() {
                    item.delete()
                        .map_err(|e| AppError::InvalidArg(format!("mark deleted {uid}: {e}")))?;
                }
                items.push(item);
            }
            // Nothing there to delete. The queue entry goes all the same.
            None => log::warn!("[sync] tombstone {uid}: the server does not have the item"),
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

#[derive(Clone, Copy)]
enum PushedKind {
    Folder,
    Note,
    Asset,
    Signature,
}

struct PushReceipt<'a> {
    kind: PushedKind,
    id: &'a str,
    modified: &'a str,
    previous_uid: Option<&'a str>,
    scope: Option<&'a str>,
    uid: &'a str,
    etag: &'a str,
    tags_state: &'a [u8],
}

fn acknowledge_push(conn: &Connection, receipt: PushReceipt<'_>) -> AppResult<()> {
    let (table, kind) = match receipt.kind {
        PushedKind::Folder => ("collections", "folder"),
        PushedKind::Note => ("notes", "note"),
        PushedKind::Asset => ("assets", "asset"),
        PushedKind::Signature => ("signatures", "signature"),
    };
    let scope_guard = if matches!(receipt.kind, PushedKind::Signature) {
        "?6 IS NULL"
    } else {
        "share_scope_id IS ?6"
    };
    // A row that has an item again is nobody's to claim. Signatures never
    // leave the vault and have no such mark.
    let released = if matches!(receipt.kind, PushedKind::Signature) {
        ""
    } else {
        "released = 0,"
    };
    // Always retain a newly assigned identity, even if a concurrent edit must
    // remain dirty. Rehomed/deleted rows must not regain their old identity.
    let sql = format!(
        "UPDATE {table} SET etebase_uid = ?1, etebase_etag = ?2, {released}
        dirty = CASE WHEN modified = ?4 THEN 0 ELSE dirty END
        WHERE id = ?3 AND etebase_uid IS ?5 AND {scope_guard}"
    );
    let changed = conn.execute(
        &sql,
        params![
            receipt.uid,
            receipt.etag,
            receipt.id,
            receipt.modified,
            receipt.previous_uid,
            receipt.scope
        ],
    )?;
    if changed == 0 {
        conn.execute(
            "INSERT OR IGNORE INTO tombstones(kind, etebase_uid, share_scope_id, queued_at)
            VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)",
            params![kind, receipt.uid, receipt.scope],
        )?;
    } else if matches!(receipt.kind, PushedKind::Note) {
        conn.execute(
            "UPDATE notes SET payload_schema = ?1, tags_state = ?2
            WHERE id = ?3 AND modified = ?4",
            params![
                PAYLOAD_SCHEMA as i64,
                receipt.tags_state,
                receipt.id,
                receipt.modified
            ],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod receipt_tests {
    use super::*;

    #[test]
    fn concurrent_edits_keep_dirty_and_tags_but_receive_the_first_push_identity() {
        let db = crate::db::open_memory_for_tests();
        db.with_conn(|c| {
            let note = crate::notes::create(
                c,
                crate::notes::CreateNote {
                    title: None,
                    body: None,
                    parent_collection_id: None,
                    note_kind: None,
                },
            )?;
            c.execute(
                "UPDATE notes SET modified = 'newer', tags_state = X'CAFE' WHERE id = ?1",
                params![note.summary.id],
            )?;
            acknowledge_push(
                c,
                PushReceipt {
                    kind: PushedKind::Note,
                    id: &note.summary.id,
                    modified: &note.summary.modified,
                    previous_uid: None,
                    scope: None,
                    uid: "new-uid",
                    etag: "new-etag",
                    tags_state: &[1, 2],
                },
            )?;
            let (dirty, uid, state): (i64, String, Vec<u8>) = c.query_row(
                "SELECT dirty, etebase_uid, tags_state FROM notes WHERE id = ?1",
                params![note.summary.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
            assert_eq!(dirty, 1);
            assert_eq!(uid, "new-uid");
            assert_eq!(state, vec![0xCA, 0xFE]);
            acknowledge_push(
                c,
                PushReceipt {
                    kind: PushedKind::Note,
                    id: &note.summary.id,
                    modified: "newer",
                    previous_uid: Some("new-uid"),
                    scope: None,
                    uid: "new-uid",
                    etag: "next-etag",
                    tags_state: &[0xCA, 0xFE],
                },
            )?;
            assert_eq!(
                c.query_row(
                    "SELECT dirty FROM notes WHERE id = ?1",
                    params![note.summary.id],
                    |r| r.get::<_, i64>(0)
                )?,
                0
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn completed_push_for_a_rehomed_or_deleted_note_queues_scoped_cleanup() {
        let db = crate::db::open_memory_for_tests();
        db.with_conn(|c| {
            let note = crate::notes::create(
                c,
                crate::notes::CreateNote {
                    title: None,
                    body: None,
                    parent_collection_id: None,
                    note_kind: None,
                },
            )?;
            c.execute(
                "UPDATE notes SET share_scope_id = 'new-scope' WHERE id = ?1",
                params![note.summary.id],
            )?;
            for (id, uid) in [
                (note.summary.id.as_str(), "rehome-uid"),
                ("deleted", "deleted-uid"),
            ] {
                acknowledge_push(
                    c,
                    PushReceipt {
                        kind: PushedKind::Note,
                        id,
                        modified: &note.summary.modified,
                        previous_uid: None,
                        scope: Some("old-scope"),
                        uid,
                        etag: "etag",
                        tags_state: &[],
                    },
                )?;
            }
            let uid: Option<String> = c.query_row(
                "SELECT etebase_uid FROM notes WHERE id = ?1",
                params![note.summary.id],
                |r| r.get(0),
            )?;
            assert!(uid.is_none());
            assert_eq!(
                c.query_row(
                    "SELECT count(*) FROM tombstones WHERE share_scope_id = 'old-scope'",
                    [],
                    |r| r.get::<_, i64>(0)
                )?,
                2
            );
            Ok(())
        })
        .unwrap();
    }
}
