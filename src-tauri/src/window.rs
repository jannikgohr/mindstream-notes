//! Window management commands.

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::AppResult;

/// Open a fresh OS-level Tauri window that renders just the requested note.
///
/// Why we don't just put `?window=editor&id=X` in the URL: Tauri's asset
/// resolver treats the `WebviewUrl::App(PathBuf)` argument as a file path,
/// not a URL. On Linux it 404s on a file literally named
/// `index.html?window=...` because the WebKit resolver decodes the path
/// segment whole; on Windows the WebView2 asset protocol partially
/// resolves it but the SPA never matches /index.html?... and never mounts,
/// which leaves the webview unresponsive (and on Win32 that locks up the
/// window event loop, so even the OS close button stops working).
///
/// The fix here: navigate to a plain `index.html` and inject the note id
/// via `initialization_script`. SvelteKit's +page.svelte reads the global
/// before doing any other routing.
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

    let init_script = format!(
        r#"window.__POPOUT_NOTE_ID__ = {};"#,
        serde_json::to_string(id).unwrap_or_else(|_| "\"\"".into())
    );

    WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(900.0, 700.0)
        .min_inner_size(560.0, 420.0)
        .decorations(true)
        .resizable(true)
        .center()
        .drag_and_drop(false)
        .initialization_script(&init_script)
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
