//! Typed operations used by the browser worker. All writes use the same
//! repositories as native commands, including CRDT and attachment bookkeeping.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::{
    assets, collections, content_stats, demo_notes, history, notes, search, signatures, tree_batch,
};

#[derive(Deserialize)]
#[serde(
    tag = "command",
    content = "args",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum VaultRequest {
    LoadTree {},
    ListNotes {
        #[serde(default)]
        include_trashed: bool,
    },
    LoadNote {
        id: String,
    },
    CreateNote {
        input: notes::CreateNote,
    },
    SaveNote {
        input: notes::UpdateNote,
    },
    TrashNote {
        id: String,
    },
    RestoreNote {
        id: String,
    },
    PurgeNote {
        id: String,
    },
    ListCollections {},
    CreateCollection {
        input: collections::CreateCollection,
    },
    UpdateCollection {
        input: collections::UpdateCollection,
    },
    DeleteCollection {
        id: String,
    },
    SearchNotes {
        query: String,
    },
    NoteWordCount {
        note_id: String,
    },
    MoveMany {
        items: Vec<tree_batch::TreeItemRef>,
        target_collection_id: Option<String>,
    },
    TrashMany {
        items: Vec<tree_batch::TreeItemRef>,
    },
    RestoreMany {
        items: Vec<tree_batch::TreeItemRef>,
    },
    PurgeMany {
        items: Vec<tree_batch::TreeItemRef>,
    },
    UploadDrawingAsset {
        input: assets::UploadAsset,
    },
    FetchDrawingAsset {
        id: String,
    },
    ImportPdfNote {
        input: assets::ImportPdfNote,
    },
    ImportInkPdfNote {
        input: assets::ImportInkPdfNote,
    },
    SweepUnreferencedMarkdownAssets {},
    CaptureNoteVersion {
        note_id: String,
        note_kind: notes::NoteKind,
        action: history::VersionAction,
        ref_version_id: Option<String>,
        markdown: String,
    },
    CaptureCurrentNoteVersion {
        note_id: String,
        action: history::VersionAction,
        ref_version_id: Option<String>,
    },
    ListNoteVersions {
        note_id: String,
    },
    LoadNoteVersion {
        version_id: String,
    },
    PruneNoteVersions {
        retention_days: Option<u32>,
    },
    ListSignatures {},
    SaveSignature {
        input: signatures::SaveSignature,
    },
    DeleteSignature {
        id: String,
    },
    InsertDemoNotes {
        notes: Vec<demo_notes::DemoNote>,
    },
    TrashCounts {},
    EmptyTrash {},
    PdfNotesMissingText {},
    PdfNoteNeedsText {
        note_id: String,
    },
    SetPdfText {
        note_id: String,
        text: String,
        expected_signature: Option<String>,
    },
    PdfPageText {
        asset_id: String,
        page_index: u32,
        text: Option<String>,
    },
}

fn result<T: Serialize>(value: T) -> AppResult<Value> {
    serde_json::to_value(value)
        .map_err(|e| AppError::InvalidArg(format!("Cannot encode response: {e}")))
}

