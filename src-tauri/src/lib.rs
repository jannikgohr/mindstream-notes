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

pub mod app_events;
pub mod app_restart;
pub mod assets;
mod atomic_file;
pub mod auth;
pub mod backup;
pub mod browser_archive;
#[cfg(desktop)]
pub mod browser_identity;
pub mod browser_migration;
pub mod client_errors;
pub mod collections;
pub mod content_stats;
#[cfg(desktop)]
pub mod coordinator_autostart;
#[cfg(desktop)]
pub mod coordinator_ipc;
#[cfg(desktop)]
pub mod coordinator_revival;
#[cfg(desktop)]
mod coordinator_shortcuts;
#[cfg(desktop)]
mod coordinator_shutdown;
#[cfg(desktop)]
mod coordinator_updater;
pub mod data;
pub mod db;
pub mod deep_links;
#[cfg(desktop)]
pub mod desktop_settings;
#[cfg(desktop)]
mod device_notifications;
pub mod drawing;
pub mod environment;
pub mod error;
#[cfg(desktop)]
pub mod foreground;
pub mod history;
pub mod hotkeys;
pub mod i18n;
pub mod import;
pub mod legacy_content;
#[cfg(desktop)]
pub mod legacy_export;
#[cfg(desktop)]
pub mod native_menu;
pub mod notes;
pub mod notes_export;
pub mod paths;
pub mod pdf_export;
pub mod pdf_text;
pub mod plugins;
pub mod profiles;
pub mod root_documents;
pub mod search;
pub mod serde_helpers;
pub mod sharing;
#[cfg(desktop)]
mod shortcut_actions;
#[cfg(desktop)]
mod shortcut_routing;
pub mod signatures;
pub mod spellcheck;
pub mod storage_locks;
pub mod sync;
pub mod system;
pub mod theme_presets;
#[cfg(desktop)]
pub mod tray;
pub mod tree;
pub mod tree_batch;
pub mod ui_settings;
#[cfg(desktop)]
mod update_recovery;
#[cfg(desktop)]
mod update_windows;
#[cfg(desktop)]
mod vault_handoff;
pub mod vault_jobs;
#[cfg(desktop)]
pub mod vault_runtime;
#[cfg(desktop)]
pub mod vault_supervisor;
pub mod vault_window_state;
#[cfg(desktop)]
pub mod webview_memory;
pub mod webview_security;
#[cfg(desktop)]
pub mod worker_registration;
#[cfg(desktop)]
pub mod worker_shutdown;

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

#[cfg(not(desktop))]
#[tauri::command]
fn get_worker_browser_options() -> crate::error::CommandResult<Option<()>> {
    Ok(None)
}

#[cfg(not(desktop))]
#[tauri::command]
fn vault_worker_ready() -> crate::error::CommandResult<()> {
    Ok(())
}

