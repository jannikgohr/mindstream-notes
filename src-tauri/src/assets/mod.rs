//! Asset blobs attached to freeform (drawing) notes.
//!
//! Each asset is the raw byte payload of an image (or, later, any file the
//! user drops onto a drawing canvas). The frontend can store
//! `mindstream-asset://<id>` URLs inside drawing records and call
//! `fetch_drawing_asset` to materialise those into blob URLs at render time.
//!
//! Sync model: the table has the same `dirty` / `etebase_uid` /
//! `etebase_etag` columns as `notes`, but the actual push / pull
//! implementation lives in the follow-up slice. For now uploads land
//! locally with `dirty = 1` so when sync ships nothing needs migrating.

use std::collections::HashMap;
use std::sync::OnceLock;

use chrono::Utc;
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::notes::{self, CreateNote, Note};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetSummary {
    pub id: String,
    pub owning_note_id: String,
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

pub fn upload(conn: &Connection, input: UploadAsset) -> AppResult<Asset> {
    let id = format!("asset_{}", uuid::Uuid::new_v4());
    upload_with_id(conn, id, input)
}

pub fn upload_with_id(conn: &Connection, id: String, input: UploadAsset) -> AppResult<Asset> {
    // Confirm the owning note exists first — the FK constraint would
    // surface as a generic SQLite error otherwise. A targeted NotFound
    // gives the JS side a useful message to relay if the user trashes
    // the note between the drop and the upload landing.
    let note_exists: bool = conn
        .query_row(
            "SELECT 1 FROM notes WHERE id = ?1",
            params![input.owning_note_id],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if !note_exists {
        return Err(AppError::NotFound(format!(
            "note {} (asset upload)",
            input.owning_note_id
        )));
    }

    let now = Utc::now().to_rfc3339();
    let size = input.bytes.len() as i64;

    conn.execute(
        "INSERT INTO assets(id, owning_note_id, mime_type, bytes, size,
                            created, modified)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![
            id,
            input.owning_note_id,
            input.mime_type,
            input.bytes,
            size,
            now,
        ],
    )?;
    load(conn, &id)
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
            note_kind: Some("pdf".into()),
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

fn asset_url_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"asset:mindstream/([A-Za-z0-9_-]+)").unwrap())
}