pub fn dispatch(conn: &mut Connection, request: VaultRequest) -> AppResult<Value> {
    use VaultRequest::*;
    match request {
        LoadTree {} => {
            Ok(json!({"collections": collections::list(conn)?, "notes": notes::list(conn, false)?}))
        }
        ListNotes { include_trashed } => result(notes::list(conn, include_trashed)?),
        LoadNote { id } => result(notes::load(conn, &id)?),
        CreateNote { input } => result(notes::create(conn, input)?),
        SaveNote { input } => result(notes::update(conn, input)?),
        TrashNote { id } => result(notes::trash(conn, &id)?),
        RestoreNote { id } => result(notes::restore(conn, &id)?),
        PurgeNote { id } => result(notes::purge(conn, &id)?),
        ListCollections {} => result(collections::list(conn)?),
        CreateCollection { input } => result(collections::create(conn, input)?),
        UpdateCollection { input } => result(collections::update(conn, input)?),
        DeleteCollection { id } => result(collections::delete(conn, &id)?),
        SearchNotes { query } => result(search::search(conn, &query)?),
        NoteWordCount { note_id } => result(content_stats::note_word_count_inner(conn, &note_id)?),
        MoveMany {
            items,
            target_collection_id,
        } => result(tree_batch::move_many_items(
            conn,
            items,
            target_collection_id,
        )?),
        TrashMany { items } => result(tree_batch::move_many_items(
            conn,
            items,
            Some(collections::TRASH_ID.into()),
        )?),
        RestoreMany { items } => result(tree_batch::move_many_items(conn, items, None)?),
        PurgeMany { items } => result(tree_batch::purge_many_items(conn, items)?),
        UploadDrawingAsset { input } => result(assets::upload(conn, input)?),
        FetchDrawingAsset { id } => result(assets::load(conn, &id)?),
        ImportPdfNote { input } => result(assets::import_pdf_note_inner(conn, input)?),
        ImportInkPdfNote { input } => result(assets::import_ink_pdf_note_inner(conn, input)?),
        SweepUnreferencedMarkdownAssets {} => {
            result(assets::sweep_unreferenced_markdown_assets_inner(conn)?)
        }
        CaptureNoteVersion {
            note_id,
            note_kind,
            action,
            ref_version_id,
            markdown,
        } => result(history::capture(
            conn,
            &note_id,
            note_kind,
            action,
            ref_version_id.as_deref(),
            &markdown,
        )?),
        CaptureCurrentNoteVersion {
            note_id,
            action,
            ref_version_id,
        } => {
            let (kind, snapshot) = history::current_note_snapshot(conn, &note_id)?;
            result(history::capture(
                conn,
                &note_id,
                kind,
                action,
                ref_version_id.as_deref(),
                &snapshot,
            )?)
        }
        ListNoteVersions { note_id } => result(history::list(conn, &note_id)?),
        LoadNoteVersion { version_id } => result(history::load(conn, &version_id)?),
        PruneNoteVersions { retention_days } => result(history::prune(conn, retention_days)?),
        ListSignatures {} => result(signatures::list(conn)?),
        SaveSignature { input } => result(signatures::upsert(conn, input)?),
        DeleteSignature { id } => result(signatures::delete(conn, &id)?),
        InsertDemoNotes { notes } => {
            let tx = conn.transaction()?;
            let ids = demo_notes::insert(&tx, &notes, &chrono::Utc::now().to_rfc3339())?;
            tx.commit()?;
            result(ids)
        }
        TrashCounts {} => result(crate::trash::counts(conn)?),
        EmptyTrash {} => result(crate::trash::empty(conn)?),
        PdfNotesMissingText {} => result(crate::pdf_text::notes_missing_text(conn)?),
        PdfNoteNeedsText { note_id } => result(crate::pdf_text::note_needs_text(conn, &note_id)?),
        SetPdfText {
            note_id,
            text,
            expected_signature,
        } => {
            if let Some(signature) = expected_signature {
                crate::pdf_text::store_ink_text(conn, &note_id, &text, &signature)?;
            } else {
                crate::pdf_text::store_text(conn, &note_id, &text)?;
            }
            result(())
        }
        PdfPageText {
            asset_id,
            page_index,
            text,
        } => {
            if let Some(text) = text {
                conn.execute("INSERT OR REPLACE INTO pdf_page_text(asset_id, page_index, text) VALUES (?1, ?2, ?3)", params![asset_id, page_index, text])?;
            }
            result(conn.query_row("SELECT text FROM pdf_page_text WHERE asset_id = ?1 AND page_index = ?2 AND extraction_version = 1", params![asset_id, page_index], |r|r.get::<_,String>(0)).optional()?)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(conn: &mut Connection, command: &str, args: Value) -> AppResult<Value> {
        dispatch(
            conn,
            serde_json::from_value(json!({"command": command, "args": args})).unwrap(),
        )
    }

    #[test]
    fn protocol_updates_share_transactions_and_preserve_metadata() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::migrations::run(&mut conn).unwrap();
        let note = call(
            &mut conn,
            "create_note",
            json!({"input":{"title":"Original"}}),
        )
        .unwrap();
        let id = note["id"].as_str().unwrap();
        call(&mut conn, "save_note", json!({"input":{"id":id,"body":"committed document","tags":["durable"],"favourite":true}})).unwrap();
        assert!(call(&mut conn, "save_note", json!({"input":{"id":id,"title":"Must roll back","body":"Must roll back","parent_collection_id":"missing"}})).is_err());
        let loaded = call(&mut conn, "load_note", json!({"id":id})).unwrap();
        assert_eq!(loaded["title"], "Original");
        assert_eq!(loaded["body"], "committed document");
        assert_eq!(loaded["tags"], json!(["durable"]));
        assert_eq!(loaded["favourite"], true);
        assert_eq!(
            call(&mut conn, "search_notes", json!({"query":"committed"}))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn requests_reject_unknown_commands_and_invalid_inputs_before_writing() {
        assert!(serde_json::from_value::<VaultRequest>(
            json!({"command":"execute_sql","args":{"sql":"DELETE FROM notes"}})
        )
        .is_err());
        assert!(serde_json::from_value::<VaultRequest>(
            json!({"command":"save_note","args":{"input":{"id":"note","yrs_state":"invalid"}}})
        )
        .is_err());
    }
}