#[cfg(not(desktop))]
#[tauri::command]
fn vault_worker_failed() -> crate::error::CommandResult<()> {
    Ok(())
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
                // The socket library traces its handshake, and the change
                // feed's handshake carries the session token. See the same
                // rule for the desktop logger below.
                .with_filter(
                    android_logger::FilterBuilder::new()
                        .parse("trace,tungstenite=warn,tokio_tungstenite=warn")
                        .build(),
                )
                .with_tag("Mindstream"),
        );
    }

    #[cfg(desktop)]
    let app_handle = deep_links::builder()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Powers the relaunch-into-new-vault switch and the
        // restore-relaunch flow (frontend calls `relaunch()` from
        // @tauri-apps/plugin-process). Desktop-only; gated by
        // `process:allow-restart` in the desktop capability.
        .plugin(tauri_plugin_process::init())
        .enable_macos_default_menu(false)
        .on_menu_event(native_menu::handle_menu_event)
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                worker_shutdown::window_destroyed(window.app_handle(), window.label());
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if worker_shutdown::closing(window.app_handle()) {
                    api.prevent_close();
                    return;
                }
            }
            if matches!(event, tauri::WindowEvent::Focused(true)) {
                vault_supervisor::window_focused(window.app_handle(), window.label());
            }
            #[cfg(target_os = "macos")]
            if matches!(
                event,
                tauri::WindowEvent::Focused(_) | tauri::WindowEvent::Destroyed
            ) {
                native_menu::refresh_window_menu(window.app_handle());
            }
            if window.label() == "main" {
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        let app_handle = window.app_handle();
                        if desktop_settings::should_close_to_tray(app_handle)
                            || cfg!(target_os = "macos")
                        {
                            api.prevent_close();
                            let _ = window.hide();
                            webview_memory::sync_to_visibility(app_handle);
                            return;
                        }
                        if app_handle.try_state::<vault_supervisor::Worker>().is_some() {
                            api.prevent_close();
                            worker_shutdown::request_close(app_handle);
                        } else {
                            app_handle.exit(0);
                        }
                    }
                    tauri::WindowEvent::Destroyed => {
                        let app_handle = window.app_handle();
                        app_handle.exit(0);
                    }
                    // Minimise, restore and show all surface here as a
                    // resize; `sync_to_visibility` reads the window's
                    // actual state rather than trying to infer which one
                    // this was. Focus changes are included because a
                    // window restored from the taskbar can report the new
                    // size before it reports being un-minimised.
                    tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(_) => {
                        webview_memory::sync_to_visibility(window.app_handle());
                    }
                    _ => {}
                }
            }
        });
    #[cfg(not(desktop))]
    let app_handle = tauri::Builder::default();

    #[cfg(desktop)]
    let app_handle = if environment::os_integrations_enabled() {
        let app_handle = if std::env::args().any(|arg| arg == "--vault-worker") {
            app_handle
        } else {
            let mut autostart = tauri_plugin_autostart::Builder::new().arg(AUTOSTART_ARG);
            // Preserve the opt-in runtime across login while default startup
            // remains direct. Never register a worker's private launch args.
            if std::env::args().any(|arg| arg == "--supervised-vaults") {
                autostart = autostart.arg("--supervised-vaults");
            }
            app_handle.plugin(autostart.build())
        };
        if std::env::args().any(|arg| arg == "--vault-worker") {
            app_handle
        } else {
            app_handle.plugin(tauri_plugin_updater::Builder::new().build())
        }
    } else {
        app_handle
    };

    let app = app_handle
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .register_uri_scheme_protocol("mindstream", serve_asset_bytes)
        // Reverse-proxy for plugin live previews (e.g. tinymist): serves the
        // upstream frontend from our own origin with an app-theme background
        // injected. Async because it does an HTTP fetch of the running server.
        .register_asynchronous_uri_scheme_protocol(
            plugins::preview_service::PREVIEW_SCHEME,
            |ctx, request, responder| {
                let app = ctx.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    responder
                        .respond(plugins::preview_service::proxy_preview_html(app, request).await);
                });
            },
        )
        .setup(|app| {
            let os_root = app.path().app_data_dir()?;
            let environment = environment::Environment::resolve(os_root)?;
            environment.validate_browser_isolation(&app.config().identifier)?;
            app.manage(environment);
            #[cfg(desktop)]
            {
                let environment = app.state::<environment::Environment>();
                let folder = if environment.kind == environment::Kind::Release {
                    app.path().app_log_dir()?
                } else {
                    environment.root.join("logs")
                };
                app.handle().plugin(
                    tauri_plugin_log::Builder::new()
                        .level(if cfg!(debug_assertions) {
                            log::LevelFilter::Trace
                        } else {
                            log::LevelFilter::Info
                        })
                        .level_for("wry", log::LevelFilter::Warn)
                        .level_for("tao", log::LevelFilter::Warn)
                        .level_for("hyper", log::LevelFilter::Warn)
                        .level_for("hyper_util", log::LevelFilter::Warn)
                        .level_for("reqwest", log::LevelFilter::Warn)
                        .level_for("rustls", log::LevelFilter::Warn)
                        // Not only noise: the socket library traces its handshake
                        // request, headers and all, and the change feed's carries
                        // the session token. That must never reach a log.
                        .level_for("tungstenite", log::LevelFilter::Warn)
                        .level_for("tokio_tungstenite", log::LevelFilter::Warn)
                        .level_for("keyring_core", log::LevelFilter::Info)
                        .targets([
                            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder {
                                path: folder,
                                file_name: Some(format!("Mindstream-{}", std::process::id())),
                            }),
                        ])
                        .build(),
                )?;
            }
            // Register a credential store before any auth code can hit
            // it — Entry::new() returns Error::NoDefaultStore otherwise.
            init_keyring();

            // Resolve the active profile directory and register it in
            // state *before* anything reaches for `paths::app_data_dir`.
            // A gated env override (e2e isolation seam) bypasses the
            // index entirely; otherwise the index at the fixed OS root
            // decides, migrating a pre-profiles vault into a "default"
            // profile first so notes aren't orphaned.
            let app_data_root = paths::app_data_root(app.handle())?;
            #[cfg(desktop)]
            let role =
                vault_supervisor::startup_role(app.state::<environment::Environment>().kind)?;
            #[cfg(desktop)]
            {
                app.manage(role.clone());
                if role == vault_runtime::Role::Host {
                    return vault_supervisor::start_host(app).map_err(Into::into);
                }
                if matches!(role, vault_runtime::Role::Worker { .. }) {
                    vault_supervisor::authorize_worker(app.handle(), &role)?;
                }
            }
            #[cfg(desktop)]
            let explicit_worker = match &role {
                vault_runtime::Role::Worker { vault_id, .. } => Some(vault_id.clone()),
                _ => None,
            };
            #[cfg(not(desktop))]
            let explicit_worker: Option<String> = None;
            let (active_id, ownership) = if let Some(id) = explicit_worker {
                let ownership = profiles::resolve_worker(&app_data_root, &id)?;
                (id, ownership)
            } else {
                match profiles::dir_override() {
                    Some((id, dir)) => {
                        let _root_lock = storage_locks::RootLock::acquire(&app_data_root)?;
                        profiles::reconcile_root_locked(&app_data_root)?;
                        (id, storage_locks::VaultLock::acquire(&dir)?)
                    }
                    None => profiles::resolve_startup(&app_data_root)?,
                }
            };
            log::info!("[boot] active profile = {active_id}");
            let app_data = ownership.directory.clone();
            plugins::packages::prepare(&app_data_root, &app_data)?;
            plugins::settings::prepare(&app_data_root, &app_data)?;
            ui_settings::prepare_device_appearance(&app_data_root, &app_data, &active_id)?;
            legacy_content::initialize_owner(&app_data_root, &active_id, &app_data)?;
            app.manage(paths::ActiveProfile {
                id: active_id.clone(),
                dir: app_data.clone(),
            });
            #[cfg(desktop)]
            if matches!(role, vault_runtime::Role::Worker { .. }) {
                let browser =
                    browser_identity::Identity::for_vault(&app_data_root, &active_id, &app_data)?;
                let environment = app.state::<environment::Environment>();
                let source = browser_archive::load(
                    &app_data_root,
                    &environment.credential_service,
                    &legacy_export::origin(app.handle())?,
                )?
                .ok_or("worker legacy export is missing")?;
                app.manage(browser_migration::Source(source));
                app.manage(browser);
                vault_supervisor::register_worker(app.handle(), &role, &ownership)?;
            }
            #[cfg(desktop)]
            app.handle().plugin(
                tauri_plugin_window_state::Builder::new()
                    .with_state_flags(WINDOW_STATE_FLAGS)
                    .with_filename(
                        app_data
                            .join("window-state.json")
                            .to_string_lossy()
                            .to_string(),
                    )
                    .skip_initial_state("main")
                    .build(),
            )?;

            // Apply any pending restore the user staged in a previous
            // session BEFORE opening the live DB. If the sentinel
            // file is present, we move the live DB aside and swap the
            // staged copy into place. No-op when nothing's pending.
            backup::apply_pending_restore_if_any(app.handle())?;

            #[cfg(desktop)]
            app.manage(desktop_settings::DesktopSettings::load(app)?);

            let db_path = app_data.join("mindstream.db");
            log::info!("[boot] db path = {}", db_path.display());

            let db = Db::open_owned(&db_path, ownership)?;

            // First-run seed.
            db.with_conn(|c| {
                if migrations::was_freshly_created(c)? {
                    log::info!("[boot] empty database — seeding demo content");
                    migrations::seed(c)?;
                }
                Ok(())
            })?;

            app.manage(db);
            app.manage(hotkeys::NativeHotkeyDisplays::default());
            #[cfg(desktop)]
            app.manage(hotkeys::DesktopGlobalShortcuts::default());
            #[cfg(desktop)]
            app.manage(shortcut_actions::Actions::default());

            // Create after profile selection so the first document gets the
            // correct account's CSP. A fresh document after sign-in/sign-out
            // reads the newly persisted session before allowing relay traffic.
            let policy_app = app.handle().clone();
            #[cfg(desktop)]
            let preview_port = Some(plugins::preview_service::gateway_port()?);
            #[cfg(not(desktop))]
            let preview_port = None;
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .ok_or("main window configuration is missing")?;
            let title = if app.state::<environment::Environment>().kind == environment::Kind::Dev {
                "Mindstream Notes Dev".to_owned()
            } else {
                "Mindstream Notes".to_owned()
            };
            #[cfg(desktop)]
            let title = if matches!(role, vault_runtime::Role::Worker { .. }) {
                let name = profiles::load(&app_data_root)?
                    .and_then(|index| {
                        index
                            .profiles
                            .into_iter()
                            .find(|profile| profile.id == active_id)
                    })
                    .map(|profile| profile.name)
                    .unwrap_or_else(|| active_id.clone());
                format!("{title}: {name}")
            } else {
                title
            };
            let builder = tauri::WebviewWindowBuilder::from_config(app, config)?
                .initialization_script(theme_presets::initialization_script(app.handle())?)
                .title(title)
                .on_web_resource_request(move |_request, response| {
                    if !response
                        .headers()
                        .contains_key(tauri::http::header::CONTENT_SECURITY_POLICY)
                    {
                        return;
                    }
                    let session = auth::read_session_info(&policy_app).ok().flatten();
                    webview_security::apply_account_policy(
                        response,
                        session.as_ref().map(|session| session.server_url.as_str()),
                        preview_port,
                    );
                });
            #[cfg(desktop)]
            let builder = if let Some(identity) = app.try_state::<browser_identity::Identity>() {
                identity.apply(builder)
            } else {
                builder
            };
            builder.build()?;

            #[cfg(target_os = "macos")]
            native_menu::init(app)?;

            #[cfg(desktop)]
            if !matches!(role, vault_runtime::Role::Worker { .. }) {
                tray::init(app)?;
            }

            #[cfg(desktop)]
            if let Some(window) = app.get_webview_window("main") {
                if let Err(err) = window.restore_state(WINDOW_STATE_FLAGS) {
                    log::warn!("[window-state] restore main window: {err}");
                }
                if let Err(err) = desktop_settings::apply_window_decorations(
                    app.handle(),
                    desktop_settings::should_use_custom_window_decorations(app.handle()),
                ) {
                    log::warn!("[window] apply decorations: {err}");
                }
                if matches!(role, vault_runtime::Role::Worker { .. }) {
                    // First settings migration and readiness route activation
                    // through the host; a failed worker cannot replace a source.
                } else if was_started_by_autostart()
                    && desktop_settings::should_start_in_tray(app.handle())
                {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                // Settle the webview's own visibility against whichever
                // branch ran. The window is configured `visible: false`
                // and shown from here, so this is the first point the two
                // can agree -- and relying on a Focused/Resized event to
                // arrive would risk starting up with the webview marked
                // invisible, which paints nothing.
                webview_memory::sync_to_visibility(app.handle());
            }

            // Periodic sync runs in a tokio task owned by this
            // process — replaces the JS setTimeout that used to live
            // in +layout.svelte. Starts disabled; the JS settings
            // effect calls `set_sync_schedule` once on mount with the
            // restored preference, which is what actually flips it on.
            app.manage(vault_jobs::Jobs::default());
            app.manage(vault_jobs::Saves::default());
            app.manage(sync::scheduler::SyncScheduler::new());
            sync::scheduler::spawn(app.handle().clone());
            // An invite link opened outside the app, now or when it started.
            app.manage(deep_links::PendingInviteLink::default());
            #[cfg(desktop)]
            deep_links::listen(app.handle());
            // The server says when something changed elsewhere, so that
            // sync does not have to wait for the next tick.
            sync::feed::spawn(app.handle().clone());

            // Trash retention sweep — same setup pattern. Starts
            // disabled until the JS settings effect hands over the
            // restored `data.trashRetentionDays` value.
            app.manage(data::TrashRetentionScheduler::new());
            data::spawn_retention_sweep(app.handle().clone());

            // Registry of long-lived plugin preview servers (e.g. `tinymist
            // preview`). Reaped on exit below so nothing is orphaned.
            app.manage(plugins::preview_service::PreviewServiceRegistry::default());
            app.manage(spellcheck::SpellcheckState::default());
            app.manage(import::ImportState::default());
            // Hunspell tables are ~21 MB resident for a bilingual user and
            // stay warm for the life of the process otherwise. Hands them
            // back once the user stops typing; the next check reloads in
            // ~50 ms on a blocking thread.
            spellcheck::spawn_idle_eviction(app.handle().clone());

            Ok(())
        })
        .invoke_handler(|invoke| {
            #[cfg(desktop)]
            if invoke
                .message
                .webview_ref()
                .app_handle()
                .try_state::<vault_runtime::Role>()
                .is_some_and(|role| *role == vault_runtime::Role::Host)
                && !vault_supervisor::allows_host_invoke(
                    invoke.message.webview_ref().label(),
                    invoke.message.command(),
                )
            {
                invoke
                    .resolver
                    .reject("command unavailable in the coordinator");
                return true;
            }
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                // Collections
                collections::list_collections,
                collections::create_collection,
                collections::update_collection,
                collections::delete_collection,
                // Notes
                notes::list_notes,
                tree::load_tree,
                client_errors::report_client_error,
                notes::load_note,
                notes::create_note,
                notes::save_note,
                notes::trash_note,
                notes::restore_note,
                notes::purge_note,
                tree_batch::move_many,
                tree_batch::trash_many,
                tree_batch::restore_many,
                tree_batch::purge_many,
                // Spellcheck (local dictionaries, no network at check time)
                spellcheck::spellcheck_unknown_words,
                spellcheck::spellcheck_suggest,
                spellcheck::spellcheck_installed_dictionaries,
                spellcheck::spellcheck_available_dictionaries,
                spellcheck::spellcheck_install_dictionary,
                spellcheck::spellcheck_remove_dictionary,
                spellcheck::custom_dictionary_list,
                spellcheck::custom_dictionary_add,
                spellcheck::custom_dictionary_remove,
                spellcheck::spellcheck_word_chars,
                spellcheck::spellcheck_release_dictionaries,
                spellcheck::http_checker::text_checker_check,
                spellcheck::http_checker::text_checker_test_connection,
                // Search
                search::search_notes,
                // PDF searchable-text index (derived, local-only)
                pdf_text::set_pdf_text,
                pdf_text::pdf_notes_missing_text,
                pdf_text::pdf_note_needs_text,
                // Note history (local, automatic versioning)
                history::capture_note_version,
                history::capture_current_note_version,
                history::list_note_versions,
                history::load_note_version,
                history::prune_note_versions,
                // Content stats (canonical word count, from DB content)
                content_stats::note_word_count,
                // Assets (freeform drawing attachments)
                assets::upload_drawing_asset,
                assets::fetch_drawing_asset,
                assets::import_pdf_note,
                assets::sweep_unreferenced_markdown_assets,
                // Signatures (reusable, synced signature library)
                signatures::list_signatures,
                signatures::save_signature,
                signatures::delete_signature,
                // Plugins (per-profile registry + integrity)
                plugins::plugins_list,
                plugins::plugins_get,
                plugins::plugins_discover,
                plugins::plugins_enable,
                plugins::plugins_disable,
                plugins::plugins_approve,
                plugins::plugins_set_load_error,
                plugins::plugins_remove,
                plugins::plugins_install,
                plugins::plugins_read_file,
                plugins::plugins_artifacts_status,
                plugins::plugins_download_artifact,
                plugins::plugins_read_artifact,
                plugins::plugins_native_tool_status,
                plugins::plugins_run_native_tool,
                plugins::plugins_settings_all,
                plugins::plugins_settings_set,
                plugins::plugins_settings_remove,
                plugins::plugins_run_script,
                plugins::preview_service::plugins_native_service_status,
                plugins::preview_service::plugins_preview_start,
                plugins::preview_service::plugins_preview_update,
                plugins::preview_service::plugins_preview_stop,
                // Profiles (vaults)
                profiles::list_profiles,
                vault_window_state::get_vault_window_state,
                profiles::create_profile,
                profiles::switch_profile,
                profiles::rename_profile,
                profiles::delete_profile,
                // Native app restart — mobile vault switch reboots into the
                // newly-activated vault (desktop relaunches from JS instead).
                #[cfg(target_os = "android")]
                app_restart::restart_app,
                // Auth (Etebase)
                auth::etebase_login,
                auth::etebase_logout,
                auth::etebase_session,
                ui_settings::initialize_ui_settings,
                #[cfg(desktop)]
                browser_identity::get_worker_browser_options,
                #[cfg(not(desktop))]
                get_worker_browser_options,
                #[cfg(desktop)]
                legacy_export::finish_legacy_browser_export,
                #[cfg(desktop)]
                vault_supervisor::vault_worker_ready,
                #[cfg(desktop)]
                vault_supervisor::vault_worker_failed,
                #[cfg(desktop)]
                vault_supervisor::open_profile_window,
                #[cfg(desktop)]
                vault_supervisor::get_picker_vaults,
                #[cfg(desktop)]
                vault_supervisor::open_picker_vault,
                #[cfg(desktop)]
                coordinator_updater::check_coordinated_update,
                #[cfg(desktop)]
                coordinator_updater::install_coordinated_update,
                #[cfg(desktop)]
                coordinator_autostart::get_start_on_login,
                #[cfg(desktop)]
                coordinator_autostart::set_start_on_login,
                #[cfg(desktop)]
                worker_shutdown::vault_window_close_ready,
                #[cfg(desktop)]
                worker_shutdown::vault_window_close_ack,
                #[cfg(not(desktop))]
                vault_worker_ready,
                #[cfg(not(desktop))]
                vault_worker_failed,
                legacy_content::migrate_legacy_content,
                ui_settings::load_ui_settings,
                theme_presets::list_theme_presets,
                theme_presets::get_theme_appearance,
                theme_presets::save_theme_preset,
                theme_presets::delete_theme_preset,
                ui_settings::patch_ui_setting,
                auth::check_etebase_server_url,
                auth::account::account_server_info,
                auth::account::account_signup,
                auth::account::account_recover,
                auth::account::account_security_status,
                auth::account::account_begin_authenticator,
                auth::account::account_confirm_authenticator,
                auth::account::account_remove_authenticator,
                auth::account::account_new_backup_codes,
                auth::account::account_new_recovery_key,
                auth::secret_file::account_save_secret_file,
                auth::account::account_change_password,
                auth::account::account_sessions,
                auth::account::account_end_session,
                auth::account::account_end_other_sessions,
                // Sync
                sync::sync_now,
                sync::collab_room::note_room_info,
                sync::collab_room::note_room_ticket,
                sync::scheduler::set_sync_schedule,
                // Sharing
                sharing::list_incoming_shares,
                sharing::accept_share,
                sharing::decline_share,
                sharing::leave_shared_collection,
                sharing::stop_sharing_collection,
                sharing::list_collection_members,
                sharing::set_collection_member_access,
                sharing::remove_collection_member,
                sharing::get_collection_share_state,
                sharing::invite_collection,
                sharing::create_share_link,
                sharing::list_share_links,
                sharing::revoke_share_link,
                sharing::open_share_link,
                sharing::claim_share_link,
                sharing::user_key_info,
                sharing::own_key_fingerprint,
                deep_links::take_pending_invite_link,
                #[cfg(feature = "e2e-data-dir")]
                deep_links::e2e_open_address,
                #[cfg(feature = "e2e-data-dir")]
                sharing::e2e_create_standalone_collection_invite,
                #[cfg(feature = "e2e-data-dir")]
                sharing::e2e_remember_other_key,
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
                import::legacy_links::legacy_wikilink_count,
                import::legacy_links::convert_legacy_wikilinks_command,
                import::notes_import_pick_folder,
                import::notes_import_pick_file,
                import::notes_import_detect,
                import::notes_import_run,
                import::notes_import_cancel,
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
                hotkeys::get_global_shortcut_status,
                #[cfg(desktop)]
                desktop_settings::get_close_to_tray,
                #[cfg(desktop)]
                desktop_settings::set_close_to_tray,
                #[cfg(desktop)]
                desktop_settings::get_start_in_tray,
                #[cfg(desktop)]
                desktop_settings::set_start_in_tray,
                #[cfg(desktop)]
                desktop_settings::get_custom_window_decorations,
                #[cfg(desktop)]
                desktop_settings::set_custom_window_decorations,
                #[cfg(desktop)]
                desktop_settings::get_desktop_language,
                #[cfg(desktop)]
                desktop_settings::set_desktop_language,
                #[cfg(desktop)]
                desktop_settings::get_desktop_theme_mode,
                #[cfg(desktop)]
                desktop_settings::set_desktop_theme_mode,
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
            ];
            handler(invoke)
        })
        .build(tauri::generate_context!());

    let app = match app {
        Ok(app) => app,
        Err(err) => {
            log::error!("[boot] error while building tauri application: {err}");
            eprintln!("error while building tauri application: {err}");
            return;
        }
    };

    app.run(|app, event| {
        #[cfg(desktop)]
        if app
            .try_state::<vault_runtime::Role>()
            .is_some_and(|role| *role == vault_runtime::Role::Host)
        {
            if let tauri::RunEvent::ExitRequested {
                api, code: None, ..
            } = &event
            {
                api.prevent_exit();
            }
        }
        // Reap any long-lived plugin preview servers so they don't outlive the
        // app (e.g. a leftover `tinymist preview` holding a port).
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(registry) =
                app.try_state::<plugins::preview_service::PreviewServiceRegistry>()
            {
                registry.shutdown_all();
            }
        }
        #[cfg(target_os = "macos")]
        if matches!(event, tauri::RunEvent::Reopen { .. }) {
            crate::vault_supervisor::activate(app);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = app;
    });
}

