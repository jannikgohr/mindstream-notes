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

pub mod assets;
pub mod auth;
pub mod collections;
pub mod db;
pub mod error;
pub mod notes;
pub mod serde_helpers;
pub mod sync;

use tauri::Manager;

use crate::db::{migrations, Db};

/// Pick a platform credential store and register it with keyring-core
/// so subsequent `Entry::new(...)` calls in `auth::*` know where to
/// read/write secrets. v4 of the keyring ecosystem split each backend
/// into its own crate; this function is the only place we name them.
///
/// On Android the upstream store also needs `ndk-context` to be
/// initialised from Java before this runs — see Keyring.kt and
/// MainActivity.onCreate.
///
/// Failures here are logged but non-fatal: the rest of the app still
/// boots so the user can use local-only features; signin/signout will
/// surface a clear "no keyring store" error when they're invoked.
fn init_keyring() {
    let result: Result<(), String> = (|| {
        #[cfg(target_os = "macos")]
        {
            let store = apple_native_keyring_store::keychain::Store::new()
                .map_err(|e| format!("apple keychain store: {e}"))?;
            keyring_core::set_default_store(store);
        }

        #[cfg(target_os = "ios")]
        {
            let store = apple_native_keyring_store::protected::Store::new()
                .map_err(|e| format!("apple protected store: {e}"))?;
            keyring_core::set_default_store(store);
        }

        #[cfg(target_os = "windows")]
        {
            let store = windows_native_keyring_store::Store::new()
                .map_err(|e| format!("windows credential store: {e}"))?;
            keyring_core::set_default_store(store);
        }

        #[cfg(target_os = "linux")]
        {
            let store = dbus_secret_service_keyring_store::Store::new()
                .map_err(|e| format!("linux secret-service store: {e}"))?;
            keyring_core::set_default_store(store);
        }

        #[cfg(target_os = "android")]
        {
            // Store::new() panics if ndk-context isn't initialised, so we
            // expect Keyring.initializeNdkContext to have run already.
            let store = android_native_keyring_store::Store::new()
                .map_err(|e| format!("android keystore: {e}"))?;
            keyring_core::set_default_store(store);
        }

        Ok(())
    })();
    if let Err(e) = result {
        log::warn!("[boot] keyring init failed: {e} — sign-in/out will error");
    }
}

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
            // Register a credential store before any auth code can hit
            // it — Entry::new() returns Error::NoDefaultStore otherwise.
            init_keyring();

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
            // Assets (freeform drawing attachments)
            assets::upload_drawing_asset,
            assets::fetch_drawing_asset,
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
