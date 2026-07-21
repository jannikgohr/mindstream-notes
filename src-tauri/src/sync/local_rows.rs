//! Reading dirty local rows and the per-kind sync cursors.
//!
//! Everything push needs to know about the SQLite side lives here: the
//! `Dirty*` row structs, their loaders, and the `sync_state` stoken
//! accessors. Keeping it separate from `push` means the SQL can be
//! tested without an Etebase account.

use super::*;

// ---------- Local row reading ----------

pub(super) struct DirtyFolder {
    pub(super) id: String,
    pub(super) parent_collection_id: Option<String>,
    pub(super) name: String,
    pub(super) position: i64,
    pub(super) created: String,
    pub(super) modified: String,
    pub(super) etebase_uid: Option<String>,
}

#[derive(Clone, Copy)]
pub(super) struct VaultCollectionCandidate<'a> {
    pub(super) uid: &'a str,
    pub(super) is_deleted: bool,
    pub(super) access_level: CollectionAccessLevel,
}

impl<'a> From<&'a Collection> for VaultCollectionCandidate<'a> {
    fn from(collection: &'a Collection) -> Self {
        Self {
            uid: collection.uid(),
            is_deleted: collection.is_deleted(),
            access_level: collection.access_level(),
        }
    }
}

pub(super) fn usable_vault_collection(
    candidate: &VaultCollectionCandidate<'_>,
    share_scope_part_uids: &HashSet<String>,
) -> bool {
    !candidate.is_deleted
        && !share_scope_part_uids.contains(candidate.uid)
        && !matches!(candidate.access_level, CollectionAccessLevel::ReadOnly)
}

pub(super) struct DirtyNote {
    pub(super) id: String,
    pub(super) parent_collection_id: Option<String>,
    pub(super) title: String,
    pub(super) position: i64,
    pub(super) created: String,
    pub(super) modified: String,
    pub(super) trashed_at: Option<String>,
    pub(super) yrs_state: Vec<u8>,
    pub(super) etebase_uid: Option<String>,
    pub(super) tags: Vec<String>,
    /// Rendered markdown snapshot — pushed in v2 payloads so peers don't
    /// have to render markdown from XmlFragment server-side.
    pub(super) body: String,
    pub(super) favourite: bool,
    pub(super) note_kind: String,
    pub(super) tags_state: Vec<u8>,
}