#[cfg(desktop)]
fn was_started_by_autostart() -> bool {
    std::env::args().any(|arg| arg == AUTOSTART_ARG)
}

/// MIME types we're willing to echo back into a `Content-Type`.
///
/// The stored `mime_type` is **not** trustworthy: local uploads take the
/// browser's `File.type` verbatim ([`assets::upload`]), and synced rows take
/// whatever the remote payload carried — so a user who shares a collection
/// with you controls it. Reflecting that unchecked would let them serve
/// arbitrary active content (`text/html`) from this app's own scheme.
///
/// Anything not on this list degrades to `application/octet-stream`, which the
/// webview will download rather than render.
/// Deliberately generous on raster formats — none of them can execute, and a
/// too-narrow list turns "user drags a photo in" into a broken image. `image/
/// svg+xml` is the one image type that is really a document; it stays allowed
/// (notes embed SVG) but the response's CSP neutralises it.
const ASSET_MIME_ALLOWLIST: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/bmp",
    // Apple platforms hand these over for camera photos.
    "image/heic",
    "image/heif",
    "image/tiff",
    "image/x-icon",
    "image/vnd.microsoft.icon",
    "image/svg+xml",
    "application/pdf",
];

/// Narrow a stored MIME type to something safe to serve.
///
/// Parameters are dropped (`image/png; charset=x` → `image/png`) so a
/// decorated variant can't slip past the comparison.
fn safe_asset_mime(stored: &str) -> &'static str {
    let base = stored
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    ASSET_MIME_ALLOWLIST
        .iter()
        .find(|allowed| **allowed == base)
        .copied()
        .unwrap_or("application/octet-stream")
}

