//! Native save-dialog bridge for the annotated-PDF exporter.
//!
//! The TS side builds the PDF bytes via pdf-lib and hands them to us.
//! We pop the OS file picker, write the bytes to the chosen path, and
//! return whether the user actually saved (vs. cancelled the dialog).
//!
//! Why a Rust command instead of `<a download>`: Tauri's webview will
//! happily honour an anchor download by silently dropping the file in
//! the OS default downloads folder, with no name prompt and no way
//! for the user to redirect it. For an export action the user just
//! triggered, that's the wrong behaviour — they expect a save dialog.

use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

use crate::error::{AppError, AppResult};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePdfExportInput {
    /// Suggested filename pre-filled into the dialog (without path).
    pub suggested_name: String,
    /// PDF bytes to write at the chosen path. Tauri serialises Uint8Array
    /// from the TS side as a JSON number array, which serde decodes into
    /// Vec<u8> transparently.
    pub bytes: Vec<u8>,
}

async fn save_pdf_export_inner(
    app: AppHandle,
    input: SavePdfExportInput,
) -> AppResult<bool> {
    // The dialog API is callback-based; bridge it to async via a one-shot
    // channel so the command's caller can `await` the user's choice.
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_title("Save annotated PDF")
        .add_filter("PDF", &["pdf"])
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

    // On desktop the FilePath is always a real filesystem path; on
    // mobile it could be a content:// URI which we don't support yet
    // (PDF notes are desktop-first in this phase).
    let path = file_path
        .into_path()
        .map_err(|e| AppError::InvalidArg(format!("path conversion: {e}")))?;
    std::fs::write(&path, &input.bytes)?;
    Ok(true)
}

#[tauri::command]
pub async fn save_pdf_export(
    app: AppHandle,
    input: SavePdfExportInput,
) -> Result<bool, String> {
    save_pdf_export_inner(app, input).await.map_err(Into::into)
}
