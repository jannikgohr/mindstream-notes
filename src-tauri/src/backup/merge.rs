//! Merge import: copy rows the live DB is missing out of a staged one.
//!
//! Merge never restores sync identity — every imported row lands
//! detached, so the next sync re-homes it under this account.

use super::*;

/// Merge missing items: copy rows from the staged DB into the live DB
/// when their `id` doesn't exist locally. Sync metadata is dropped on
/// every imported row (merge mode is always sanitize-by-design). No
/// restart needed.
#[tauri::command]
pub fn import_merge(
    app: AppHandle,
    db: tauri::State<'_, Db>,
    token: String,
) -> CommandResult<MergeReport> {
    let staged = imports_staging_root(&app)?.join(&token).join("data.db");
    if !staged.exists() {
        return Err(format!("staged backup '{token}' not found").into());
    }
    let backup_conn = Connection::open(&staged)?;
    let report = db.with_conn_mut(|live| merge_into(live, &backup_conn))?;
    // Merge consumed the staged DB; drop the dir so it doesn't linger.
    let dir = imports_staging_root(&app)?.join(&token);
    let _ = fs::remove_dir_all(&dir);
    Ok(report)
}

#[derive(Debug, Clone, Serialize)]
pub struct MergeReport {
    pub folders_added: u32,
    pub notes_added: u32,
    pub assets_added: u32,
    /// Notes whose `parent_collection_id` referenced a folder that
    /// didn't exist in the merged DB and was rerouted to root. Useful
    /// to surface in the success toast so the user knows where to
    /// look.
    pub notes_orphaned: u32,
}