/// Origins the app itself is served from, and the only ones allowed to read
/// asset bytes cross-origin.
///
/// wry serves the webview from a different origin per platform, and the asset
/// scheme is a *different* origin again — so freeform PNG export, which reads
/// asset images into a canvas, needs CORS or the canvas taints and export
/// breaks. Echoing back only these keeps that working while dropping the
/// previous `Access-Control-Allow-Origin: *`, which let any origin running
/// script in the webview read every asset in the vault.
const APP_ORIGINS: &[&str] = &[
    // macOS / Linux / iOS
    "tauri://localhost",
    // Windows / Android
    "http://tauri.localhost",
    "https://tauri.localhost",
];

/// The `Access-Control-Allow-Origin` value to answer a request with, if any.
/// `None` means send no CORS header at all — same-origin and `<img>` loads are
/// unaffected either way.
fn asset_allowed_origin(origin: Option<&str>) -> Option<&'static str> {
    let origin = origin?;
    if let Some(matched) = APP_ORIGINS.iter().find(|allowed| **allowed == origin) {
        return Some(matched);
    }
    // `pnpm dev` serves the frontend over http; only trust it in dev builds.
    #[cfg(debug_assertions)]
    if origin == "http://localhost:1420" {
        return Some("http://localhost:1420");
    }
    None
}

