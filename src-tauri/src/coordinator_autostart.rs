//! Only the coordinator manages OS login registration in supervised mode.
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult, CommandResult};

pub(crate) fn read_or_set(app: &AppHandle, enabled: Option<bool>) -> AppResult<bool> {
    if !crate::environment::os_integrations_enabled() {
        return match enabled {
            None => Ok(false),
            Some(_) => Err(AppError::InvalidArg(
                "start on login is unavailable in dev/test environments".into(),
            )),
        };
    }
    // Serialize OS mutations with root-level settings operations, including
    // direct mode during the opt-in rollout. This runs off the event loop and
    // never contacts a worker while holding the root lock.
    let root = crate::paths::app_data_root(app)?;
    let _lock = crate::storage_locks::RootLock::acquire(&root)?;
    let manager = app
        .try_state::<tauri_plugin_autostart::AutoLaunchManager>()
        .ok_or_else(|| AppError::InvalidArg("autostart owner is unavailable".into()))?;
    if let Some(enabled) = enabled {
        let result = if enabled {
            manager.enable()
        } else {
            manager.disable()
        };
        result.map_err(|error| AppError::InvalidArg(error.to_string()))?;
    }
    manager
        .is_enabled()
        .map_err(|error| AppError::InvalidArg(error.to_string()))
}

async fn setting(app: AppHandle, enabled: Option<bool>) -> CommandResult<bool> {
    let job = app.state::<crate::vault_jobs::Saves>().enter()?;
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let _job = job;
        if app.try_state::<crate::vault_supervisor::Worker>().is_some() {
            crate::vault_supervisor::autostart_setting(&app, enabled)
        } else {
            read_or_set(&app, enabled)
        }
    })
    .await
    .map_err(|error| AppError::InvalidArg(error.to_string()))??)
}

#[tauri::command]
pub async fn get_start_on_login(app: AppHandle) -> CommandResult<bool> {
    setting(app, None).await
}

#[tauri::command]
pub async fn set_start_on_login(app: AppHandle, value: bool) -> CommandResult<()> {
    let actual = setting(app, Some(value)).await?;
    if actual != value {
        return Err(AppError::InvalidArg("OS startup registration did not apply".into()).into());
    }
    Ok(())
}