pub(super) fn load_tags_for_note(conn: &Connection, note_id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT tag FROM note_tags WHERE note_id = ?1 ORDER BY tag")?;
    let rows = stmt.query_map(params![note_id], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub(super) fn load_dirty_folders(db: &Db, scope: Option<&str>) -> AppResult<Vec<DirtyFolder>> {
    db.with_conn(|c| {
        // The 'trash' built-in is local-only; never push it. The scope
        // predicate routes each row to its home collection: a NULL `scope`
        // matches only unscoped (vault) rows, a scope id matches only that
        // scope's rows.
        let mut stmt = c.prepare(
            "SELECT id, parent_collection_id, name, position, created, modified, etebase_uid
             FROM collections WHERE dirty = 1 AND id <> 'trash'
               AND ((?1 IS NULL AND share_scope_id IS NULL) OR share_scope_id = ?1)",
        )?;
        let rows = stmt.query_map(params![scope], |r| {
            Ok(DirtyFolder {
                id: r.get(0)?,
                parent_collection_id: r.get(1)?,
                name: r.get(2)?,
                position: r.get(3)?,
                created: r.get(4)?,
                modified: r.get(5)?,
                etebase_uid: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

pub(super) fn load_dirty_notes(db: &Db, scope: Option<&str>) -> AppResult<Vec<DirtyNote>> {
    let rows: Vec<DirtyNote> = db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT id, parent_collection_id, title, position, created, modified,
                    trashed_at, yrs_state, etebase_uid, body, favourite, note_kind,
                    tags_state
             FROM notes WHERE dirty = 1
               AND ((?1 IS NULL AND share_scope_id IS NULL) OR share_scope_id = ?1)",
        )?;
        let rows = stmt.query_map(params![scope], |r| {
            Ok(DirtyNote {
                id: r.get(0)?,
                parent_collection_id: r.get(1)?,
                title: r.get(2)?,
                position: r.get(3)?,
                created: r.get(4)?,
                modified: r.get(5)?,
                trashed_at: r.get(6)?,
                yrs_state: r.get::<_, Option<Vec<u8>>>(7)?.unwrap_or_default(),
                etebase_uid: r.get(8)?,
                tags: Vec::new(),
                body: r.get(9)?,
                favourite: r.get::<_, i64>(10)? != 0,
                note_kind: r.get(11)?,
                tags_state: r.get::<_, Option<Vec<u8>>>(12)?.unwrap_or_default(),
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })?;

    // Hydrate tags in a second pass to keep the row mapping simple.
    let mut by_id: HashMap<String, Vec<String>> = HashMap::new();
    db.with_conn(|c| {
        let mut stmt = c.prepare("SELECT note_id, tag FROM note_tags ORDER BY tag")?;
        let mut rs = stmt.query([])?;
        while let Some(r) = rs.next()? {
            let id: String = r.get(0)?;
            let tag: String = r.get(1)?;
            by_id.entry(id).or_default().push(tag);
        }
        Ok(())
    })?;
    Ok(rows
        .into_iter()
        .map(|mut n| {
            n.tags = by_id.remove(&n.id).unwrap_or_default();
            if n.tags_state.is_empty() {
                n.tags_state = tags_crdt::init(&n.tags);
            }
            n
        })
        .collect())
}

pub(super) struct DirtyAsset {
    pub(super) id: String,
    pub(super) owning_note_id: String,
    pub(super) mime_type: String,
    pub(super) bytes: Vec<u8>,
    pub(super) size: i64,
    pub(super) created: String,
    pub(super) modified: String,
    pub(super) etebase_uid: Option<String>,
}

pub(super) fn load_dirty_assets(db: &Db, scope: Option<&str>) -> AppResult<Vec<DirtyAsset>> {
    db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT id, owning_note_id, mime_type, bytes, size,
                    created, modified, etebase_uid
             FROM assets WHERE dirty = 1
               AND ((?1 IS NULL AND share_scope_id IS NULL) OR share_scope_id = ?1)",
        )?;
        let rows = stmt.query_map(params![scope], |r| {
            Ok(DirtyAsset {
                id: r.get(0)?,
                owning_note_id: r.get(1)?,
                mime_type: r.get(2)?,
                bytes: r.get(3)?,
                size: r.get(4)?,
                created: r.get(5)?,
                modified: r.get(6)?,
                etebase_uid: r.get(7)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

pub(super) struct DirtySignature {
    pub(super) id: String,
    pub(super) data: String,
    pub(super) created: String,
    pub(super) modified: String,
    pub(super) etebase_uid: Option<String>,
}

pub(super) fn load_dirty_signatures(db: &Db) -> AppResult<Vec<DirtySignature>> {
    db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT id, data, created, modified, etebase_uid
             FROM signatures WHERE dirty = 1",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(DirtySignature {
                id: r.get(0)?,
                data: r.get(1)?,
                created: r.get(2)?,
                modified: r.get(3)?,
                etebase_uid: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

// ---------- sync_state helpers ----------

pub(super) fn load_stoken(db: &Db, kind: &str) -> AppResult<Option<String>> {
    db.with_conn(|c| {
        Ok(c.query_row(
            "SELECT stoken FROM sync_state WHERE kind = ?1",
            params![kind],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
    })
}

pub(super) fn save_stoken(db: &Db, kind: &str, stoken: Option<&str>) -> AppResult<()> {
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO sync_state (kind, stoken)
             VALUES (?1, ?2)
             ON CONFLICT(kind) DO UPDATE SET stoken = excluded.stoken",
            params![kind, stoken],
        )?;
        Ok(())
    })
}