/// URI scheme handler for `mindstream://localhost/<asset_id>` (and the
/// `http://mindstream.localhost/<asset_id>` form wry uses on
/// Windows/Android). Looks up the asset row, streams the bytes back
/// with a sanitised MIME type.
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

    // Only the app's own origin may read these bytes cross-origin.
    let allow_origin = asset_allowed_origin(
        request
            .headers()
            .get(tauri::http::header::ORIGIN)
            .and_then(|v| v.to_str().ok()),
    );

    match load_result {
        Ok(asset) => {
            let mut builder = tauri::http::Response::builder()
                .status(tauri::http::StatusCode::OK)
                .header(
                    tauri::http::header::CONTENT_TYPE,
                    safe_asset_mime(&asset.summary.mime_type),
                )
                // Belt and braces around the allowlist: without this, a webview
                // that content-sniffs could still decide a PNG-labelled blob is
                // really HTML and execute it.
                .header(tauri::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff")
                // SVG is on the allowlist because notes legitimately embed it,
                // but an SVG *navigated to* directly is a document that can run
                // script. `sandbox` makes the webview treat any asset document as
                // sandboxed (no scripts, no same-origin), while leaving <img>
                // rendering untouched.
                .header(
                    tauri::http::header::CONTENT_SECURITY_POLICY,
                    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
                )
                // Bytes for a given asset id never change (a new upload
                // produces a new id), so allow long-lived caching. Sync's
                // "fetch fresh bytes for previously-missing asset" path
                // goes from 404 → 200 — browsers don't aggressively cache
                // 404s, so this stays correct.
                .header(
                    tauri::http::header::CACHE_CONTROL,
                    "public, max-age=31536000, immutable",
                )
                // Responses differ by Origin, so caches must not share them.
                .header(tauri::http::header::VARY, "Origin");
            if let Some(origin) = allow_origin {
                builder = builder.header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
            }
            match builder.body(Cow::Owned(asset.bytes)) {
                Ok(response) => response,
                Err(err) => {
                    log::error!("[asset-scheme] response build failed: {err}");
                    empty_asset_response(tauri::http::StatusCode::INTERNAL_SERVER_ERROR)
                }
            }
        }
        Err(err) => {
            log::warn!("[asset-scheme] {id} lookup failed: {err}");
            empty_asset_response(tauri::http::StatusCode::NOT_FOUND)
        }
    }
}

