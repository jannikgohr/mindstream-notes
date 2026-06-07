use std::{collections::HashMap, sync::Mutex};

use serde::Deserialize;
use tauri::{AppHandle, Manager, State};

#[cfg(desktop)]
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[cfg(desktop)]
const GLOBAL_SHORTCUT_COMMAND_IDS: &[&str] = &[
    "global.newMarkdownNote",
    "global.newDrawing",
    "global.newInkNote",
    "global.showApp",
];

#[derive(Clone, Debug, Default)]
struct NativeHotkeyDisplay {
    display: Option<String>,
    accelerator: Option<String>,
}

#[derive(Default)]
pub struct NativeHotkeyDisplays {
    values: Mutex<HashMap<String, NativeHotkeyDisplay>>,
}

#[cfg(desktop)]
#[derive(Default)]
pub struct DesktopGlobalShortcuts {
    registered: Mutex<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyDisplayUpdate {
    command_id: String,
    display: Option<String>,
    accelerator: Option<String>,
}

#[cfg(desktop)]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalShortcutRegistration {
    command_id: String,
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

#[cfg(desktop)]
fn is_global_shortcut_command_id(command_id: &str) -> bool {
    GLOBAL_SHORTCUT_COMMAND_IDS.contains(&command_id)
}

#[cfg(desktop)]
#[tauri::command]
pub fn sync_global_shortcuts(
    app: AppHandle,
    state: State<'_, DesktopGlobalShortcuts>,
    registrations: Vec<GlobalShortcutRegistration>,
) -> Result<(), String> {
    let mut registered = state
        .registered
        .lock()
        .map_err(|_| "global shortcut state is poisoned".to_string())?;

    if !registered.is_empty() {
        app.global_shortcut()
            .unregister_multiple(registered.iter().map(String::as_str))
            .map_err(|err| format!("unregister global shortcuts: {err}"))?;
        registered.clear();
    }

    for registration in registrations {
        if !is_global_shortcut_command_id(&registration.command_id) {
            continue;
        }
        let Some(accelerator) = clean_optional(registration.accelerator) else {
            continue;
        };
        let command_id = registration.command_id.clone();
        app.global_shortcut()
            .on_shortcut(accelerator.as_str(), move |app, _shortcut, event| {
                if event.state != ShortcutState::Pressed {
                    return;
                }
                crate::tray::handle_global_shortcut_command(app, &command_id);
            })
            .map_err(|err| {
                format!(
                    "register global shortcut {} for {}: {err}",
                    accelerator, registration.command_id
                )
            })?;
        registered.push(accelerator);
    }

    Ok(())
}
