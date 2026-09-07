//! Asset blobs — images dropped on a drawing canvas, pasted into a markdown
//! note, or the bytes behind an imported PDF.
//!
//! Each asset is the raw byte payload of a file. The frontend stores
//! `mindstream-asset://<id>` URLs inside drawing records and
//! `asset:mindstream/<id>` URLs inside markdown bodies, then calls
//! `fetch_drawing_asset` to materialise those into blob URLs at render time.
//!
//! # Ownership and lifetime
//!
//! An asset's lifetime is driven by the `asset_refs` table — the set of notes
//! that reference it — and NOT by `owning_note_id`. That distinction is the
//! whole point of the design: until migration 25 the owning note cascaded the
//! blob away on delete, so an image pasted into two notes died with the first
//! one purged.
//!
//! `owning_note_id` survives as a nullable *creator anchor*. It still rides
//! the sync wire (`AssetPayload`), still decides `share_scope_id` inheritance,
//! and is re-pointed at a surviving referrer when the creator is purged — but
//! it never decides when bytes are freed.
//!
//! Reference bookkeeping differs by note kind, matching where the reference
//! actually lives:
//!   - **markdown / pdf** notes reference assets from their body text, so
//!     [`register_body_refs`] adds rows on save and the reconciliation sweep
//!     ([`sweep_unreferenced_markdown_assets_inner`]) is authoritative.
//!   - **freeform / ink** notes reference assets from `yrs_state`, which the
//!     backend cannot cheaply scan. Their upload-time ref row is never
//!     reconciled away, which is what keeps drawing assets alive.
//!
//! # Deduplication
//!
//! Uploads are content-addressed on `content_hash` (sha256). Re-uploading
//! identical bytes reuses the existing row and just adds a reference, so an
//! import that sees the same attachment in fifty notes stores it once.
//!
//! The lookup key is `(share_scope_id, content_hash)`, never the hash alone:
//! reusing across scopes would let a vault-local blob be pulled into a shared
//! collection and pushed to that scope's recipients, which crosses an E2EE
//! boundary.

use std::collections::HashMap;
use std::sync::OnceLock;