fn empty_asset_response(
    status: tauri::http::StatusCode,
) -> tauri::http::Response<Cow<'static, [u8]>> {
    let mut response = tauri::http::Response::new(Cow::Owned(Vec::new()));
    *response.status_mut() = status;
    response
}

#[cfg(test)]
mod asset_scheme_tests {
    use super::safe_asset_mime;

    #[test]
    fn echoes_only_the_app_origins() {
        for origin in ["tauri://localhost", "http://tauri.localhost"] {
            assert_eq!(super::asset_allowed_origin(Some(origin)), Some(origin));
        }
    }

    /// The header used to be a blanket `*`, which let any origin running
    /// script in the webview read every asset in the vault.
    #[test]
    fn refuses_foreign_and_lookalike_origins() {
        for origin in [
            "https://evil.example",
            "null",
            // Suffix/prefix games against a naive contains() check.
            "http://tauri.localhost.evil.example",
            "http://eviltauri.localhost",
            "tauri://localhost.evil",
        ] {
            assert_eq!(
                super::asset_allowed_origin(Some(origin)),
                None,
                "{origin} must not be echoed"
            );
        }
    }

    #[test]
    fn sends_no_cors_header_when_there_is_no_origin() {
        assert_eq!(super::asset_allowed_origin(None), None);
    }

