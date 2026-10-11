//! A legacy-origin document that runs no application code. It exports raw
//! localStorage before any isolated worker can start; originals remain intact.
use std::sync::Mutex;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow};
use zeroize::Zeroize;

use crate::browser_archive::Values;
use crate::error::{AppError, AppResult, CommandResult};

const LABEL: &str = "legacy-browser-export";
const PAGE: &str = "/legacy-browser-export.html";
const SCRIPT: &str = include_str!("legacy-export.js");
type Completion = Box<dyn FnOnce(AppHandle) + Send>;

struct Incoming(Option<Values>);
impl Drop for Incoming {
    fn drop(&mut self) {
        if let Some(values) = &mut self.0 {
            for value in values.values_mut() {
                value.zeroize();
            }
        }
    }
}

pub struct Export {
    origin: String,
    vault_id: String,
    completion: Mutex<Option<Completion>>,
}

pub fn origin(app: &AppHandle) -> AppResult<String> {
    if tauri::is_dev() {
        if let Some(url) = &app.config().build.dev_url {
            return Ok(url.origin().ascii_serialization());
        }
    }
    #[cfg(windows)]
    {
        let https = app
            .config()
            .app
            .windows
            .iter()
            .find(|w| w.label == "main")
            .is_some_and(|w| w.use_https_scheme);
        Ok(if https {
            "https://tauri.localhost"
        } else {
            "http://tauri.localhost"
        }
        .into())
    }
    #[cfg(not(windows))]
    {
        Ok("tauri://localhost".into())
    }
}

pub fn begin(app: &tauri::App, vault_id: String, complete: Completion) -> AppResult<()> {
    let origin = origin(app.handle())?;
    let environment = app.state::<crate::environment::Environment>();
    if crate::browser_archive::resume_export(
        &environment.root,
        &environment.credential_service,
        &origin,
    )? {
        complete(app.handle().clone());
        return Ok(());
    }
    app.manage(Export {
        origin,
        vault_id,
        completion: Mutex::new(Some(complete)),
    });
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .ok_or_else(|| AppError::InvalidArg("main browser configuration missing".into()))?;
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        LABEL,
        WebviewUrl::App(PAGE.trim_start_matches('/').into()),
    )
    .title("Mindstream Notes: browser migration")
    .visible(false)
    .decorations(true)
    .inner_size(600.0, 280.0)
    .initialization_script(SCRIPT);
    if let Some(args) = &config.additional_browser_args {
        builder = builder.additional_browser_args(args);
    }
    let window = builder.build()?;
    let handle = app.handle().clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
            handle.exit(1);
        }
    });
    Ok(())
}

fn validate_source(window: &WebviewWindow, expected_origin: &str, origin: &str) -> AppResult<()> {
    let url = window.url()?;
    let actual_origin = format!("{}://{}", url.scheme(), url.authority());
    if window.label() != LABEL
        || url.path() != PAGE
        || origin != expected_origin
        || actual_origin != origin
    {
        return Err(AppError::InvalidArg("invalid legacy export window".into()));
    }
    Ok(())
}

#[tauri::command]
pub async fn finish_legacy_browser_export(
    app: AppHandle,
    window: WebviewWindow,
    origin: String,
    values: Option<Values>,
) -> CommandResult<()> {
    let mut incoming = Incoming(values);
    let export = app
        .try_state::<Export>()
        .ok_or_else(|| AppError::InvalidArg("legacy export is not active".into()))?;
    validate_source(&window, &export.origin, &origin)?;
    let vault_id = export.vault_id.clone();
    let environment = app.state::<crate::environment::Environment>();
    let root = environment.root.clone();
    let service = environment.credential_service.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        if incoming.0.is_none() {
            return Err(AppError::InvalidArg(
                "legacy browser storage could not be read".into(),
            ));
        }
        if !crate::browser_archive::resume_export(&root, &service, &origin)? {
            let values = incoming.0.take().ok_or_else(|| {
                AppError::InvalidArg("legacy browser storage could not be read".into())
            })?;
            let status =
                crate::browser_archive::capture(&root, &service, &origin, &vault_id, values)?;
            crate::browser_archive::seal(&root, &service, &origin, &status.checksum)?;
        }
        Ok::<_, AppError>(())
    })
    .await
    .map_err(|_| AppError::InvalidArg("legacy browser export task failed".into()))?;
    if let Err(error) = result {
        let _ = window.show();
        return Err(error.into());
    }
    let completion = export
        .completion
        .lock()
        .map_err(|_| AppError::InvalidArg("legacy export state unavailable".into()))?
        .take();
    if let Some(complete) = completion {
        let next = app.clone();
        app.run_on_main_thread(move || {
            // Host prevents automatic exit on the last hidden window's removal.
            let _ = window.destroy();
            complete(next);
        })?;
    }
    Ok(())
}