pub(super) fn merge_into(live: &mut Connection, backup: &Connection) -> AppResult<MergeReport> {
    let tx = live.transaction()?;

    // ---- Folders first (children depend on parents existing). ----
    let mut stmt = backup.prepare(
        "SELECT id, parent_collection_id, name, position, created, modified
         FROM collections
         WHERE id <> 'trash'",
    )?;
    let folder_rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    // Two-pass insert: first insert all folders with parent = NULL so
    // we don't trip the FK on intra-backup orphans (a folder that
    // points at a sibling later in the iteration). Second pass fixes
    // up parents to whatever resolves in the merged DB; anything that
    // doesn't is left at root, matching the user's stated preference
    // for orphan-to-root.
    let mut added_folder_ids = std::collections::HashSet::new();
    let mut folders_added = 0u32;
    for (id, _parent, name, position, created, modified) in &folder_rows {
        let exists: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM collections WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        if exists.is_some() {
            continue;
        }
        tx.execute(
            "INSERT INTO collections(id, parent_collection_id, name, position, created, modified, dirty)
             VALUES (?1, NULL, ?2, ?3, ?4, ?5, 1)",
            params![id, name, position, created, modified],
        )?;
        added_folder_ids.insert(id.clone());
        folders_added += 1;
    }
    for (id, parent, _name, _position, _created, _modified) in &folder_rows {
        let Some(parent_id) = parent else {
            continue;
        };
        // Only re-parent folders we just added (don't touch pre-existing
        // ones whose parent might be intentionally different locally).
        if !added_folder_ids.contains(id) {
            continue;
        }
        let parent_exists: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM collections WHERE id = ?1",
                params![parent_id],
                |r| r.get(0),
            )
            .optional()?;
        if parent_exists.is_some() && parent_id != TRASH_ID {
            crate::sharing::ensure_collection_writable(&tx, parent_id)?;
            tx.execute(
                "UPDATE collections SET parent_collection_id = ?1 WHERE id = ?2",
                params![parent_id, id],
            )?;
        }
        // else: orphan parent — leave at root.
    }

    // ---- Notes ----
    let mut stmt = backup.prepare(
        "SELECT id, parent_collection_id, title, body, position, created, modified,
                trashed_at, favourite, yrs_state, payload_schema, note_kind, tags_state
         FROM notes",
    )?;
    let note_rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, i64>(8)?,
                r.get::<_, Option<Vec<u8>>>(9)?,
                r.get::<_, i64>(10)?,
                r.get::<_, String>(11)?,
                r.get::<_, Option<Vec<u8>>>(12)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    let mut notes_added = 0u32;
    let mut notes_orphaned = 0u32;
    for (
        id,
        parent,
        title,
        body,
        position,
        created,
        modified,
        trashed_at,
        favourite,
        yrs_state,
        payload_schema,
        note_kind,
        tags_state,
    ) in &note_rows
    {
        let exists: Option<i64> = tx
            .query_row("SELECT 1 FROM notes WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .optional()?;
        if exists.is_some() {
            continue;
        }
        // Resolve parent against the merged collections; drop to root
        // if it doesn't exist (matches the user's chosen orphan policy).
        let resolved_parent: Option<String> = if let Some(parent_id) = parent {
            let parent_present: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM collections WHERE id = ?1",
                    params![parent_id],
                    |r| r.get(0),
                )
                .optional()?;
            if parent_present.is_some() {
                Some(parent_id.clone())
            } else {
                notes_orphaned += 1;
                None
            }
        } else {
            None
        };

        crate::sharing::ensure_parent_writable(&tx, resolved_parent.as_deref())?;
        tx.execute(
            "INSERT INTO notes(id, parent_collection_id, title, body, position,
                                created, modified, dirty, note_kind, trashed_at,
                                favourite, yrs_state, payload_schema, tags_state)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                id,
                resolved_parent,
                title,
                body,
                position,
                created,
                modified,
                note_kind,
                trashed_at,
                favourite,
                yrs_state,
                payload_schema,
                tags_state,
            ],
        )?;
        notes_added += 1;

        // Bring this note's tags along.
        let mut tag_stmt = backup.prepare("SELECT tag FROM note_tags WHERE note_id = ?1")?;
        let tag_rows = tag_stmt.query_map(params![id], |r| r.get::<_, String>(0))?;
        for tag in tag_rows {
            let tag = tag?;
            // INSERT OR IGNORE because the PK is (note_id, tag).
            tx.execute(
                "INSERT OR IGNORE INTO note_tags(note_id, tag) VALUES (?1, ?2)",
                params![id, tag],
            )?;
        }
    }

    // ---- Assets ----
    let mut stmt = backup.prepare(
        "SELECT a.id, COALESCE(a.owning_note_id,
                    (SELECT r.note_id FROM asset_refs r WHERE r.asset_id = a.id ORDER BY r.note_id LIMIT 1)),
                a.mime_type, a.bytes, a.size, a.created, a.modified
         FROM assets a",
    )?;
    let asset_rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Vec<u8>>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    let mut assets_added = 0u32;
    for (id, owning_note_id, mime, bytes, size, created, modified) in &asset_rows {
        let Some(owning_note_id) = owning_note_id else {
            // A purged creator can leave an unreferenced blob pending the
            // next sweep. It must not prevent the rest of a backup merging.
            continue;
        };
        // Skip assets whose owning note didn't make it (either it
        // already existed locally with different content, or the user
        // chose merge mode and the note collided). Don't import an
        // orphan blob.
        let owner_present: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM notes WHERE id = ?1",
                params![owning_note_id],
                |r| r.get(0),
            )
            .optional()?;
        if owner_present.is_none() {
            continue;
        }
        let exists: Option<i64> = tx
            .query_row("SELECT 1 FROM assets WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .optional()?;
        if exists.is_some() {
            restore_asset_refs(&tx, backup, id)?;
            continue;
        }
        crate::sharing::ensure_note_writable(&tx, owning_note_id)?;
        tx.execute(
            "INSERT INTO assets(id, owning_note_id, mime_type, bytes, size,
                                created, modified, dirty, content_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8)",
            params![
                id,
                owning_note_id,
                mime,
                bytes,
                size,
                created,
                modified,
                crate::assets::content_hash(bytes),
            ],
        )?;
        // Lifetime is driven by asset_refs, not by owning_note_id — without a
        // row here the next sweep would free everything the merge just
        // restored.
        crate::assets::add_ref(&tx, id, owning_note_id)?;
        restore_asset_refs(&tx, backup, id)?;
        assets_added += 1;
    }

    // ---- Signatures (user-global; no owning note to gate on) ----
    let mut stmt = backup.prepare("SELECT id, data, created, modified FROM signatures")?;
    let signature_rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    for (id, data, created, modified) in &signature_rows {
        let exists: Option<i64> = tx
            .query_row("SELECT 1 FROM signatures WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .optional()?;
        if exists.is_some() {
            continue;
        }
        // dirty = 1 so the imported signature re-pushes under the current
        // account. Not surfaced in MergeReport — the import preview/report
        // only counts notes/folders/assets, so that contract stays put.
        tx.execute(
            "INSERT INTO signatures(id, data, created, modified, dirty)
             VALUES (?1, ?2, ?3, ?4, 1)",
            params![id, data, created, modified],
        )?;
    }

    tx.commit()?;
    Ok(MergeReport {
        folders_added,
        notes_added,
        assets_added,
        notes_orphaned,
    })
}

fn restore_asset_refs(live: &Connection, backup: &Connection, asset_id: &str) -> AppResult<()> {
    let mut refs = backup.prepare("SELECT note_id FROM asset_refs WHERE asset_id = ?1")?;
    for referrer in refs.query_map(params![asset_id], |r| r.get::<_, String>(0))? {
        live.execute(
            "INSERT OR IGNORE INTO asset_refs(asset_id, note_id)
             SELECT ?1, id FROM notes WHERE id = ?2",
            params![asset_id, referrer?],
        )?;
    }
    Ok(())
}
