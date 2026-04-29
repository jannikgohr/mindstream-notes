//! Window management commands.

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::AppResult;

/// Open a fresh OS-level Tauri window that renders just the requested note.
///
/// Each window has its own webview / JS runtime. State sync between windows
/// happens through the database — both windows read/write the same SQLite
/// file, so edits in one are picked up by the other when it next reloads
/// (or via the future `note-saved` Tauri event).
pub fn open_note_window_impl(
    app: &tauri::AppHandle,
    id: &str,
    title: &str,
) -> AppResult<()> {
    let label = format!("note-{}", sanitize_label(id));
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(());
    }

    let encoded = urlencoding::encode(id);
    let url = format!("index.html?window=editor&id={encoded}#popout={encoded}");

    WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(900.0, 700.0)
        .min_inner_size(560.0, 420.0)
        .decorations(true)
        .resizable(true)
        .center()
        .drag_and_drop(false)
        .build()?;

    Ok(())
}

fn sanitize_label(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

#[tauri::command]
pub fn open_note_window(
    app: tauri::AppHandle,
    id: String,
    title: String,
) -> Result<(), String> {
    open_note_window_impl(&app, &id, &title).map_err(Into::into)
}
