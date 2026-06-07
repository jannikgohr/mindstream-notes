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
#[cfg(desktop)]
pub mod desktop_settings;
pub mod drawing;
pub mod error;
pub mod hotkeys;
pub mod i18n;
pub mod notes;
pub mod pdf_export;
pub mod serde_helpers;
pub mod sync;
pub mod system;
#[cfg(desktop)]
pub mod tray;

use tauri::Manager;

use crate::db::{migrations, Db};

#[cfg(desktop)]
const AUTOSTART_ARG: &str = "--mindstream-autostart";

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
    // Route the `log` facade into logcat on Android. Without this
    // every `log::info!` / `log::warn!` is a silent no-op, which is
    // why none of the `[drawing.perf]` / `[boot]` lines were
    // visible in earlier debugging sessions. Tag "Mindstream"
    // separates our output from Android system + Tauri internals
    // so it can be grepped on its own. Trace-level filter in debug
    // builds so per-sample logs are visible during bring-up; Info
    // in release to keep logcat usable.
    #[cfg(target_os = "android")]
    {
        let level = if cfg!(debug_assertions) {
            log::LevelFilter::Trace
        } else {
            log::LevelFilter::Info
        };
        android_logger::init_once(
            android_logger::Config::default()
                .with_max_level(level)
                .with_tag("Mindstream"),
        );
    }

    #[cfg(desktop)]
    let app_handle = tauri::Builder::default()
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .arg(AUTOSTART_ARG)
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            if window.label() == "main" {
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        let app_handle = window.app_handle();
                        if desktop_settings::should_close_to_tray(app_handle) {
                            api.prevent_close();
                            let _ = window.hide();
                            return;
                        }
                        drawing::shutdown_desktop(app_handle);
                        app_handle.exit(0);
                    }
                    tauri::WindowEvent::Destroyed => {
                        let app_handle = window.app_handle();
                        drawing::shutdown_desktop(app_handle);
                        app_handle.exit(0);
                    }
                    _ => {}
                }
            }
        });
    #[cfg(not(desktop))]
    let app_handle = tauri::Builder::default();

    app_handle
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
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
            app.manage(hotkeys::NativeHotkeyDisplays::default());

            #[cfg(desktop)]
            app.manage(desktop_settings::DesktopSettings::load(app));

            #[cfg(desktop)]
            tray::init(app)?;

            #[cfg(desktop)]
            if let Some(window) = app.get_webview_window("main") {
                if was_started_by_autostart()
                    && desktop_settings::should_start_in_tray(app.handle())
                {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }

            // Periodic sync runs in a tokio task owned by this
            // process — replaces the JS setTimeout that used to live
            // in +layout.svelte. Starts disabled; the JS settings
            // effect calls `set_sync_schedule` once on mount with the
            // restored preference, which is what actually flips it on.
            app.manage(sync::scheduler::SyncScheduler::new());
            sync::scheduler::spawn(app.handle().clone());

            // Hand the drawing module an AppHandle so its render
            // thread can emit `drawing:dirty` events back to JS for
            // debounced auto-save. Idempotent (OnceLock) — second
            // call would silently no-op.
            drawing::init(app.handle().clone());

            // Kick off wgpu pre-warm in the background for the
            // legacy desktop native ink renderer. Android now uses
            // the JS canvas plus Kotlin live ink overlay, so it no
            // longer compiles this renderer.
            #[cfg(desktop)]
            drawing::render::prewarm();

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
            assets::import_pdf_note,
            // Auth (Etebase)
            auth::etebase_login,
            auth::etebase_logout,
            auth::etebase_session,
            // Sync
            sync::sync_now,
            sync::note_room_info,
            sync::scheduler::set_sync_schedule,
            // PDF export
            pdf_export::save_pdf_export,
            // System introspection
            system::is_appimage_install,
            // Hotkey display state mirrored from the JS hotkey store
            hotkeys::get_hotkey_display,
            hotkeys::set_hotkey_displays,
            #[cfg(desktop)]
            desktop_settings::get_close_to_tray,
            #[cfg(desktop)]
            desktop_settings::set_close_to_tray,
            #[cfg(desktop)]
            desktop_settings::get_start_in_tray,
            #[cfg(desktop)]
            desktop_settings::set_start_in_tray,
            #[cfg(desktop)]
            desktop_settings::get_desktop_language,
            #[cfg(desktop)]
            desktop_settings::set_desktop_language,
            // Native drawing surface (Android only; no-op stubs on desktop)
            drawing::drawing_show,
            drawing::drawing_hide,
            drawing::drawing_clear,
            drawing::drawing_set_save_debounce,
            drawing::drawing_save_ink_state,
            drawing::drawing_show_live_ink_overlay,
            drawing::drawing_hide_live_ink_overlay,
            drawing::drawing_enter_immersive_ink_mode,
            drawing::drawing_exit_immersive_ink_mode,
            drawing::drawing_cancel_live_ink,
            drawing::drawing_set_live_ink_style,
            drawing::drawing_set_live_ink_finger_drawing,
            drawing::drawing_start_collab,
            drawing::drawing_stop_collab,
            drawing::drawing_set_theme,
            drawing::drawing_set_toolbar_settings,
            drawing::drawing_set_desktop_panel_bounds,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(desktop)]
fn was_started_by_autostart() -> bool {
    std::env::args().any(|arg| arg == AUTOSTART_ARG)
}
