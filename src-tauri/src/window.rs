//! Window management commands.

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::AppResult;

/// Open a fresh OS-level Tauri window that renders just the requested note.
///
/// Why we don't put `?window=editor&id=X` in the URL: Tauri's asset
/// resolver treats the `WebviewUrl::App(PathBuf)` argument as a file path,
/// not a URL. On Linux WebKit decodes the segment whole and 404s on the
/// literal name `index.html?window=...`; on Windows WebView2 partially
/// resolves it but the SPA never matches `/index.html?...`, the page
/// never mounts, the webview stays unresponsive, and on Win32 that
/// freezes the window event loop (locking even the OS close button).
///
/// And why we use an *empty* path here, not `"index.html"`: in
/// `pnpm tauri dev` Tauri loads windows from `devUrl`
/// (http://localhost:1420), which is the SvelteKit/Vite dev server.
/// That dev server routes by SvelteKit page paths and has no route
/// for `/index.html`, so navigating there 404s. Empty path resolves
/// to the dev base (which routes to `/` and renders +page.svelte).
/// In production the asset resolver serves index.html at `/` either
/// way, so the empty form works for both modes.
///
/// The note id is delivered via `initialization_script`, which runs
/// before any page JS, so SvelteKit sees `window.__POPOUT_NOTE_ID__`
/// on first mount.
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

    WebviewWindowBuilder::new(app, &label, WebviewUrl::App("".into()))
        .title(title)
        .inner_size(900.0, 700.0)
        .min_inner_size(560.0, 420.0)
        .decorations(true)
        .resizable(true)
        .center()
        .disable_drag_drop_handler()
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
