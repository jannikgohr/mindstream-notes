//! Native save-dialog bridge for note exports, with a legacy PDF entry point.
//!
//! The frontend builds the file bytes and supplies the filename and filter.
//! We pop the OS file picker, write the bytes to the chosen path, and
//! return whether the user actually saved (vs. cancelled the dialog).
//!
//! Why a Rust command instead of `<a download>`: Tauri's webview will
//! happily honour an anchor download by silently dropping the file in
//! the OS default downloads folder, with no name prompt and no way
//! for the user to redirect it. For an export action the user just
//! triggered, that's the wrong behaviour — they expect a save dialog.

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
#[cfg(not(target_os = "android"))]
use tauri_plugin_dialog::FilePath;
use tokio::sync::oneshot;

use crate::error::{AppError, AppResult, CommandResult};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePdfExportInput {
    /// Suggested filename pre-filled into the dialog (without path).
    pub suggested_name: String,
    /// Optional save-dialog title supplied by the export flow.
    pub dialog_title: Option<String>,
    /// PDF bytes to write at the chosen path. Tauri serialises Uint8Array
    /// from the TS side as a JSON number array, which serde decodes into
    /// Vec<u8> transparently.
    pub bytes: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFileExportInput {
    pub suggested_name: String,
    pub dialog_title: Option<String>,
    pub bytes: Vec<u8>,
    pub filter_name: String,
    pub extensions: Vec<String>,
}

fn validate_filter(input: &SaveFileExportInput) -> AppResult<()> {
    if input.filter_name.trim().is_empty()
        || input.extensions.is_empty()
        || input.extensions.len() > 8
        || input.extensions.iter().any(|ext| {
            ext.is_empty() || ext.len() > 16 || !ext.bytes().all(|b| b.is_ascii_alphanumeric())
        })
    {
        return Err(AppError::InvalidArg("Invalid export file filter".into()));
    }
    Ok(())
}

async fn save_file_export_inner(app: AppHandle, input: SaveFileExportInput) -> AppResult<bool> {
    validate_filter(&input)?;
    // The dialog API is callback-based; bridge it to async via a one-shot
    // channel so the command's caller can `await` the user's choice.
    let (tx, rx) = oneshot::channel();
    let title = input.dialog_title.as_deref().unwrap_or("Save export");
    app.dialog()
        .file()
        .set_title(title)
        .add_filter(
            &input.filter_name,
            &input
                .extensions
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
        )
        .set_file_name(&input.suggested_name)
        .save_file(move |path| {
            // Ignore send errors: a closed receiver means the command
            // future was dropped (e.g. window closed mid-dialog), and
            // there's nothing useful we could do with the path anyway.
            let _ = tx.send(path);
        });

    let Some(file_path) = rx.await.map_err(|e| AppError::InvalidArg(e.to_string()))? else {
        // User cancelled the dialog. Not an error — surface it as false
        // so the UI can stay quiet (no toast, no console error).
        return Ok(false);
    };

    let job = app.state::<crate::vault_jobs::Jobs>().enter()?;
    // Opening a document provider can block. Keep both that request and the
    // write off the async runtime, retaining the vault job until they finish.
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        let _job = job;
        #[cfg(target_os = "android")]
        {
            use std::io::Write;
            use tauri_plugin_fs::FsExt;

            // Preserve the picker URI. The fs plugin opens it through
            // ContentResolver and gives Rust ownership of the descriptor.
            // "wt" truncates existing documents, unlike provider-dependent "w".
            let mut options = tauri_plugin_fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            let mut file = app.fs().open(file_path, options)?;
            file.write_all(&input.bytes)?;
        }
        #[cfg(not(target_os = "android"))]
        write_filesystem_export(file_path, &input.bytes)?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::InvalidArg(format!("export writer failed: {e}")))??;
    Ok(true)
}

#[cfg(not(target_os = "android"))]
fn write_filesystem_export(file_path: FilePath, bytes: &[u8]) -> AppResult<()> {
    let path = file_path
        .into_path()
        .map_err(|e| AppError::InvalidArg(format!("path conversion: {e}")))?;
    std::fs::write(path, bytes)?;
    Ok(())
}

#[tauri::command]
pub async fn save_pdf_export(app: AppHandle, input: SavePdfExportInput) -> CommandResult<bool> {
    save_file_export_inner(
        app,
        SaveFileExportInput {
            suggested_name: input.suggested_name,
            dialog_title: input.dialog_title,
            bytes: input.bytes,
            filter_name: "PDF".into(),
            extensions: vec!["pdf".into()],
        },
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn save_file_export(app: AppHandle, input: SaveFileExportInput) -> CommandResult<bool> {
    save_file_export_inner(app, input).await.map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(target_os = "android"))]
    #[test]
    fn saves_binary_exports_and_truncates_existing_files() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("export with spaces.pdf");
        let bytes = b"%PDF-1.7\n\0\xff\r\n";
        write_filesystem_export(FilePath::Path(path.clone()), bytes).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), bytes);

        let file_url = tauri::Url::from_file_path(&path).unwrap();
        write_filesystem_export(FilePath::Url(file_url), b"short").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"short");
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn rejects_document_uris_on_desktop_and_propagates_write_errors() {
        let uri = tauri::Url::parse("content://example/export.typ").unwrap();
        assert!(write_filesystem_export(FilePath::Url(uri), b"source").is_err());
        let directory = tempfile::tempdir().unwrap();
        assert!(
            write_filesystem_export(FilePath::Path(directory.path().into()), b"source").is_err()
        );
    }

    #[test]
    fn validates_export_extensions() {
        let mut input = SaveFileExportInput {
            suggested_name: "Cards.xlsx".into(),
            dialog_title: None,
            bytes: vec![],
            filter_name: "Excel".into(),
            extensions: vec!["xlsx".into()],
        };
        assert!(validate_filter(&input).is_ok());
        for invalid in ["", "*", "../pdf", ".pdf", "pdf;exe"] {
            input.extensions = vec![invalid.into()];
            assert!(validate_filter(&input).is_err());
        }
        input.extensions.clear();
        assert!(validate_filter(&input).is_err());
    }
}
