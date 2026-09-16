//! One-shot conversion of literal `[[wikilinks]]` in existing notes into
//! ID-backed note links.
//!
//! # Why this exists
//!
//! A note link is `[Title](mindstream://note/<id>)`. Bodies written before
//! that, or pasted in from elsewhere, can still contain a bare `[[Title]]`,
//! and the editor supports those by resolving the title at click time
//! (`resolveNoteIdByTitle` in
//! `src/lib/editor/plugins/prose/wikilink/note-resolve.ts`). That fallback is
//! guesswork: on a title collision it picks the most recently modified match,
//! so the same link can lead to different notes on different days, and a
//! renamed target breaks silently.
//!
//! The importer no longer produces literal wikilinks, so old content is the
//! only remaining source of them. This pass converts what is left, which is
//! what allows the runtime fallback to be retired.
//!
//! # Why it is opt-in
//!
//! It rewrites note bodies. Each rewrite is a CRDT edit through
//! `yrs_doc::apply_local_edit` and marks the row dirty, so a vault-wide run
//! is a vault-wide sync push. That is the user's call to make, not something
//! to do behind their back on startup.
//!
//! Links whose title matches nothing are left exactly as they are. Turning
//! `[[Some note]]` into plain text would destroy the author's intent for a
//! note they might still create.

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::error::{AppResult, CommandResult};
use crate::notes::{self, NoteKind, UpdateNote};

use super::links::{self, LinkIndex, RewriteContext, RewriteOptions, RewriteStats};
use super::model::{AliasTier, UnresolvedLinks};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct LegacyLinkReport {
    /// Markdown notes examined.
    pub notes_scanned: usize,
    /// Notes whose body actually changed.
    pub notes_converted: usize,
    /// Individual `[[…]]` spans turned into note links.
    pub links_converted: usize,
    /// Spans left alone because no note had that title.
    pub links_unresolved: usize,
}

/// Rewrite every resolvable literal wikilink in the vault.
pub fn convert_legacy_wikilinks(db: &Db) -> AppResult<LegacyLinkReport> {
    // Build the title index from live notes only. A trashed note is deleted
    // from the user's point of view, and letting one claim a title would send
    // links into the trash.
    let mut index = LinkIndex::new(UnresolvedLinks::PlainText);
    let candidates: Vec<(String, String)> = db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, title FROM notes
             WHERE trashed_at IS NULL AND note_kind = 'markdown'
             ORDER BY modified DESC, id",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })?;
    for (id, title) in &candidates {
        // Most-recently-modified first, and first registration wins per tier,
        // so a title collision resolves the same way the editor's fallback
        // did — except now it is decided once and written down.
        index.register(AliasTier::Title, title, id);
        index.register(
            AliasTier::NormalizedTitle,
            &links::normalize_title(title),
            id,
        );
    }

    // Only notes that contain `[[` can have anything to convert, and on a
    // large vault that filter is the difference between reading every body
    // and reading a handful.
    let with_brackets: Vec<(String, String)> = db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, body FROM notes
             WHERE trashed_at IS NULL AND note_kind = 'markdown'
               AND body LIKE '%[[%'",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })?;

    let mut report = LegacyLinkReport {
        notes_scanned: with_brackets.len(),
        ..Default::default()
    };
    let context = RewriteContext {
        options: RewriteOptions {
            wikilinks: true,
            markdown_links: false,
            id_links: false,
            evernote_links: false,
            keep_unresolved_wikilinks: true,
        },
        base_dir: String::new(),
    };

    for (id, body) in with_brackets {
        let mut stats = RewriteStats::default();
        let rewritten = links::rewrite_links(&body, &mut index, &context, &mut stats);
        report.links_converted += stats.resolved;
        report.links_unresolved += stats.unresolved;
        if rewritten == body {
            continue;
        }
        // Through notes::update rather than a raw UPDATE: the body change has
        // to reach the CRDT and mark the row for sync, exactly as a user edit
        // would.
        db.with_conn_mut(|conn| {
            notes::update(
                conn,
                UpdateNote {
                    id: id.clone(),
                    title: None,
                    body: Some(rewritten.clone()),
                    parent_collection_id: None,
                    position: None,
                    tags: None,
                    yrs_state: None,
                    favourite: None,
                },
            )
        })?;
        report.notes_converted += 1;
    }
    Ok(report)
}

/// How many notes the conversion would look at, for the confirm dialog.
pub fn count_legacy_wikilink_notes(db: &Db) -> AppResult<usize> {
    db.with_conn(|conn| {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM notes
             WHERE trashed_at IS NULL AND note_kind = ?1 AND body LIKE '%[[%'",
            params![NoteKind::Markdown],
            |r| r.get(0),
        )?;
        Ok(count as usize)
    })
}

#[tauri::command]
pub fn legacy_wikilink_count(db: tauri::State<'_, Db>) -> CommandResult<usize> {
    count_legacy_wikilink_notes(&db).map_err(Into::into)
}

#[tauri::command]
pub async fn convert_legacy_wikilinks_command(
    app: tauri::AppHandle,
) -> CommandResult<LegacyLinkReport> {
    use tauri::Manager;
    // A vault-wide body rewrite is far too much work for the command thread.
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Db>();
        convert_legacy_wikilinks(&db)
    })
    .await
    .map_err(|err| crate::error::AppError::InvalidArg(err.to_string()))?
    .map_err(Into::into)
}