use chrono::Utc;
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::db::Db;
use crate::error::{AppError, AppResult, CommandResult};
use crate::notes::{self, CreateNote, Note, NoteKind};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetSummary {
    pub id: String,
    /// The note that created this asset. `None` once that note has been
    /// deleted while another note still references the blob — see the module
    /// docs; this is an anchor, not a lifetime.
    pub owning_note_id: Option<String>,
    pub mime_type: String,
    pub size: i64,
    pub created: String,
    pub modified: String,
    /// True once the asset's been pushed to the remote (i.e. has an
    /// `etebase_uid`). Mirrors the same field on `NoteSummary`.
    pub pushed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Asset {
    #[serde(flatten)]
    pub summary: AssetSummary,
    /// Raw file bytes. JS receives this as a number array (Tauri's
    /// default Vec<u8> serialisation) and reassembles a `Blob` from it
    /// client-side.
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UploadAsset {
    pub owning_note_id: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportPdfNote {
    pub title: Option<String>,
    pub parent_collection_id: Option<String>,
    pub bytes: Vec<u8>,
}

fn row_to_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<AssetSummary> {
    let etebase_uid: Option<String> = row.get("etebase_uid")?;
    Ok(AssetSummary {
        id: row.get("id")?,
        owning_note_id: row.get("owning_note_id")?,
        mime_type: row.get("mime_type")?,
        size: row.get("size")?,
        created: row.get("created")?,
        modified: row.get("modified")?,
        pushed: etebase_uid.is_some(),
    })
}

/// sha256 of an asset's bytes, lowercase hex. The dedup key (paired with the
/// share scope) and what the migration-25 backfill writes.
pub(crate) fn content_hash(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        // Writing into a String is infallible; the Result only exists to
        // satisfy the fmt::Write trait.
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Outcome of a content-addressed store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredAsset {
    /// The id to embed in the note body — freshly minted, or the existing
    /// row's if the bytes were already stored.
    pub id: String,
    /// True when no new blob was written. Import surfaces this as a count so
    /// the user can see how much a vault of repeated images saved.
    pub deduplicated: bool,
}

/// Store `bytes` on behalf of `note_id` and return the asset id to embed in
/// that note's body.
///
/// Content-addressed: if an asset with identical bytes already exists **in
/// the same share scope**, its id comes back and only a reference row is
/// added. So a vault where the same image appears in fifty notes holds one
/// blob and fifty rows in `asset_refs`.
pub fn store_deduped(
    conn: &Connection,
    note_id: &str,
    mime_type: &str,
    bytes: &[u8],
) -> AppResult<StoredAsset> {
    require_note(conn, note_id)?;

    // Inherit the owning note's share scope so an image dropped into a shared
    // note is routed into that scope's asset collection (and pulled by
    // recipients) rather than the vault.
    let share_scope_id = crate::sharing::note_scope(conn, note_id)?;
    let hash = content_hash(bytes);

    // Scope-local dedup only. Matching on the hash alone would let a
    // vault-local blob be adopted into a shared scope (and pushed to that
    // scope's recipients), or a shared blob be reused vault-side — either
    // direction crosses the E2EE boundary the scopes exist to draw.
    let existing: Option<String> = match &share_scope_id {
        Some(scope) => conn
            .query_row(
                "SELECT id FROM assets
                 WHERE share_scope_id = ?1 AND content_hash = ?2
                 LIMIT 1",
                params![scope, hash],
                |r| r.get(0),
            )
            .optional()?,
        None => conn
            .query_row(
                "SELECT id FROM assets
                 WHERE share_scope_id IS NULL AND content_hash = ?1
                 LIMIT 1",
                params![hash],
                |r| r.get(0),
            )
            .optional()?,
    };

    if let Some(asset_id) = existing {
        add_ref(conn, &asset_id, note_id)?;
        return Ok(StoredAsset {
            id: asset_id,
            deduplicated: true,
        });
    }

    let id = format!("asset_{}", uuid::Uuid::new_v4());
    insert_asset(conn, &id, note_id, mime_type, bytes, &hash, share_scope_id)?;
    Ok(StoredAsset {
        id,
        deduplicated: false,
    })
}

pub fn upload(conn: &Connection, input: UploadAsset) -> AppResult<Asset> {
    let stored = store_deduped(conn, &input.owning_note_id, &input.mime_type, &input.bytes)?;
    load(conn, &stored.id)
}

/// Insert an asset under a caller-chosen id, skipping dedup.
///
/// Used where the id is baked into the note body *before* the bytes land —
/// [`import_pdf_note_inner`] writes `{"pdfAssetId": …}` first — so returning a
/// different (deduped) id would leave the body pointing at nothing. Callers
/// that can accept any id should use [`store_deduped`] instead.
pub fn upload_with_id(conn: &Connection, id: String, input: UploadAsset) -> AppResult<Asset> {
    require_note(conn, &input.owning_note_id)?;
    let share_scope_id = crate::sharing::note_scope(conn, &input.owning_note_id)?;
    let hash = content_hash(&input.bytes);
    insert_asset(
        conn,
        &id,
        &input.owning_note_id,
        &input.mime_type,
        &input.bytes,
        &hash,
        share_scope_id,
    )?;
    load(conn, &id)
}

/// Confirm the note exists before an FK write.
///
/// The constraint would surface as a generic SQLite error otherwise; a
/// targeted NotFound gives the JS side something useful to relay if the user
/// trashes the note between the drop and the upload landing.
fn require_note(conn: &Connection, note_id: &str) -> AppResult<()> {
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM notes WHERE id = ?1",
            params![note_id],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if !exists {
        return Err(AppError::NotFound(format!("note {note_id} (asset upload)")));
    }
    Ok(())
}

fn insert_asset(
    conn: &Connection,
    id: &str,
    note_id: &str,
    mime_type: &str,
    bytes: &[u8],
    content_hash: &str,
    share_scope_id: Option<String>,
) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO assets(id, owning_note_id, mime_type, bytes, size,
                            created, modified, share_scope_id, content_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8)",
        params![
            id,
            note_id,
            mime_type,
            bytes,
            bytes.len() as i64,
            now,
            share_scope_id,
            content_hash,
        ],
    )?;
    add_ref(conn, id, note_id)?;
    Ok(())
}

/// Record that `note_id` references `asset_id`. Idempotent.
pub fn add_ref(conn: &Connection, asset_id: &str, note_id: &str) -> AppResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO asset_refs(asset_id, note_id) VALUES (?1, ?2)",
        params![asset_id, note_id],
    )?;
    Ok(())
}

