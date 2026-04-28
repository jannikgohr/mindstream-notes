//! Tauri command surface for the note-taking app.
//!
//! Persistence is currently stubbed: `save_note` / `load_note` log the call and
//! return success / `None`. Wire up real disk I/O (e.g. write Markdown files
//! into a chosen vault directory, or use `tauri-plugin-sql` with SQLite) here.

use serde::{Deserialize, Serialize};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![save_note, load_note, list_notes])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
