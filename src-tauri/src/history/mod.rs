//! Local, automatic note edit history.
//!
//! Each row in `note_versions` is a point-in-time snapshot of a note's rendered
//! markdown (DEFLATE-compressed). History is deliberately **local and not
//! synced** — every device keeps its own timeline. That's fine because a
//! *restore* is applied by the editor as a normal CRDT edit
//! (`collabServiceCtx.applyTemplate`), so the restored content converges across
//! devices through the existing sync/merge path; replaying an old `yrs_state`
//! blob would be a no-op (its state vector is a subset of the live doc's).
//!
//! Capture is driven from the frontend (idle debounce + on note close + on
//! create/restore). This module owns dedup, the per-version change magnitude
//! (via `similar`), compression, the per-note safety cap, and time-based
//! retention pruning.

use std::io::{Read, Write};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::Utc;
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::content_stats::{token_delta, word_delta};
use crate::db::Db;
use crate::error::{AppError, AppResult};

/// Hard cap on versions kept per note, independent of the time-based retention
/// setting — a safety valve against pathological churn within the window.
const MAX_VERSIONS_PER_NOTE: i64 = 200;
const SNAPSHOT_MARKER: &str = "mindstream-history-snapshot";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionSummary {
    pub id: String,
    pub note_id: String,
    pub created: String,
    pub note_kind: String,
    /// Why this version exists: `created` | `edited` | `reverted`.
    pub action: String,
    /// Future user-named bookmark; always None for now.
    pub label: Option<String>,
    /// For `reverted`: the restore target's version id.
    pub ref_version_id: Option<String>,
    /// For `reverted`: the target's timestamp, denormalised so the
    /// "Reverted to {date}" label survives the target being pruned.
    pub ref_created: Option<String>,
    pub words_added: i64,
    pub words_removed: i64,
    /// Fallback magnitude for word-neutral edits: non-whitespace characters
    /// added/removed vs the previous snapshot (formatting, punctuation, …).
    pub tokens_added: i64,
    pub tokens_removed: i64,
    /// Uncompressed markdown byte length.
    pub size: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Version {
    #[serde(flatten)]
    pub summary: VersionSummary,
    /// Decompressed markdown snapshot.
    pub body: String,
}

fn compress(md: &str) -> AppResult<Vec<u8>> {
    let mut enc = DeflateEncoder::new(Vec::new(), Compression::default());
    enc.write_all(md.as_bytes())?;
    Ok(enc.finish()?)
}

fn decompress(bytes: &[u8]) -> AppResult<String> {
    let mut out = String::new();
    DeflateDecoder::new(bytes).read_to_string(&mut out)?;
    Ok(out)
}

fn serialize_yjs_snapshot(note_kind: &str, bytes: &[u8]) -> AppResult<String> {
    Ok(serde_json::json!({
        "marker": SNAPSHOT_MARKER,
        "version": 1,
        "noteKind": note_kind,
        "payloadKind": "yjs-update",
        "encoding": "base64",
        "data": BASE64_STANDARD.encode(bytes),
    })
    .to_string())
}

fn current_note_snapshot(conn: &Connection, note_id: &str) -> AppResult<(String, String)> {
    let row = conn
        .query_row(
            "SELECT note_kind, body, yrs_state FROM notes WHERE id = ?1",
            params![note_id],
            |r| {
                Ok((
                    r.get::<_, String>("note_kind")?,
                    r.get::<_, String>("body")?,
                    r.get::<_, Option<Vec<u8>>>("yrs_state")?,
                ))
            },
        )
        .optional()?;
    let Some((note_kind, body, yrs_state)) = row else {
        return Err(AppError::NotFound(format!("note {note_id}")));
    };
    let snapshot = if note_kind == "markdown" {
        body
    } else {
        serialize_yjs_snapshot(&note_kind, &yrs_state.unwrap_or_default())?
    };
    Ok((note_kind, snapshot))
}

fn row_to_summary(r: &Row<'_>) -> rusqlite::Result<VersionSummary> {
    Ok(VersionSummary {
        id: r.get("id")?,
        note_id: r.get("note_id")?,
        created: r.get("created")?,
        note_kind: r.get("note_kind")?,
        action: r.get("action")?,
        label: r.get("label")?,
        ref_version_id: r.get("ref_version_id")?,
        ref_created: r.get("ref_created")?,
        words_added: r.get("words_added")?,
        words_removed: r.get("words_removed")?,
        tokens_added: r.get("tokens_added")?,
        tokens_removed: r.get("tokens_removed")?,
        size: r.get("size")?,
    })
}

/// Capture a snapshot of `markdown` for `note_id`. Returns `None` when the
/// snapshot is a no-op (identical to the note's latest version). The first
/// version a note ever gets is promoted to `action = 'created'`.
pub fn capture(
    conn: &Connection,
    note_id: &str,
    note_kind: &str,
    action: &str,
    ref_version_id: Option<&str>,
    markdown: &str,
) -> AppResult<Option<VersionSummary>> {
    // Latest existing version — the dedup target and magnitude baseline.
    let latest: Option<Vec<u8>> = conn
        .query_row(
            "SELECT body FROM note_versions WHERE note_id = ?1
             ORDER BY created DESC, rowid DESC LIMIT 1",
            params![note_id],
            |r| r.get::<_, Vec<u8>>(0),
        )
        .optional()?;

    let prev_md = match &latest {
        Some(blob) => decompress(blob)?,
        None => String::new(),
    };

    // Dedup: unchanged content never creates a version.
    if latest.is_some() && prev_md == markdown {
        return Ok(None);
    }

    // The first snapshot of a note is its creation point.
    let action = if latest.is_none() { "created" } else { action };
    let (words_added, words_removed, tokens_added, tokens_removed) = if note_kind == "markdown" {
        let (words_added, words_removed) = word_delta(&prev_md, markdown);
        let (tokens_added, tokens_removed) = token_delta(&prev_md, markdown);
        (words_added, words_removed, tokens_added, tokens_removed)
    } else {
        // Non-markdown snapshots are encoded binary payloads. Running the
        // markdown word/char diff over a large base64 Yjs envelope can stall
        // the app for seconds or minutes, so use a cheap size delta instead.
        let prev_len = prev_md.len() as i64;
        let next_len = markdown.len() as i64;
        let tokens_added = (next_len - prev_len).max(0);
        let tokens_removed = (prev_len - next_len).max(0);
        (0, 0, tokens_added, tokens_removed)
    };

    // Denormalise the restore target's timestamp so the label outlives it.
    let ref_created: Option<String> = if action == "reverted" {
        match ref_version_id {
            Some(target) => conn
                .query_row(
                    "SELECT created FROM note_versions WHERE id = ?1",
                    params![target],
                    |r| r.get::<_, String>(0),
                )
                .optional()?,
            None => None,
        }
    } else {
        None
    };

    let id = format!("ver_{}", uuid::Uuid::new_v4());
    let created = Utc::now().to_rfc3339();
    let compressed = compress(markdown)?;
    let size = markdown.len() as i64;

    conn.execute(
        "INSERT INTO note_versions
            (id, note_id, created, note_kind, action, label, ref_version_id,
             ref_created, words_added, words_removed, tokens_added,
             tokens_removed, body, size)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            id,
            note_id,
            created,
            note_kind,
            action,
            ref_version_id,
            ref_created,
            words_added,
            words_removed,
            tokens_added,
            tokens_removed,
            compressed,
            size,
        ],
    )?;

    enforce_cap(conn, note_id)?;

    Ok(Some(VersionSummary {
        id,
        note_id: note_id.to_string(),
        created,
        note_kind: note_kind.to_string(),
        action: action.to_string(),
        label: None,
        ref_version_id: ref_version_id.map(str::to_string),
        ref_created,
        words_added,
        words_removed,
        tokens_added,
        tokens_removed,
        size,
    }))
}

