//! Binary file IPC. A four-byte little-endian JSON length, JSON metadata,
//! then the original file bytes. Replies never echo uploaded blobs.
use serde::de::DeserializeOwned;
use serde::Deserialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::Manager;

use super::{AssetSummary, ImportPdfNote};
use crate::db::Db;
use crate::error::{AppError, AppResult, CommandError, CommandResult};
use crate::notes::Note;

fn decode<T: DeserializeOwned>(body: &InvokeBody) -> AppResult<(T, Vec<u8>)> {
    let mobile;
    let payload = match body {
        InvokeBody::Raw(bytes) => bytes.as_slice(),
        // Tauri's Android bridge converts raw request bodies to JSON arrays.
        InvokeBody::Json(value) => {
            mobile = serde_json::from_value::<Vec<u8>>(value.clone())
                .map_err(|e| AppError::InvalidArg(format!("Invalid file payload: {e}")))?;
            mobile.as_slice()
        }
    };
    let prefix: [u8; 4] = payload
        .get(..4)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| AppError::InvalidArg("Missing file metadata".into()))?;
    let length = u32::from_le_bytes(prefix) as usize;
    if length > 1_048_576 || length > payload.len() - 4 {
        return Err(AppError::InvalidArg("Invalid file metadata length".into()));
    }
    let metadata = serde_json::from_slice(&payload[4..4 + length])
        .map_err(|e| AppError::InvalidArg(format!("Invalid file metadata: {e}")))?;
    Ok((metadata, payload[4 + length..].to_vec()))
}

#[derive(Deserialize)]
struct UploadMetadata {
    owning_note_id: String,
    mime_type: String,
}

#[derive(Deserialize)]
struct PdfMetadata {
    title: Option<String>,
    parent_collection_id: Option<String>,
}

#[tauri::command]
pub async fn upload_asset_bytes<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: Request<'_>,
) -> CommandResult<AssetSummary> {
    let (metadata, bytes) = decode::<UploadMetadata>(request.body())?;
    let job = app.state::<crate::vault_jobs::Saves>().enter()?;
    tauri::async_runtime::spawn_blocking(move || -> CommandResult<AssetSummary> {
        let _job = job;
        app.state::<Db>()
            .with_conn(|conn| {
                let stored = super::store_deduped(
                    conn,
                    &metadata.owning_note_id,
                    &metadata.mime_type,
                    &bytes,
                )?;
                super::load_summary(conn, &stored.id)
            })
            .map_err(Into::into)
    })
    .await
    .map_err(|e| CommandError::task(format!("Asset upload task: {e}")))?
}

#[tauri::command]
pub async fn import_pdf_note_bytes<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: Request<'_>,
) -> CommandResult<Note> {
    let (metadata, bytes) = decode::<PdfMetadata>(request.body())?;
    let job = app.state::<crate::vault_jobs::Saves>().enter()?;
    tauri::async_runtime::spawn_blocking(move || -> CommandResult<Note> {
        let _job = job;
        app.state::<Db>()
            .with_conn(|conn| {
                super::import_pdf_note_inner(
                    conn,
                    ImportPdfNote {
                        title: metadata.title,
                        parent_collection_id: metadata.parent_collection_id,
                        bytes,
                    },
                )
            })
            .map_err(Into::into)
    })
    .await
    .map_err(|e| CommandError::task(format!("PDF import task: {e}")))?
}

#[tauri::command]
pub async fn fetch_asset_bytes<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    id: String,
    mime_type: Option<String>,
) -> CommandResult<Response> {
    tauri::async_runtime::spawn_blocking(move || -> CommandResult<Response> {
        app.state::<Db>()
            .with_conn(|conn| {
                let asset = super::load(conn, &id)?;
                if mime_type.is_some_and(|mime| mime != asset.summary.mime_type) {
                    return Err(AppError::InvalidArg(
                        "Stored file has an unexpected type.".into(),
                    ));
                }
                Ok(asset)
            })
            .map(|asset| Response::new(asset.bytes))
            .map_err(Into::into)
    })
    .await
    .map_err(|e| CommandError::task(format!("Asset read task: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_binary_and_mobile_payloads_including_non_ascii_titles() {
        let metadata = br#"{"title":"Gr\u00fc\u00dfe","parent_collection_id":null}"#;
        let bytes = [0, 37, 80, 68, 70, 255];
        let mut payload = (metadata.len() as u32).to_le_bytes().to_vec();
        payload.extend(metadata);
        payload.extend(bytes);
        for body in [
            InvokeBody::Raw(payload.clone()),
            InvokeBody::Json(serde_json::json!(payload)),
        ] {
            let (input, decoded) = decode::<PdfMetadata>(&body).unwrap();
            assert_eq!(input.title.as_deref(), Some("Grüße"));
            assert_eq!(decoded, bytes);
        }
    }

    #[test]
    fn rejects_truncated_and_unbounded_metadata() {
        for payload in [vec![], vec![1, 0, 0], vec![8, 0, 0, 0], vec![255; 4]] {
            assert!(decode::<PdfMetadata>(&InvokeBody::Raw(payload)).is_err());
        }
    }

    #[test]
    fn summary_upload_does_not_return_file_bytes() {
        let db = crate::db::open_memory_for_tests();
        db.with_conn(|conn| {
            let note = crate::notes::create(
                conn,
                crate::notes::CreateNote {
                    title: None,
                    body: None,
                    parent_collection_id: None,
                    note_kind: Some(crate::notes::NoteKind::Ink),
                },
            )?;
            let stored =
                super::super::store_deduped(conn, &note.summary.id, "application/pdf", &[1, 2, 3])?;
            let summary = super::super::load_summary(conn, &stored.id)?;
            assert_eq!(summary.size, 3);
            assert!(serde_json::to_value(summary)
                .unwrap()
                .get("bytes")
                .is_none());
            Ok(())
        })
        .unwrap();
    }
}