/// Add reference rows for every asset `body` mentions.
///
/// Purely additive, and deliberately so: this runs on every note save, where
/// the authoritative alternative — also diffing the note's history snapshots
/// — would mean decompressing every version on every save. Stale rows are
/// cleaned up by the reconciliation sweep, which is also the only place
/// assets are actually deleted, so an over-broad ref set costs nothing but a
/// row.
///
/// Ids referencing assets that don't exist (a body pasted in from another
/// vault) are skipped rather than failing the save.
pub fn register_body_refs(conn: &Connection, note_id: &str, body: &str) -> AppResult<()> {
    let mut counts = HashMap::new();
    count_asset_refs(body, &mut counts);
    for asset_id in counts.keys() {
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM assets WHERE id = ?1",
                params![asset_id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if exists {
            add_ref(conn, asset_id, note_id)?;
        }
    }
    Ok(())
}

/// Drop `note_id`'s claim on every asset and delete the ones nothing else
/// references. Returns how many blobs were freed.
///
/// Called from [`crate::notes::purge`] *before* the note row goes, which is
/// the only point where the note's references and its assets' `etebase_uid`s
/// are both still readable. Assets that survive because another note
/// references them get their `owning_note_id` re-pointed at one of those
/// survivors, so the anchor the sync payload needs stays valid.
pub fn release_note_assets(conn: &Connection, note_id: &str) -> AppResult<usize> {
    // Candidates: anything this note referenced, plus anything it created.
    // The second half matters for freeform / ink notes, whose references live
    // in `yrs_state` where only the upload-time ref row records them.
    let candidates: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT asset_id FROM asset_refs WHERE note_id = ?1
             UNION
             SELECT id FROM assets WHERE owning_note_id = ?1",
        )?;
        let rows = stmt.query_map(params![note_id], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    if candidates.is_empty() {
        return Ok(0);
    }

    conn.execute(
        "DELETE FROM asset_refs WHERE note_id = ?1",
        params![note_id],
    )?;

    let mut removed = 0usize;
    for asset_id in candidates {
        let survivor: Option<String> = conn
            .query_row(
                "SELECT note_id FROM asset_refs WHERE asset_id = ?1 LIMIT 1",
                params![asset_id],
                |r| r.get(0),
            )
            .optional()?;
        match survivor {
            // Still referenced. Re-anchor if we were the creator so the sync
            // payload keeps a live owning_note_id.
            Some(other_note) => {
                conn.execute(
                    "UPDATE assets SET owning_note_id = ?1
                     WHERE id = ?2 AND owning_note_id = ?3",
                    params![other_note, asset_id, note_id],
                )?;
            }
            None => removed += delete_asset(conn, &asset_id)?,
        }
    }
    Ok(removed)
}

/// Delete one asset row, queueing a server-side delete first if it had been
/// pushed. Returns 1 if a row went away.
fn delete_asset(conn: &Connection, asset_id: &str) -> AppResult<usize> {
    let etebase_uid: Option<String> = conn
        .query_row(
            "SELECT etebase_uid FROM assets WHERE id = ?1",
            params![asset_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    if let Some(uid) = etebase_uid {
        crate::sync::queue_tombstone(conn, "asset", &uid)?;
    }
    Ok(conn.execute("DELETE FROM assets WHERE id = ?1", params![asset_id])?)
}

pub fn import_pdf_note_inner(conn: &Connection, input: ImportPdfNote) -> AppResult<Note> {
    if input.bytes.is_empty() {
        return Err(AppError::InvalidArg("PDF file is empty".into()));
    }

    let asset_id = format!("asset_{}", uuid::Uuid::new_v4());
    let body = json!({ "pdfAssetId": asset_id }).to_string();
    let note = notes::create(
        conn,
        CreateNote {
            title: input.title,
            body: Some(body),
            parent_collection_id: input.parent_collection_id,
            note_kind: Some(NoteKind::Pdf),
        },
    )?;

    upload_with_id(
        conn,
        asset_id,
        UploadAsset {
            owning_note_id: note.summary.id.clone(),
            mime_type: "application/pdf".into(),
            bytes: input.bytes,
        },
    )?;

    Ok(note)
}

pub fn load(conn: &Connection, id: &str) -> AppResult<Asset> {
    let mut stmt = conn.prepare(
        "SELECT id, owning_note_id, mime_type, bytes, size,
                created, modified, etebase_uid
         FROM assets WHERE id = ?1",
    )?;
    let row_data = stmt
        .query_row(params![id], |row| {
            let summary = row_to_summary(row)?;
            let bytes: Vec<u8> = row.get("bytes")?;
            Ok((summary, bytes))
        })
        .optional()?;

    match row_data {
        Some((summary, bytes)) => Ok(Asset { summary, bytes }),
        None => Err(AppError::NotFound(format!("asset {id}"))),
    }
}

fn asset_url_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| match Regex::new(r"asset:mindstream/([A-Za-z0-9_-]+)") {
        Ok(re) => Some(re),
        Err(err) => {
            log::error!("[assets] invalid asset URL regex: {err}");
            None
        }
    })
    .as_ref()
}

fn count_asset_refs(body: &str, counts: &mut HashMap<String, usize>) {
    if let Some(re) = asset_url_re() {
        for captures in re.captures_iter(body) {
            if let Some(id) = captures.get(1) {
                *counts.entry(id.as_str().to_string()).or_default() += 1;
            }
        }
    }
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(id) = parsed.get("pdfAssetId").and_then(|v| v.as_str()) {
            *counts.entry(id.to_string()).or_default() += 1;
        }
    }
}