/// Trim a note back to the newest `MAX_VERSIONS_PER_NOTE` versions.
fn enforce_cap(conn: &Connection, note_id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM note_versions
         WHERE note_id = ?1 AND id NOT IN (
            SELECT id FROM note_versions WHERE note_id = ?1
            ORDER BY created DESC, rowid DESC LIMIT ?2
         )",
        params![note_id, MAX_VERSIONS_PER_NOTE],
    )?;
    Ok(())
}

/// All versions for a note, newest first, without the (compressed) body.
pub fn list(conn: &Connection, note_id: &str) -> AppResult<Vec<VersionSummary>> {
    let mut stmt = conn.prepare(
        "SELECT id, note_id, created, note_kind, action, label, ref_version_id,
                ref_created, words_added, words_removed, tokens_added,
                tokens_removed, size
         FROM note_versions WHERE note_id = ?1
         ORDER BY created DESC, rowid DESC",
    )?;
    let rows = stmt.query_map(params![note_id], row_to_summary)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// One version with its decompressed markdown body.
pub fn load(conn: &Connection, version_id: &str) -> AppResult<Version> {
    let row = conn
        .query_row(
            "SELECT id, note_id, created, note_kind, action, label, ref_version_id,
                    ref_created, words_added, words_removed, tokens_added,
                    tokens_removed, size, body
             FROM note_versions WHERE id = ?1",
            params![version_id],
            |r| Ok((row_to_summary(r)?, r.get::<_, Vec<u8>>("body")?)),
        )
        .optional()?;
    match row {
        Some((summary, blob)) => Ok(Version {
            summary,
            body: decompress(&blob)?,
        }),
        None => Err(AppError::NotFound(format!("note version {version_id}"))),
    }
}

/// Delete versions older than `retention_days`. `None` = keep forever (no-op).
/// Returns the number of rows removed.
pub fn prune(conn: &Connection, retention_days: Option<u32>) -> AppResult<usize> {
    let Some(days) = retention_days else {
        return Ok(0);
    };
    let cutoff = (Utc::now() - chrono::Duration::days(days as i64)).to_rfc3339();
    let removed = conn.execute(
        "DELETE FROM note_versions WHERE created < ?1",
        params![cutoff],
    )?;
    Ok(removed)
}

// ---------- Tauri commands ----------

#[tauri::command]
pub async fn capture_note_version(
    app: AppHandle,
    note_id: String,
    note_kind: String,
    action: String,
    ref_version_id: Option<String>,
    markdown: String,
) -> Result<Option<VersionSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<VersionSummary>, String> {
        let db = app.state::<Db>();
        db.with_conn(|c| {
            capture(
                c,
                &note_id,
                &note_kind,
                &action,
                ref_version_id.as_deref(),
                &markdown,
            )
        })
        .map_err(Into::into)
    })
    .await
    .map_err(|e| format!("history capture task: {e}"))?
}

