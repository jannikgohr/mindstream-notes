//! The native save dialog. It needs a real window and a person to answer it,
//! so it lives apart from the export logic and outside the coverage report.

use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tokio::sync::oneshot;

use crate::error::{AppError, AppResult};

/// What the save dialog offers.
pub(crate) struct SaveDialog<'a> {
    pub title: &'a str,
    pub filter_name: &'a str,
    pub extensions: &'a [String],
    pub suggested_name: &'a str,
}

/// Ask where to save a file. `None` means the user cancelled.
pub(crate) async fn pick_save_path<R: Runtime>(
    app: &AppHandle<R>,
    dialog: SaveDialog<'_>,
) -> AppResult<Option<FilePath>> {
    let (tx, rx) = oneshot::channel();
    let extensions: Vec<&str> = dialog.extensions.iter().map(String::as_str).collect();
    app.dialog()
        .file()
        .set_title(dialog.title)
        .add_filter(dialog.filter_name, &extensions)
        .set_file_name(dialog.suggested_name)
        .save_file(move |path| {
            // A closed receiver means the command was dropped mid-dialog.
            let _ = tx.send(path);
        });
    rx.await.map_err(|e| AppError::InvalidArg(e.to_string()))
}
