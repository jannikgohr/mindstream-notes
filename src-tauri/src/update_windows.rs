//! Private worker snapshot/restore, including note popouts. All native window
//! mutations run on the event loop; RPC threads only schedule and poll them.
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::update_recovery::{Vault, Window};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Progress {
    Pending,
    Ready,
    Failed { message: String },
}

struct Restore {
    windows: Vec<Window>,
    progress: Progress,
    at: Instant,
}

#[derive(Default)]
pub(crate) struct Restores(Mutex<BTreeMap<Uuid, Restore>>);

fn invalid() -> AppError {
    AppError::InvalidArg("update window restoration is unavailable".into())
}

pub(crate) fn snapshot(app: &AppHandle) -> AppResult<Vec<Window>> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| -> AppResult<Vec<Window>> {
            let mut windows = Vec::new();
            for (label, window) in handle.webview_windows() {
                if label != "main" && !label.starts_with("note_") {
                    continue;
                }
                let position = window.outer_position()?;
                let size = window.inner_size()?;
                let note_id = if label == "main" {
                    None
                } else {
                    window
                        .url()?
                        .query_pairs()
                        .find(|(key, _)| key == "id")
                        .map(|(_, value)| value.into_owned())
                };
                let saved = Window {
                    label,
                    note_id,
                    x: position.x,
                    y: position.y,
                    width: size.width,
                    height: size.height,
                    visible: window.is_visible()?,
                    minimized: window.is_minimized()?,
                    maximized: window.is_maximized()?,
                };
                saved.validate()?;
                windows.push(saved);
            }
            windows.sort_by(|a, b| a.label.cmp(&b.label));
            Ok(windows)
        })();
        let _ = sender.send(result);
    })?;
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| invalid())?
}

pub(crate) fn progress(app: &AppHandle, id: Uuid) -> AppResult<Progress> {
    Ok(app
        .state::<Restores>()
        .0
        .lock()
        .map_err(|_| invalid())?
        .get(&id)
        .ok_or_else(invalid)?
        .progress
        .clone())
}

