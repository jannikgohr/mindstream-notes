use std::{collections::HashMap, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::error::{CommandError, CommandErrorCode, CommandResult};

#[cfg(desktop)]
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GlobalShortcutCommandId {
    NewMarkdownNote,
    NewDrawing,
    NewInkNote,
    ShowApp,
}

impl GlobalShortcutCommandId {
    pub fn hotkey_catalogue_id(self) -> &'static str {
        match self {
            Self::NewMarkdownNote => "global.newMarkdownNote",
            Self::NewDrawing => "global.newDrawing",
            Self::NewInkNote => "global.newInkNote",
            Self::ShowApp => "global.showApp",
        }
    }
}

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
    command_id: GlobalShortcutCommandId,
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
) -> CommandResult<Option<String>> {
    if command_id.trim().is_empty() {
        return Err(CommandError::new(
            CommandErrorCode::InvalidArgument,
            "command_id must not be empty",
        ));
    }
    Ok(state.display(&command_id))
}

#[tauri::command]
pub fn set_hotkey_displays(
    #[cfg_attr(not(desktop), allow(unused_variables))] app: AppHandle,
    state: State<'_, NativeHotkeyDisplays>,
    displays: Vec<HotkeyDisplayUpdate>,
) -> CommandResult<()> {
    state.replace_all(displays).map_err(CommandError::from)?;
    #[cfg(desktop)]
    crate::tray::sync_hotkey_displays(&app);
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
pub fn sync_global_shortcuts(
    app: AppHandle,
    state: State<'_, DesktopGlobalShortcuts>,
    registrations: Vec<GlobalShortcutRegistration>,
) -> CommandResult<()> {
    eprintln!(
        "[global-shortcuts] sync_global_shortcuts called with {} registration(s): {:?}",
        registrations.len(),
        registrations
            .iter()
            .map(|r| (r.command_id.hotkey_catalogue_id(), r.accelerator.as_deref()))
            .collect::<Vec<_>>()
    );

    let mut registered = state
        .registered
        .lock()
        .map_err(|_| "global shortcut state is poisoned".to_string())?;

    if !registered.is_empty() {
        eprintln!(
            "[global-shortcuts] unregistering {} previous accelerator(s): {:?}",
            registered.len(),
            *registered
        );
        app.global_shortcut()
            .unregister_multiple(registered.iter().map(String::as_str))
            .map_err(|err| {
                CommandError::new(
                    CommandErrorCode::Tauri,
                    format!("unregister global shortcuts: {err}"),
                )
            })?;
        registered.clear();
    }

    for registration in registrations {
        let Some(accelerator) = clean_optional(registration.accelerator) else {
            eprintln!(
                "[global-shortcuts] skipping {} — no accelerator",
                registration.command_id.hotkey_catalogue_id()
            );
            continue;
        };
        let command_id = registration.command_id;
        let command_id_for_callback = command_id;
        let accelerator_for_log = accelerator.clone();
        eprintln!(
            "[global-shortcuts] registering accelerator={} for command_id={}",
            accelerator,
            command_id.hotkey_catalogue_id()
        );
        match app.global_shortcut().on_shortcut(
            accelerator.as_str(),
            move |app, _shortcut, event| {
                eprintln!(
                    "[global-shortcuts] callback fired command_id={} state={:?}",
                    command_id_for_callback.hotkey_catalogue_id(),
                    event.state
                );
                if event.state != ShortcutState::Pressed {
                    return;
                }
                crate::tray::handle_global_shortcut_command(app, command_id_for_callback);
            },
        ) {
            Ok(()) => {
                eprintln!(
                    "[global-shortcuts] OK accelerator={} command_id={}",
                    accelerator_for_log,
                    command_id.hotkey_catalogue_id()
                );
            }
            Err(err) => {
                eprintln!(
                    "[global-shortcuts] FAILED accelerator={} command_id={} err={}",
                    accelerator_for_log,
                    command_id.hotkey_catalogue_id(),
                    err
                );
                return Err(CommandError::new(
                    CommandErrorCode::Tauri,
                    format!(
                        "register global shortcut {} for {}: {err}",
                        accelerator_for_log,
                        command_id.hotkey_catalogue_id()
                    ),
                ));
            }
        }
        registered.push(accelerator);
    }

    eprintln!(
        "[global-shortcuts] sync complete; {} accelerator(s) active: {:?}",
        registered.len(),
        *registered
    );

    Ok(())
}
