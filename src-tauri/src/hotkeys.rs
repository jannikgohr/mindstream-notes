use std::{collections::HashMap, sync::Mutex};

use serde::Deserialize;
use tauri::{AppHandle, Manager, State};

#[derive(Clone, Debug, Default)]
struct NativeHotkeyDisplay {
    display: Option<String>,
    accelerator: Option<String>,
}

#[derive(Default)]
pub struct NativeHotkeyDisplays {
    values: Mutex<HashMap<String, NativeHotkeyDisplay>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyDisplayUpdate {
    command_id: String,
    display: Option<String>,
    accelerator: Option<String>,
}

impl NativeHotkeyDisplays {
    fn replace_all(&self, updates: Vec<HotkeyDisplayUpdate>) -> Result<(), String> {
        let mut values = self
            .values
            .lock()
            .map_err(|_| "hotkey display state is poisoned".to_string())?;
        values.clear();
        for update in updates {
            values.insert(
                update.command_id,
                NativeHotkeyDisplay {
                    display: clean_optional(update.display),
                    accelerator: clean_optional(update.accelerator),
                },
            );
        }
        Ok(())
    }

    fn display(&self, command_id: &str) -> Option<String> {
        self.values
            .lock()
            .ok()
            .and_then(|values| values.get(command_id).and_then(|v| v.display.clone()))
    }

    fn accelerator(&self, command_id: &str) -> Option<String> {
        self.values
            .lock()
            .ok()
            .and_then(|values| values.get(command_id).and_then(|v| v.accelerator.clone()))
    }
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value.and_then(|v| {
        let trimmed = v.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

pub fn hotkey_display(app: &AppHandle, command_id: &str) -> Option<String> {
    app.try_state::<NativeHotkeyDisplays>()
        .and_then(|state| state.display(command_id))
}

pub fn hotkey_accelerator(app: &AppHandle, command_id: &str) -> Option<String> {
    app.try_state::<NativeHotkeyDisplays>()
        .and_then(|state| state.accelerator(command_id))
}

#[tauri::command]
pub fn get_hotkey_display(
    state: State<'_, NativeHotkeyDisplays>,
    command_id: String,
) -> Option<String> {
    state.display(&command_id)
}

#[tauri::command]
pub fn set_hotkey_displays(
    app: AppHandle,
    state: State<'_, NativeHotkeyDisplays>,
    displays: Vec<HotkeyDisplayUpdate>,
) -> Result<(), String> {
    state.replace_all(displays)?;
    #[cfg(desktop)]
    crate::tray::sync_hotkey_displays(&app);
    Ok(())
}