    #[test]
    fn passes_through_types_notes_actually_embed() {
        for mime in [
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
            "image/svg+xml",
            "application/pdf",
        ] {
            assert_eq!(safe_asset_mime(mime), mime);
        }
    }

    /// The whole point of the allowlist: a shared collection can carry an
    /// asset row whose `mime_type` the sharer chose.
    #[test]
    fn active_content_types_degrade_to_octet_stream() {
        for mime in [
            "text/html",
            "application/xhtml+xml",
            "text/javascript",
            "application/javascript",
            "text/xml",
            "",
        ] {
            assert_eq!(
                safe_asset_mime(mime),
                "application/octet-stream",
                "{mime} must not be reflected"
            );
        }
    }

    #[test]
    fn normalises_case_and_strips_parameters() {
        assert_eq!(safe_asset_mime("IMAGE/PNG"), "image/png");
        assert_eq!(safe_asset_mime("  image/png  "), "image/png");
        assert_eq!(safe_asset_mime("image/png; charset=utf-8"), "image/png");
        // A decorated smuggling attempt must not match on the prefix.
        assert_eq!(
            safe_asset_mime("text/html; x=image/png"),
            "application/octet-stream"
        );
    }

    /// Header injection via the stored value: the return type is a fixed
    /// &'static str from the table, so nothing attacker-shaped reaches the
    /// header at all.
    #[test]
    fn never_returns_attacker_bytes() {
        let injected = "image/png\r\nSet-Cookie: a=b";
        let out = safe_asset_mime(injected);
        assert_eq!(out, "application/octet-stream");
        assert!(!out.contains('\r') && !out.contains('\n'));
    }
}
