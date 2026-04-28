//! Tauri command surface for the note-taking app.
//!
//! Persistence is currently stubbed: `save_note` / `load_note` log the call and
//! return success / `None`. Wire up real disk I/O (e.g. write Markdown files
//! into a chosen vault directory, or use `tauri-plugin-sql` with SQLite) here.

use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Payload sent from the frontend when saving a note.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotePayload {
    pub id: String,
    pub title: String,
    pub body: String,
}

/// Payload returned to the frontend when a note is loaded.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadedNote {
    pub id: String,
    pub title: String,
    pub body: String,
    /// ISO-8601 timestamp of the last modification.
    pub modified: String,
}

#[tauri::command]
fn save_note(note: NotePayload) -> Result<(), String> {
    // TODO: persist `note` to disk. For example:
    //   let dir = app_handle.path().app_data_dir()?.join("notes");
    //   std::fs::create_dir_all(&dir)?;
    //   std::fs::write(dir.join(format!("{}.md", note.id)), &note.body)?;
    log::info!(
        "save_note(stub): id={} title={:?} body_len={}",
        note.id,
        note.title,
        note.body.len()
    );
    Ok(())
}

#[tauri::command]
fn load_note(id: String) -> Result<Option<LoadedNote>, String> {
    // TODO: read the corresponding file from the vault directory.
    log::info!("load_note(stub): id={}", id);
    Ok(None)
}

#[tauri::command]
fn list_notes() -> Result<Vec<String>, String> {
    // TODO: enumerate notes on disk.
    log::info!("list_notes(stub)");
    Ok(Vec::new())
}

/// Open a fresh OS-level Tauri window that renders just the requested note.
///
/// Each window has its own webview / JS runtime. Until disk persistence is
/// in place the two windows have independent in-memory state — open a note
/// in a new window, edit it there, and the main window won't see the
/// changes (and vice versa). Once `save_note` / `load_note` actually hit
/// disk, both windows read the same source of truth and stay in sync.
#[tauri::command]
fn open_note_window(
    app: tauri::AppHandle,
    id: String,
    title: String,
) -> Result<(), String> {
    // Each window needs a unique label. Reuse the existing one if a window
    // for this note is already open — focus it instead of stacking dupes.
    let label = format!("note-{}", id);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(());
    }

    // The frontend SPA detects ?window=editor&id=<id> on the root route
    // and renders just the editor. We point the new webview at that URL.
    let url = format!("index.html?window=editor&id={}", urlencoding::encode(&id));

    WebviewWindowBuilder::new(&app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(900.0, 700.0)
        .min_inner_size(560.0, 420.0)
        .decorations(true)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| {
            log::error!("open_note_window failed: {e}");
            e.to_string()
        })?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            save_note,
            load_note,
            list_notes,
            open_note_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
