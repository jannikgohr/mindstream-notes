//! Signed downloads and installation belong to the root process. In particular
//! the Windows updater exits its caller when it starts the installer.
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;
use uuid::Uuid;

use crate::error::{AppError, AppResult, CommandResult};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Available {
    pub id: Uuid,
    pub version: String,
    pub current_version: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum CheckProgress {
    Pending,
    Ready { available: Option<Available> },
    Failed { message: String },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DownloadProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
    pub finished: bool,
}

#[derive(Default)]
struct Book {
    checked: Option<Instant>,
    offer: Option<(Available, tauri_plugin_updater::Update)>,
}

#[derive(Default)]
pub(crate) struct Updates(Mutex<Book>);

pub(crate) fn check(app: &AppHandle, force: bool) -> AppResult<Option<Available>> {
    if !crate::environment::os_integrations_enabled() {
        return Ok(None);
    }
    // Serialize/coalesce startup scans in different workers. Only this private
    // updater mutex crosses network work, never Book, RootLock or a vault lock.
    let state = app.state::<Updates>();
    let mut book = state.0.lock().map_err(|_| unavailable())?;
    if !force
        && book
            .checked
            .is_some_and(|at| at.elapsed() < Duration::from_secs(300))
    {
        return Ok(book.offer.as_ref().map(|(available, _)| available.clone()));
    }
    let updater = app
        .updater_builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| AppError::InvalidArg(error.to_string()))?;
    let update = tauri::async_runtime::block_on(updater.check())
        .map_err(|error| AppError::InvalidArg(error.to_string()))?;
    book.offer = update.map(|update| {
        (
            Available {
                id: Uuid::new_v4(),
                version: update.version.clone(),
                current_version: update.current_version.clone(),
            },
            update,
        )
    });
    book.checked = Some(Instant::now());
    Ok(book.offer.as_ref().map(|(available, _)| available.clone()))
}

fn unavailable() -> AppError {
    AppError::InvalidArg("the selected update is unavailable; check for updates again".into())
}

pub(crate) fn install(app: &AppHandle, operation_id: Uuid, update_id: Uuid) {
    let result = (|| -> AppResult<()> {
        if !crate::environment::os_integrations_enabled() {
            return Err(unavailable());
        }
        let mut update = {
            let state = app.state::<Updates>();
            let book = state.0.lock().map_err(|_| unavailable())?;
            let (offer, update) = book.offer.as_ref().ok_or_else(unavailable)?;
            if offer.id != update_id {
                return Err(unavailable());
            }
            update.clone()
        };
        update.timeout = Some(Duration::from_secs(300));
        let mut downloaded = 0u64;
        let mut last = Instant::now() - Duration::from_secs(1);
        let bytes = tauri::async_runtime::block_on(update.download(
            |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                if last.elapsed() >= Duration::from_millis(150) {
                    crate::vault_supervisor::update_progress(
                        app,
                        DownloadProgress {
                            downloaded,
                            total,
                            finished: false,
                        },
                    );
                    last = Instant::now();
                }
            },
            || {},
        ))
        .map_err(|error| AppError::InvalidArg(error.to_string()))?;
        // download verifies the signature before returning bytes. A failed
        // download/signature check closes no windows and writes no intent.
        crate::vault_supervisor::update_progress(
            app,
            DownloadProgress {
                downloaded: bytes.len() as u64,
                total: Some(bytes.len() as u64),
                finished: true,
            },
        );
        let pause = crate::vault_supervisor::drain_for_update(app, operation_id, &update.version)?;
        let root = crate::paths::app_data_root(app)?;
        crate::update_recovery::installing(&root, operation_id)?;
        update
            .install(bytes)
            .map_err(|error| AppError::InvalidArg(error.to_string()))?;
        // Windows has already exited into its installer. Other platforms
        // replace the bundle/AppImage and return here. The install confirmation
        // authorizes this coordinated restart; no now-closed worker owns it.
        crate::vault_jobs::Pause::commit_all(vec![pause])?;
        app.restart();
    })();
    if let Err(error) = result {
        crate::vault_supervisor::update_failed(app, operation_id, error);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckReply {
    supervised: bool,
    available: Option<Available>,
}

#[tauri::command]
pub async fn check_coordinated_update(app: AppHandle, force: bool) -> CommandResult<CheckReply> {
    if app.try_state::<crate::vault_supervisor::Worker>().is_none() {
        return Ok(CheckReply {
            supervised: false,
            available: None,
        });
    }
    // Check jobs must drain on shutdown. Installation deliberately takes no
    // worker job: it will ask this very worker to save and close.
    let job = app.state::<crate::vault_jobs::Jobs>().enter()?;
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let _job = job;
        crate::vault_supervisor::check_update(&app, force).map(|available| CheckReply {
            supervised: true,
            available,
        })
    })
    .await
    .map_err(|error| AppError::InvalidArg(error.to_string()))??)
}

#[tauri::command]
pub async fn install_coordinated_update(app: AppHandle, id: Uuid) -> CommandResult<()> {
    if app.try_state::<crate::vault_supervisor::Worker>().is_none() {
        return Err(unavailable().into());
    }
    Ok(tauri::async_runtime::spawn_blocking(move || {
        crate::vault_supervisor::install_update(&app, id)
    })
    .await
    .map_err(|error| AppError::InvalidArg(error.to_string()))??)
}