pub(crate) fn asset_reference_counts(
    conn: &Connection,
    note_id: &str,
) -> AppResult<HashMap<String, usize>> {
    let mut counts = HashMap::new();
    let current: Option<(NoteKind, String)> = conn
        .query_row(
            "SELECT note_kind, body FROM notes WHERE id = ?1",
            params![note_id],
            |r| Ok((r.get::<_, NoteKind>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((note_kind, body)) = current else {
        return Ok(counts);
    };
    count_asset_refs(&body, &mut counts);

    if !note_kind.is_markdown() {
        return Ok(counts);
    }

    let mut stmt = conn.prepare(
        "SELECT body FROM note_versions
         WHERE note_id = ?1 AND note_kind = 'markdown'",
    )?;
    let rows = stmt.query_map(params![note_id], |r| r.get::<_, Vec<u8>>(0))?;
    for row in rows {
        let snapshot = crate::history::decompress_snapshot(&row?)?;
        count_asset_refs(&snapshot, &mut counts);
    }
    Ok(counts)
}

/// Rebuild one markdown note's reference rows from its body and history, then
/// delete any asset that ends up referenced by nothing at all.
///
/// This is the authoritative half of the bookkeeping — [`register_body_refs`]
/// only ever adds rows, so a note whose image the user deleted keeps a stale
/// ref until this runs.
///
/// Non-markdown notes are skipped entirely, and that is load-bearing: a
/// freeform or ink note references its assets from `yrs_state`, not from
/// `body`, so reconciling it from text would drop every ref and free blobs the
/// canvas is still drawing.
pub(crate) fn purge_unreferenced_markdown_assets(
    conn: &Connection,
    note_id: &str,
) -> AppResult<usize> {
    let note_kind: Option<NoteKind> = conn
        .query_row(
            "SELECT note_kind FROM notes WHERE id = ?1",
            params![note_id],
            |r| r.get(0),
        )
        .optional()?;
    if note_kind != Some(NoteKind::Markdown) {
        return Ok(0);
    }

    // Assets this note referenced before the rebuild. Anything that drops off
    // the list is a deletion candidate, but only once no OTHER note claims it
    // — which is the whole reason `asset_refs` exists.
    let previous: Vec<String> = {
        let mut stmt = conn.prepare("SELECT asset_id FROM asset_refs WHERE note_id = ?1")?;
        let rows = stmt.query_map(params![note_id], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let refs = asset_reference_counts(conn, note_id)?;
    conn.execute(
        "DELETE FROM asset_refs WHERE note_id = ?1",
        params![note_id],
    )?;
    for asset_id in refs.keys() {
        // INSERT OR IGNORE tolerates ids that point at assets which no longer
        // exist (a body pasted in from another vault); the FK would otherwise
        // fail the whole sweep over one dead link.
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM assets WHERE id = ?1",
                params![asset_id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if exists {
            add_ref(conn, asset_id, note_id)?;
        }
    }

    // Candidates: rows this note just released, plus rows it created that
    // never had a body reference at all.
    let mut candidates: Vec<String> = previous
        .into_iter()
        .filter(|id| !refs.contains_key(id))
        .collect();
    {
        let mut stmt = conn.prepare("SELECT id FROM assets WHERE owning_note_id = ?1")?;
        let rows = stmt.query_map(params![note_id], |r| r.get::<_, String>(0))?;
        for row in rows {
            let id = row?;
            if !refs.contains_key(&id) && !candidates.contains(&id) {
                candidates.push(id);
            }
        }
    }

    let mut removed = 0usize;
    for asset_id in candidates {
        let still_referenced: bool = conn
            .query_row(
                "SELECT 1 FROM asset_refs WHERE asset_id = ?1 LIMIT 1",
                params![asset_id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if still_referenced {
            continue;
        }
        removed += delete_asset(conn, &asset_id)?;
    }
    Ok(removed)
}

/// Reconcile every markdown note's references, then free whatever nothing
/// points at any more. Runs from the history-retention pass.
pub(crate) fn sweep_unreferenced_markdown_assets_inner(conn: &Connection) -> AppResult<usize> {
    let note_ids = {
        let mut stmt = conn.prepare(
            "SELECT id FROM notes
             WHERE note_kind = 'markdown'",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let mut removed = 0usize;
    for note_id in note_ids {
        removed += purge_unreferenced_markdown_assets(conn, &note_id)?;
    }

    // Assets orphaned by a path that never ran release_note_assets — notably
    // a folder delete, where SQLite cascades the notes away and the FK just
    // nulls `owning_note_id`. Nothing references these and no note-keyed pass
    // above would ever look at them.
    let orphans: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT a.id FROM assets a
             WHERE a.owning_note_id IS NULL
               AND NOT EXISTS (SELECT 1 FROM asset_refs r WHERE r.asset_id = a.id)",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for asset_id in orphans {
        removed += delete_asset(conn, &asset_id)?;
    }

    Ok(removed)
}

/// Fill in `content_hash` for rows that predate migration 25.
///
/// SQLite has no hashing function, so the migration leaves the column NULL and
/// this runs once afterwards. Until a row is hashed it simply never matches a
/// dedup lookup, so a partial failure costs storage, never correctness.
///
/// Bytes are fetched one row at a time rather than in one query: an asset can
/// be tens of megabytes and the whole point is to keep peak memory to a single
/// blob.
pub(crate) fn backfill_content_hashes(conn: &Connection) -> AppResult<usize> {
    let pending: Vec<String> = {
        // Served by idx_assets_unhashed, so the steady-state check after the
        // backfill has run is an empty index probe, not a table scan.
        let mut stmt = conn.prepare("SELECT id FROM assets WHERE content_hash IS NULL")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    if pending.is_empty() {
        return Ok(0);
    }
    log::info!("[assets] hashing {} pre-existing asset(s)", pending.len());

    let mut hashed = 0usize;
    for id in pending {
        let bytes: Option<Vec<u8>> = conn
            .query_row("SELECT bytes FROM assets WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .optional()?;
        let Some(bytes) = bytes else { continue };
        conn.execute(
            "UPDATE assets SET content_hash = ?1 WHERE id = ?2",
            params![content_hash(&bytes), id],
        )?;
        hashed += 1;
    }
    Ok(hashed)
}

// ---------- Tauri commands ----------

#[tauri::command]
pub fn upload_drawing_asset(db: tauri::State<'_, Db>, input: UploadAsset) -> CommandResult<Asset> {
    db.with_conn(|c| upload(c, input)).map_err(Into::into)
}

#[tauri::command]
pub fn fetch_drawing_asset(db: tauri::State<'_, Db>, id: String) -> CommandResult<Asset> {
    db.with_conn(|c| load(c, &id)).map_err(Into::into)
}

#[tauri::command]
pub fn import_pdf_note(db: tauri::State<'_, Db>, input: ImportPdfNote) -> CommandResult<Note> {
    db.with_conn(|c| import_pdf_note_inner(c, input))
        .map_err(Into::into)
}

#[tauri::command]
pub fn sweep_unreferenced_markdown_assets(db: tauri::State<'_, Db>) -> CommandResult<usize> {
    db.with_conn(sweep_unreferenced_markdown_assets_inner)
        .map_err(Into::into)
}

#[cfg(test)]
mod tests;