#[tauri::command]
pub async fn capture_current_note_version(
    app: AppHandle,
    note_id: String,
    action: String,
    ref_version_id: Option<String>,
) -> Result<Option<VersionSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<VersionSummary>, String> {
        let db = app.state::<Db>();
        db.with_conn(|c| {
            let (note_kind, snapshot) = current_note_snapshot(c, &note_id)?;
            capture(
                c,
                &note_id,
                &note_kind,
                &action,
                ref_version_id.as_deref(),
                &snapshot,
            )
        })
        .map_err(Into::into)
    })
    .await
    .map_err(|e| format!("history current capture task: {e}"))?
}

#[tauri::command]
pub async fn list_note_versions(
    app: AppHandle,
    note_id: String,
) -> Result<Vec<VersionSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<VersionSummary>, String> {
        let db = app.state::<Db>();
        db.with_conn(|c| list(c, &note_id)).map_err(Into::into)
    })
    .await
    .map_err(|e| format!("history list task: {e}"))?
}

#[tauri::command]
pub async fn load_note_version(app: AppHandle, version_id: String) -> Result<Version, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Version, String> {
        let db = app.state::<Db>();
        db.with_conn(|c| load(c, &version_id)).map_err(Into::into)
    })
    .await
    .map_err(|e| format!("history load task: {e}"))?
}