pub(crate) fn begin(app: &AppHandle, id: Uuid, vault: Vault) -> AppResult<()> {
    for window in &vault.windows {
        window.validate()?;
    }
    if vault.windows.is_empty() || vault.windows.len() > 128 {
        return Err(invalid());
    }
    let state = app.state::<Restores>();
    let mut book = state.0.lock().map_err(|_| invalid())?;
    book.retain(|_, restore| {
        restore.progress == Progress::Pending || restore.at.elapsed() < Duration::from_secs(600)
    });
    if let Some(restore) = book.get(&id) {
        return if restore.windows == vault.windows {
            Ok(())
        } else {
            Err(invalid())
        };
    }
    if !crate::worker_shutdown::coordinator_revival_allowed(app) {
        return Err(invalid());
    }
    if book.len() >= 128
        || book
            .values()
            .any(|restore| restore.progress == Progress::Pending)
    {
        return Err(invalid());
    }
    let job = app.state::<crate::vault_jobs::Jobs>().enter()?;
    book.insert(
        id,
        Restore {
            windows: vault.windows.clone(),
            progress: Progress::Pending,
            at: Instant::now(),
        },
    );
    drop(book);
    let handle = app.clone();
    let task = move || {
        let _job = job;
        let result = restore(&handle, &vault).and_then(|()| {
            let deadline = Instant::now() + Duration::from_secs(60);
            while !crate::worker_shutdown::all_windows_ready(&handle) {
                if Instant::now() >= deadline {
                    return Err(invalid());
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            settle_visible_positions(&handle, &vault)?;
            Ok(())
        });
        if let Ok(mut book) = handle.state::<Restores>().0.lock() {
            if let Some(restore) = book.get_mut(&id) {
                restore.progress = match result {
                    Ok(()) => Progress::Ready,
                    Err(error) => Progress::Failed {
                        message: error.to_string(),
                    },
                };
            }
        }
    };
    if let Err(error) = std::thread::Builder::new()
        .name("update-window-restore".into())
        .spawn(task)
    {
        state
            .0
            .lock()
            .map_err(|_| invalid())?
            .get_mut(&id)
            .ok_or_else(invalid)?
            .progress = Progress::Failed {
            message: error.to_string(),
        };
        return Err(error.into());
    }
    Ok(())
}

fn settle_visible_positions(app: &AppHandle, vault: &Vault) -> AppResult<()> {
    // GTK can clamp a hidden window's requested position using its old size.
    // Wait for mapping/configuration, then place it using the allocated size.
    // The window manager may still clamp bounds on a smaller monitor.
    let deadline = Instant::now() + Duration::from_secs(2);
    for saved in vault
        .windows
        .iter()
        .filter(|window| window.visible && !window.minimized && !window.maximized)
    {
        let window = app.get_webview_window(&saved.label).ok_or_else(invalid)?;
        loop {
            let size = window.inner_size()?;
            if (window.is_visible()? && size.width == saved.width && size.height == saved.height)
                || Instant::now() >= deadline
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        window.set_position(tauri::PhysicalPosition::new(saved.x, saved.y))?;
    }
    Ok(())
}

fn restore(app: &AppHandle, vault: &Vault) -> AppResult<()> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let handle = app.clone();
    let windows = vault.windows.clone();
    app.run_on_main_thread(move || {
        let result = (|| -> AppResult<()> {
            for saved in windows {
                let window = if let Some(window) = handle.get_webview_window(&saved.label) {
                    window
                } else {
                    let note_id = saved.note_id.as_deref().ok_or_else(invalid)?;
                    let title: String = handle
                        .state::<crate::db::Db>()
                        .0
                        .lock()
                        .map_err(|_| invalid())?
                        .query_row("SELECT title FROM notes WHERE id=?1", [note_id], |row| {
                            row.get(0)
                        })?;
                    let config = handle
                        .config()
                        .app
                        .windows
                        .iter()
                        .find(|config| config.label == "main")
                        .ok_or_else(invalid)?;
                    let mut config = config.clone();
                    config.label = saved.label.clone();
                    config.url = tauri::WebviewUrl::App(
                        format!("?window=editor&id={}", urlencoding::encode(note_id)).into(),
                    );
                    let policy_app = handle.clone();
                    let preview_port = crate::plugins::preview_service::gateway_port()?;
                    let builder = tauri::WebviewWindowBuilder::from_config(&handle, &config)?
                        .title(title)
                        .visible(false)
                        .focused(false)
                        .min_inner_size(560.0, 420.0)
                        .disable_drag_drop_handler()
                        .decorations(
                            !crate::desktop_settings::should_use_custom_window_decorations(&handle),
                        )
                        .on_web_resource_request(move |_request, response| {
                            if response
                                .headers()
                                .contains_key(tauri::http::header::CONTENT_SECURITY_POLICY)
                            {
                                let session =
                                    crate::auth::read_session_info(&policy_app).ok().flatten();
                                crate::webview_security::apply_account_policy(
                                    response,
                                    session.as_ref().map(|session| session.server_url.as_str()),
                                    Some(preview_port),
                                );
                            }
                        });
                    handle
                        .state::<crate::browser_identity::Identity>()
                        .apply(builder)
                        .build()?
                };
                window.unmaximize()?;
                window.set_size(tauri::PhysicalSize::new(saved.width, saved.height))?;
                window.set_position(tauri::PhysicalPosition::new(saved.x, saved.y))?;
                if saved.maximized {
                    window.maximize()?;
                }
                window.unminimize()?;
                if saved.visible {
                    window.show()?;
                } else {
                    window.hide()?;
                }
                if saved.minimized {
                    window.minimize()?;
                }
                if !saved.visible {
                    window.hide()?;
                }
                // A hidden-created WebView2 controller stays hidden when only
                // its native parent is shown. Popouts do not use the main
                // window's visibility/memory policy, so synchronize explicitly.
                let webview: &tauri::Webview = window.as_ref();
                if saved.visible && !saved.minimized {
                    webview.show()?;
                } else {
                    webview.hide()?;
                }
            }
            crate::webview_memory::sync_to_visibility(&handle);
            Ok(())
        })();
        let _ = sender.send(result);
    })?;
    receiver
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| invalid())?
}
