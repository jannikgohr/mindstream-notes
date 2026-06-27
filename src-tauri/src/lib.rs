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
pub mod backup;
pub mod collections;
pub mod content_stats;
pub mod data;
pub mod db;
#[cfg(desktop)]
pub mod desktop_settings;
pub mod drawing;
pub mod error;
pub mod history;
pub mod hotkeys;
pub mod i18n;
pub mod notes;
pub mod notes_export;
pub mod paths;
pub mod pdf_export;
pub mod pdf_text;
pub mod profiles;
pub mod search;
pub mod serde_helpers;
pub mod signatures;
pub mod sync;
pub mod system;
#[cfg(desktop)]
pub mod tray;

use std::borrow::Cow;

use tauri::Manager;
#[cfg(desktop)]
use tauri_plugin_window_state::{StateFlags, WindowExt};

use crate::db::{migrations, Db};

#[cfg(desktop)]
const AUTOSTART_ARG: &str = "--mindstream-autostart";
#[cfg(desktop)]
const WINDOW_STATE_FLAGS: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED)
    .union(StateFlags::DECORATIONS)
    .union(StateFlags::FULLSCREEN);

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
            tauri_plugin_log::Builder::new()
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Trace
                } else {
                    log::LevelFilter::Info
                })
                // Silence noisy third-party crates that emit DEBUG/TRACE
                // at high volume during normal operation — webview/window
                // backend (wry/tao) and HTTP/TLS (hyper/reqwest/rustls).
                // Our own modules stay at the global level.
                .level_for("wry", log::LevelFilter::Warn)
                .level_for("tao", log::LevelFilter::Warn)
                .level_for("hyper", log::LevelFilter::Warn)
                .level_for("hyper_util", log::LevelFilter::Warn)
                .level_for("reqwest", log::LevelFilter::Warn)
                .level_for("rustls", log::LevelFilter::Warn)
                .level_for("keyring_core", log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("Mindstream".into()),
                    }),
                ])
                .build(),
        )
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .arg(AUTOSTART_ARG)
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(WINDOW_STATE_FLAGS)
                .skip_initial_state("main")
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Powers the relaunch-into-new-vault switch and the
        // restore-relaunch flow (frontend calls `relaunch()` from
        // @tauri-apps/plugin-process). Desktop-only; gated by
        // `process:allow-restart` in the desktop capability.
        .plugin(tauri_plugin_process::init())
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
                        app_handle.exit(0);
                    }
                    tauri::WindowEvent::Destroyed => {
                        let app_handle = window.app_handle();
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
        .register_uri_scheme_protocol("mindstream", serve_asset_bytes)
        .setup(|app| {
            // Register a credential store before any auth code can hit
            // it — Entry::new() returns Error::NoDefaultStore otherwise.
            init_keyring();

            // Resolve the active profile directory and register it in
            // state *before* anything reaches for `paths::app_data_dir`.
            // A gated env override (e2e isolation seam) bypasses the
            // index entirely; otherwise the index at the fixed OS root
            // decides, migrating a pre-profiles vault into a "default"
            // profile first so notes aren't orphaned.
            let app_data_root =
                paths::app_data_root(app.handle()).expect("could not resolve app_data_dir");
            let (active_id, app_data) = match profiles::dir_override() {
                Some(over) => over,
                None => {
                    if let Err(e) = profiles::migrate_legacy_if_needed(&app_data_root) {
                        log::error!("[profiles] legacy migration failed: {e}");
                    }
                    let index = profiles::load_or_init(&app_data_root)
                        .expect("could not read profiles index");
                    let dir = profiles::profile_dir(&app_data_root, &index.active);
                    (index.active, dir)
                }
            };
            log::info!("[boot] active profile = {active_id}");
            app.manage(paths::ActiveProfile {
                id: active_id,
                dir: app_data.clone(),
            });

            // Apply any pending restore the user staged in a previous
            // session BEFORE opening the live DB. If the sentinel
            // file is present, we move the live DB aside and swap the
            // staged copy into place. No-op when nothing's pending.
            backup::apply_pending_restore_if_any(app.handle());

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
            app.manage(hotkeys::DesktopGlobalShortcuts::default());

            #[cfg(desktop)]
            app.manage(desktop_settings::DesktopSettings::load(app));

            #[cfg(desktop)]
            tray::init(app)?;

            #[cfg(desktop)]
            if let Some(window) = app.get_webview_window("main") {
                if let Err(err) = window.restore_state(WINDOW_STATE_FLAGS) {
                    log::warn!("[window-state] restore main window: {err}");
                }
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

            // Trash retention sweep — same setup pattern. Starts
            // disabled until the JS settings effect hands over the
            // restored `data.trashRetentionDays` value (and confirms
            // `data.useTrash` is on).
            app.manage(data::TrashRetentionScheduler::new());
            data::spawn_retention_sweep(app.handle().clone());

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
            // Search
            search::search_notes,
            // PDF searchable-text index (derived, local-only)
            pdf_text::set_pdf_text,
            pdf_text::pdf_notes_missing_text,
            pdf_text::pdf_note_needs_text,
            // Note history (local, automatic versioning)
            history::capture_note_version,
            history::list_note_versions,
            history::load_note_version,
            history::prune_note_versions,
            // Content stats (canonical word count, from DB content)
            content_stats::note_word_count,
            // Assets (freeform drawing attachments)
            assets::upload_drawing_asset,
            assets::fetch_drawing_asset,
            assets::import_pdf_note,
            // Signatures (reusable, synced signature library)
            signatures::list_signatures,
            signatures::save_signature,
            signatures::delete_signature,
            // Profiles (vaults)
            profiles::list_profiles,
            profiles::create_profile,
            profiles::switch_profile,
            profiles::rename_profile,
            profiles::delete_profile,
            // Auth (Etebase)
            auth::etebase_login,
            auth::etebase_logout,
            auth::etebase_session,
            auth::check_etebase_server_url,
            // Sync
            sync::sync_now,
            sync::note_room_info,
            sync::scheduler::set_sync_schedule,
            // One-shot recovery for items the pre-fix etebase encoder
            // bug left corrupt on the server. Invoke from dev tools.
            sync::repair::audit_corrupt_remote_items,
            sync::repair::purge_corrupt_remote_note,
            // Data & Backup (Settings → Data)
            data::open_data_folder,
            data::open_folder,
            data::trash_counts,
            data::empty_trash,
            data::set_trash_retention,
            data::sweep_trash_retention,
            backup::backup_now,
            backup::import_begin,
            backup::import_cleanup,
            backup::import_restore,
            backup::import_merge,
            notes_export::notes_export_pick_dir,
            notes_export::notes_export_write_file,
            // PDF export
            pdf_export::save_pdf_export,
            // System introspection
            system::is_appimage_install,
            // Hotkey display state mirrored from the JS hotkey store
            hotkeys::get_hotkey_display,
            hotkeys::set_hotkey_displays,
            #[cfg(desktop)]
            hotkeys::sync_global_shortcuts,
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
            // Ink note bridge — save + Android live-ink overlay control
            // plane. The overlay commands are no-ops on desktop.
            drawing::drawing_save_ink_state,
            drawing::drawing_show_live_ink_overlay,
            drawing::drawing_hide_live_ink_overlay,
            drawing::drawing_enter_immersive_ink_mode,
            drawing::drawing_exit_immersive_ink_mode,
            drawing::drawing_cancel_live_ink,
            drawing::drawing_set_live_ink_style,
            drawing::drawing_set_live_ink_finger_drawing,
            drawing::drawing_set_control_bounds,
            drawing::drawing_set_document_bounds,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(desktop)]
fn was_started_by_autostart() -> bool {
    std::env::args().any(|arg| arg == AUTOSTART_ARG)
}

/// URI scheme handler for `mindstream://localhost/<asset_id>` (and the
/// `http://mindstream.localhost/<asset_id>` form wry uses on
/// Windows/Android). Looks up the asset row, streams the bytes back
/// with the row's MIME type.
///
/// Returns 404 with an empty body on any lookup failure — the
/// markdown image just falls back to its alt text in the editor, which
/// matches what the user used to see when the bridge returned a blob
/// URL for missing bytes.
fn serve_asset_bytes<R: tauri::Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Cow<'static, [u8]>> {
    // Path is `/asset_<uuid>` regardless of platform — both rewrite
    // forms (`mindstream://localhost/...` and `http://mindstream.localhost/...`)
    // produce the same `path()` after parsing.
    let raw_path = request.uri().path();
    let id = raw_path.trim_start_matches('/');
    // Defensive: ids are `asset_<uuid>` (plain ASCII), but if the
    // webview happens to percent-encode anything we still want to
    // match what's in the assets table.
    let id = match urlencoding::decode(id) {
        Ok(decoded) => decoded.into_owned(),
        Err(_) => id.to_string(),
    };

    let app = ctx.app_handle();
    let db = app.state::<Db>();
    let load_result = db.with_conn(|c| crate::assets::load(c, &id));

    match load_result {
        Ok(asset) => tauri::http::Response::builder()
            .status(tauri::http::StatusCode::OK)
            .header(tauri::http::header::CONTENT_TYPE, asset.summary.mime_type)
            // Bytes for a given asset id never change (a new upload
            // produces a new id), so allow long-lived caching. Sync's
            // "fetch fresh bytes for previously-missing asset" path
            // goes from 404 → 200 — browsers don't aggressively cache
            // 404s, so this stays correct.
            .header(
                tauri::http::header::CACHE_CONTROL,
                "public, max-age=31536000, immutable",
            )
            .header("Access-Control-Allow-Origin", "*")
            .body(Cow::Owned(asset.bytes))
            .unwrap(),
        Err(err) => {
            log::warn!("[asset-scheme] {id} lookup failed: {err}");
            tauri::http::Response::builder()
                .status(tauri::http::StatusCode::NOT_FOUND)
                .body(Cow::Owned(Vec::new()))
                .unwrap()
        }
    }
}
