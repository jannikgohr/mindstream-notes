//! Mindstream Notes — Tauri entry point.
//!
//! Module map:
//!   error       — AppError + IPC mapping
//!   db          — SQLite connection + migrations + first-run seed
//!   notes       — note CRUD commands
//!   collections — folder CRUD commands
//!   window      — open_note_window + future window helpers
//!
//! All non-window state lives in the SQLite DB at `<app_data>/mindstream.db`.
//! Frontend talks to Rust through the `@tauri-apps/api`'s `invoke()`; the
//! TS bridge lives under `src/lib/api/`.

pub mod auth;
pub mod collections;
pub mod db;
pub mod error;
pub mod notes;
pub mod serde_helpers;
pub mod sync;

use tauri::Manager;

use crate::db::{migrations, Db};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(not(desktop))]
    let app_handle = tauri::Builder::default();
    #[cfg(desktop)]
    let app_handle = tauri::Builder::default()
        .plugin(tauri_plugin_autostart::Builder::new().build());

    app_handle
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .expect("could not resolve app_data_dir");
            let db_path = app_data.join("mindstream.db");
            log::info!("[boot] db path = {}", db_path.display());

            let db = Db::open(&db_path).expect("failed to open SQLite database");

            // First-run seed.
            db.with_conn(|c| {
                if migrations::was_freshly_created(c)? {
                    log::info!("[boot] empty database — seeding demo content");
                    migrations::seed(c)?;
                }
                Ok(())
            })
            .expect("failed to seed database");

            app.manage(db);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Collections
            collections::list_collections,
            collections::create_collection,
            collections::update_collection,
            collections::delete_collection,
            // Notes
            notes::list_notes,
            notes::load_note,
            notes::create_note,
            notes::save_note,
            notes::trash_note,
            notes::restore_note,
            notes::purge_note,
            // Auth (Etebase)
            auth::etebase_login,
            auth::etebase_logout,
            auth::etebase_session,
            // Sync
            sync::sync_now,
            sync::note_room_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