fn count_asset_refs(body: &str, counts: &mut HashMap<String, usize>) {
    for captures in asset_url_re().captures_iter(body) {
        if let Some(id) = captures.get(1) {
            *counts.entry(id.as_str().to_string()).or_default() += 1;
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
    let current: Option<(String, String)> = conn
        .query_row(
            "SELECT note_kind, body FROM notes WHERE id = ?1",
            params![note_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((note_kind, body)) = current else {
        return Ok(counts);
    };
    count_asset_refs(&body, &mut counts);

    if note_kind != "markdown" {
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

pub(crate) fn purge_unreferenced_markdown_assets(
    conn: &Connection,
    note_id: &str,
) -> AppResult<usize> {
    let note_kind: Option<String> = conn
        .query_row(
            "SELECT note_kind FROM notes WHERE id = ?1",
            params![note_id],
            |r| r.get(0),
        )
        .optional()?;
    if note_kind.as_deref() != Some("markdown") {
        return Ok(0);
    }

    let refs = asset_reference_counts(conn, note_id)?;
    let mut stmt = conn.prepare(
        "SELECT id, etebase_uid FROM assets
         WHERE owning_note_id = ?1",
    )?;
    let rows = stmt.query_map(params![note_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
    })?;
    let assets = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    let mut removed = 0usize;
    for (asset_id, etebase_uid) in assets {
        if refs.contains_key(&asset_id) {
            continue;
        }
        if let Some(uid) = etebase_uid {
            crate::sync::queue_tombstone(conn, "asset", &uid)?;
        }
        removed += conn.execute("DELETE FROM assets WHERE id = ?1", params![asset_id])?;
    }
    Ok(removed)
}

// ---------- Tauri commands ----------

#[tauri::command]
pub fn upload_drawing_asset(db: tauri::State<'_, Db>, input: UploadAsset) -> Result<Asset, String> {
    db.with_conn(|c| upload(c, input)).map_err(Into::into)
}

#[tauri::command]
pub fn fetch_drawing_asset(db: tauri::State<'_, Db>, id: String) -> Result<Asset, String> {
    db.with_conn(|c| load(c, &id)).map_err(Into::into)
}

#[tauri::command]
pub fn import_pdf_note(db: tauri::State<'_, Db>, input: ImportPdfNote) -> Result<Note, String> {
    db.with_conn(|c| import_pdf_note_inner(c, input))
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory_for_tests;
    use crate::notes::{create as create_note, update as update_note, CreateNote, UpdateNote};

    fn make_note(db: &Db) -> String {
        db.with_conn(|c| {
            create_note(
                c,
                CreateNote {
                    title: Some("Drawing".into()),
                    body: None,
                    parent_collection_id: None,
                    note_kind: Some("freeform".into()),
                },
            )
        })
        .unwrap()
        .summary
        .id
    }

    fn make_markdown_note(db: &Db) -> String {
        db.with_conn(|c| {
            create_note(
                c,
                CreateNote {
                    title: Some("Markdown".into()),
                    body: Some(String::new()),
                    parent_collection_id: None,
                    note_kind: Some("markdown".into()),
                },
            )
        })
        .unwrap()
        .summary
        .id
    }

    #[test]
    fn upload_then_fetch_round_trip() {
        let db = open_memory_for_tests();
        let note_id = make_note(&db);
        let bytes = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]; // PNG header
        let asset = db
            .with_conn(|c| {
                upload(
                    c,
                    UploadAsset {
                        owning_note_id: note_id.clone(),
                        mime_type: "image/png".into(),
                        bytes: bytes.clone(),
                    },
                )
            })
            .unwrap();
        assert_eq!(asset.summary.owning_note_id, note_id);
        assert_eq!(asset.summary.mime_type, "image/png");
        assert_eq!(asset.summary.size, bytes.len() as i64);
        assert!(!asset.summary.pushed);
        assert_eq!(asset.bytes, bytes);

        let loaded = db.with_conn(|c| load(c, &asset.summary.id)).unwrap();
        assert_eq!(loaded.bytes, bytes);
    }

    #[test]
    fn upload_rejects_missing_note() {
        let db = open_memory_for_tests();
        let res = db.with_conn(|c| {
            upload(
                c,
                UploadAsset {
                    owning_note_id: "note_does_not_exist".into(),
                    mime_type: "image/png".into(),
                    bytes: vec![1, 2, 3],
                },
            )
        });
        match res {
            Err(AppError::NotFound(_)) => {}
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn purging_owning_note_cascades_to_assets() {
        // The ON DELETE CASCADE on owning_note_id is what cleans up after
        // a freeform note is purged from trash. Sync-tombstone-on-asset
        // is a slice 2b concern; for now we just want the local rows to
        // disappear together.
        let db = open_memory_for_tests();
        let note_id = make_note(&db);
        let asset = db
            .with_conn(|c| {
                upload(
                    c,
                    UploadAsset {
                        owning_note_id: note_id.clone(),
                        mime_type: "image/png".into(),
                        bytes: vec![1, 2, 3],
                    },
                )
            })
            .unwrap();

        db.with_conn(|c| crate::notes::purge(c, &note_id)).unwrap();

        let res = db.with_conn(|c| load(c, &asset.summary.id));
        assert!(res.is_err(), "asset should be gone after owning note purge");
    }

    #[test]
    fn fetch_unknown_id_is_not_found() {
        let db = open_memory_for_tests();
        let res = db.with_conn(|c| load(c, "asset_nope"));
        match res {
            Err(AppError::NotFound(_)) => {}
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn import_pdf_creates_pdf_note_with_separate_asset() {
        let db = open_memory_for_tests();
        let pdf_bytes = b"%PDF-1.7\n%mindstream-test\n".to_vec();
        let note = db
            .with_conn(|c| {
                import_pdf_note_inner(
                    c,
                    ImportPdfNote {
                        title: Some("Paper".into()),
                        parent_collection_id: None,
                        bytes: pdf_bytes.clone(),
                    },
                )
            })
            .unwrap();

        assert_eq!(note.summary.title, "Paper");
        assert_eq!(note.summary.note_kind, "pdf");
        assert!(note.yrs_state.is_empty());
        let pointer: serde_json::Value = serde_json::from_str(&note.body).unwrap();
        let asset_id = pointer["pdfAssetId"].as_str().unwrap();

        let asset = db.with_conn(|c| load(c, asset_id)).unwrap();
        assert_eq!(asset.summary.owning_note_id, note.summary.id);
        assert_eq!(asset.summary.mime_type, "application/pdf");
        assert_eq!(asset.bytes, pdf_bytes);
    }

    #[test]
    fn import_pdf_rejects_empty_bytes() {
        let db = open_memory_for_tests();

        let res = db.with_conn(|c| {
            import_pdf_note_inner(
                c,
                ImportPdfNote {
                    title: Some("Empty".into()),
                    parent_collection_id: None,
                    bytes: vec![],
                },
            )
        });

        let err = res.expect_err("empty PDF import should fail");
        assert!(matches!(
            err,
            AppError::InvalidArg(message) if message.contains("PDF file is empty")
        ));
    }

    #[test]
    fn asset_reference_counts_reads_pdf_asset_id_from_json_body() {
        let db = open_memory_for_tests();
        let note = db
            .with_conn(|c| {
                import_pdf_note_inner(
                    c,
                    ImportPdfNote {
                        title: Some("Paper".into()),
                        parent_collection_id: None,
                        bytes: b"%PDF-1.7\n%mindstream-test\n".to_vec(),
                    },
                )
            })
            .unwrap();

        let pointer: serde_json::Value = serde_json::from_str(&note.body).unwrap();
        let asset_id = pointer["pdfAssetId"].as_str().unwrap();

        let refs = db
            .with_conn(|c| asset_reference_counts(c, &note.summary.id))
            .unwrap();
        assert_eq!(refs.get(asset_id), Some(&1));
    }

    #[test]
    fn purge_unreferenced_markdown_assets_is_noop_for_non_markdown_notes() {
        let db = open_memory_for_tests();
        let note_id = make_note(&db);
        let asset = db
            .with_conn(|c| {
                upload(
                    c,
                    UploadAsset {
                        owning_note_id: note_id.clone(),
                        mime_type: "image/png".into(),
                        bytes: vec![1, 2, 3],
                    },
                )
            })
            .unwrap();

        let removed = db
            .with_conn(|c| purge_unreferenced_markdown_assets(c, &note_id))
            .unwrap();

        assert_eq!(removed, 0);
        assert!(db.with_conn(|c| load(c, &asset.summary.id)).is_ok());
    }

    #[test]
    fn markdown_cleanup_deletes_unreferenced_asset_without_history_ref() {
        let db = open_memory_for_tests();
        let note_id = make_markdown_note(&db);
        let asset = db
            .with_conn(|c| {
                upload(
                    c,
                    UploadAsset {
                        owning_note_id: note_id.clone(),
                        mime_type: "image/png".into(),
                        bytes: vec![1, 2, 3],
                    },
                )
            })
            .unwrap();

        db.with_conn_mut(|c| {
            update_note(
                c,
                UpdateNote {
                    id: note_id.clone(),
                    title: None,
                    body: Some(format!("![](asset:mindstream/{})", asset.summary.id)),
                    parent_collection_id: None,
                    position: None,
                    tags: None,
                    yrs_state: None,
                    favourite: None,
                },
            )
        })
        .unwrap();
        db.with_conn_mut(|c| {
            update_note(
                c,
                UpdateNote {
                    id: note_id.clone(),
                    title: None,
                    body: Some("removed".into()),
                    parent_collection_id: None,
                    position: None,
                    tags: None,
                    yrs_state: None,
                    favourite: None,
                },
            )
        })
        .unwrap();

        let res = db.with_conn(|c| load(c, &asset.summary.id));
        assert!(res.is_err(), "asset with no live/history refs is deleted");
    }

    #[test]
    fn markdown_cleanup_keeps_history_referenced_asset_until_history_pruned() {
        let db = open_memory_for_tests();
        let note_id = make_markdown_note(&db);
        let asset = db
            .with_conn(|c| {
                upload(
                    c,
                    UploadAsset {
                        owning_note_id: note_id.clone(),
                        mime_type: "image/png".into(),
                        bytes: vec![1, 2, 3],
                    },
                )
            })
            .unwrap();
        let body = format!("![](asset:mindstream/{})", asset.summary.id);
        let version = db
            .with_conn(|c| crate::history::capture(c, &note_id, "markdown", "edited", None, &body))
            .unwrap()
            .unwrap();

        db.with_conn_mut(|c| {
            update_note(
                c,
                UpdateNote {
                    id: note_id.clone(),
                    title: None,
                    body: Some("removed".into()),
                    parent_collection_id: None,
                    position: None,
                    tags: None,
                    yrs_state: None,
                    favourite: None,
                },
            )
        })
        .unwrap();
        assert!(
            db.with_conn(|c| load(c, &asset.summary.id)).is_ok(),
            "history snapshot keeps the asset alive"
        );

        let old = (Utc::now() - chrono::Duration::days(100)).to_rfc3339();
        db.with_conn(|c| {
            c.execute(
                "UPDATE note_versions SET created = ?2 WHERE id = ?1",
                params![version.id, old],
            )?;
            Ok(())
        })
        .unwrap();
        db.with_conn(|c| crate::history::prune(c, Some(90)))
            .unwrap();

        let res = db.with_conn(|c| load(c, &asset.summary.id));
        assert!(
            res.is_err(),
            "asset is deleted once the last history reference is pruned"
        );
    }
}