#[tauri::command]
pub async fn prune_note_versions(
    app: AppHandle,
    retention_days: Option<u32>,
) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<usize, String> {
        let db = app.state::<Db>();
        db.with_conn(|c| prune(c, retention_days))
            .map_err(Into::into)
    })
    .await
    .map_err(|e| format!("history prune task: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory_for_tests;
    use crate::notes::{create, CreateNote};

    fn make_note(db: &Db) -> String {
        db.with_conn(|c| {
            create(
                c,
                CreateNote {
                    title: Some("Doc".into()),
                    body: Some("hello".into()),
                    parent_collection_id: None,
                    note_kind: Some("markdown".into()),
                },
            )
        })
        .unwrap()
        .summary
        .id
    }

    fn cap(
        db: &Db,
        note: &str,
        action: &str,
        refv: Option<&str>,
        md: &str,
    ) -> Option<VersionSummary> {
        db.with_conn(|c| capture(c, note, "markdown", action, refv, md))
            .unwrap()
    }

    #[test]
    fn first_capture_is_promoted_to_created() {
        let db = open_memory_for_tests();
        let note = make_note(&db);
        let v = cap(&db, &note, "edited", None, "hello world").unwrap();
        assert_eq!(v.action, "created");
        // created vs empty baseline → 2 words added.
        assert_eq!(v.words_added, 2);
        assert_eq!(v.words_removed, 0);
    }

    #[test]
    fn identical_content_dedups() {
        let db = open_memory_for_tests();
        let note = make_note(&db);
        cap(&db, &note, "edited", None, "same text");
        let again = cap(&db, &note, "edited", None, "same text");
        assert!(
            again.is_none(),
            "unchanged snapshot must not create a version"
        );
        assert_eq!(db.with_conn(|c| list(c, &note)).unwrap().len(), 1);
    }

    #[test]
    fn formatting_only_edit_has_tokens_but_no_words() {
        let db = open_memory_for_tests();
        let note = make_note(&db);
        cap(&db, &note, "edited", None, "hello world");
        let v = cap(&db, &note, "edited", None, "**hello** world").unwrap();
        assert_eq!((v.words_added, v.words_removed), (0, 0));
        assert_eq!(v.tokens_added, 4); // four '*'
        assert_eq!(v.tokens_removed, 0);
    }

    #[test]
    fn non_markdown_capture_uses_size_delta_without_text_diff() {
        let db = open_memory_for_tests();
        let note = make_note(&db);
        let first = db
            .with_conn(|c| capture(c, &note, "freeform", "edited", None, "abc"))
            .unwrap()
            .unwrap();
        assert_eq!((first.words_added, first.words_removed), (0, 0));
        assert_eq!((first.tokens_added, first.tokens_removed), (3, 0));

        let second = db
            .with_conn(|c| capture(c, &note, "freeform", "edited", None, "a"))
            .unwrap()
            .unwrap();
        assert_eq!((second.words_added, second.words_removed), (0, 0));
        assert_eq!((second.tokens_added, second.tokens_removed), (0, 2));
    }

    #[test]
    fn current_non_markdown_snapshot_wraps_saved_yrs_state() {
        let db = open_memory_for_tests();
        let note = db
            .with_conn(|c| {
                create(
                    c,
                    CreateNote {
                        title: Some("Canvas".into()),
                        body: Some(String::new()),
                        parent_collection_id: None,
                        note_kind: Some("freeform".into()),
                    },
                )
            })
            .unwrap()
            .summary
            .id;
        db.with_conn(|c| {
            c.execute(
                "UPDATE notes SET yrs_state = ?2 WHERE id = ?1",
                rusqlite::params![&note, vec![1u8, 2, 3]],
            )?;
            Ok(())
        })
        .unwrap();

        let (kind, snapshot) = db
            .with_conn(|c| current_note_snapshot(c, &note))
            .expect("snapshot");
        let parsed: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        assert_eq!(kind, "freeform");
        assert_eq!(parsed["marker"], SNAPSHOT_MARKER);
        assert_eq!(parsed["noteKind"], "freeform");
        assert_eq!(parsed["payloadKind"], "yjs-update");
        assert_eq!(
            parsed["data"],
            base64::Engine::encode(&BASE64_STANDARD, [1u8, 2, 3])
        );
    }

    #[test]
    fn magnitude_counts_word_churn() {
        let db = open_memory_for_tests();
        let note = make_note(&db);
        cap(&db, &note, "edited", None, "alpha beta gamma");
        let v = cap(&db, &note, "edited", None, "alpha delta gamma epsilon").unwrap();
        assert_eq!(v.action, "edited");
        assert_eq!(v.words_added, 2); // delta, epsilon
        assert_eq!(v.words_removed, 1); // beta
    }

    #[test]
    fn compress_round_trips_through_load() {
        let db = open_memory_for_tests();
        let note = make_note(&db);
        let md = "# Heading\n\nA paragraph with *emphasis* and a list:\n- one\n- two\n";
        let v = cap(&db, &note, "edited", None, md).unwrap();
        let loaded = db.with_conn(|c| load(c, &v.id)).unwrap();
        assert_eq!(loaded.body, md);
    }

    #[test]
    fn revert_denormalises_target_timestamp() {
        let db = open_memory_for_tests();
        let note = make_note(&db);
        let target = cap(&db, &note, "edited", None, "original").unwrap();
        cap(&db, &note, "edited", None, "changed");
        let rev = cap(&db, &note, "reverted", Some(&target.id), "original").unwrap();
        assert_eq!(rev.action, "reverted");
        assert_eq!(rev.ref_version_id.as_deref(), Some(target.id.as_str()));
        assert_eq!(rev.ref_created.as_deref(), Some(target.created.as_str()));
    }

    #[test]
    fn list_is_newest_first() {
        let db = open_memory_for_tests();
        let note = make_note(&db);
        let a = cap(&db, &note, "edited", None, "one").unwrap();
        let b = cap(&db, &note, "edited", None, "two").unwrap();
        let ids: Vec<String> = db
            .with_conn(|c| list(c, &note))
            .unwrap()
            .into_iter()
            .map(|v| v.id)
            .collect();
        assert_eq!(ids, vec![b.id, a.id]);
    }

    #[test]
    fn prune_removes_old_and_forever_keeps_all() {
        let db = open_memory_for_tests();
        let note = make_note(&db);
        let v = cap(&db, &note, "edited", None, "content").unwrap();
        // Backdate it 100 days.
        let old = (Utc::now() - chrono::Duration::days(100)).to_rfc3339();
        db.with_conn(|c| {
            c.execute(
                "UPDATE note_versions SET created = ?2 WHERE id = ?1",
                params![v.id, old],
            )
            .map(|_| ())
            .map_err(Into::into)
        })
        .unwrap();

        // Forever (None) keeps it.
        assert_eq!(db.with_conn(|c| prune(c, None)).unwrap(), 0);
        assert_eq!(db.with_conn(|c| list(c, &note)).unwrap().len(), 1);

        // 90-day retention sweeps it.
        assert_eq!(db.with_conn(|c| prune(c, Some(90))).unwrap(), 1);
        assert!(db.with_conn(|c| list(c, &note)).unwrap().is_empty());
    }

    #[test]
    fn purging_note_cascades_to_versions() {
        let db = open_memory_for_tests();
        let note = make_note(&db);
        cap(&db, &note, "edited", None, "content");
        db.with_conn(|c| crate::notes::purge(c, &note)).unwrap();
        assert!(db.with_conn(|c| list(c, &note)).unwrap().is_empty());
    }
}
