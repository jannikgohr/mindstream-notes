//! Menu observations never grant ownership. Opening/switching still rechecks
//! the coordinator reservation, exact worker identity and physical vault lease.
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
#[cfg(desktop)]
use tauri::Manager;

use crate::error::CommandResult;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Status {
    Starting,
    Ready,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Entry {
    pub vault_id: String,
    pub status: Status,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct View {
    pub(crate) supervised: bool,
    pub(crate) vaults: Vec<Entry>,
}

#[tauri::command]
pub async fn get_vault_window_state(app: AppHandle) -> CommandResult<View> {
    #[cfg(desktop)]
    if app.try_state::<crate::vault_supervisor::Worker>().is_some() {
        let job = app.state::<crate::vault_jobs::Jobs>().enter()?;
        return Ok(tauri::async_runtime::spawn_blocking(move || {
            let _job = job;
            crate::vault_supervisor::window_state(&app)
        })
        .await
        .map_err(|error| crate::error::AppError::InvalidArg(error.to_string()))??);
    }
    #[cfg(not(desktop))]
    let _ = app;
    // Existing direct e2e devices and mobile keep their single-vault behavior.
    Ok(View::default())
}
