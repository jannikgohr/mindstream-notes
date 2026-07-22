use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

use serde::{Deserialize, Serialize};
use tauri::{App, AppHandle, Emitter, Manager, State};

use crate::error::{CommandError, CommandErrorCode, CommandResult};
use crate::i18n;

const SETTINGS_FILE: &str = "desktop-settings.json";
const CUSTOM_WINDOW_DECORATIONS_CHANGED_EVENT: &str = "custom-window-decorations-changed";

#[derive(Debug, Default, Deserialize, Serialize)]
struct DesktopSettingsFile {
    #[serde(default)]
    close_to_tray: bool,
    #[serde(default)]
    start_in_tray: bool,
    #[serde(default)]
    custom_window_decorations: Option<bool>,
    #[serde(default = "default_language_code")]
    language_code: String,
    #[serde(default)]
    theme_mode: DesktopThemeMode,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DesktopThemeMode {
    Light,
    Dark,
    #[default]
    System,
}

pub struct DesktopSettings {
    close_to_tray: AtomicBool,
    start_in_tray: AtomicBool,
    custom_window_decorations: AtomicBool,
    language_code: Mutex<String>,
    theme_mode: Mutex<DesktopThemeMode>,
    path: PathBuf,
}

impl DesktopSettings {
    pub fn load(app: &App) -> Self {
        let path = crate::paths::app_data_dir(app)
            .expect("could not resolve app_data_dir")
            .join(SETTINGS_FILE);
        let file = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<DesktopSettingsFile>(&raw).ok())
            .unwrap_or_default();
        Self {
            close_to_tray: AtomicBool::new(file.close_to_tray),
            start_in_tray: AtomicBool::new(file.start_in_tray),
            custom_window_decorations: AtomicBool::new(
                file.custom_window_decorations
                    .unwrap_or_else(default_custom_window_decorations),
            ),
            language_code: Mutex::new(
                i18n::normalize_language_code(&file.language_code).to_string(),
            ),
            theme_mode: Mutex::new(file.theme_mode),
            path,
        }
    }

    fn close_to_tray(&self) -> bool {
        self.close_to_tray.load(Ordering::Relaxed)
    }

    fn set_close_to_tray(&self, value: bool) {
        self.close_to_tray.store(value, Ordering::Relaxed);
    }

    fn start_in_tray(&self) -> bool {
        self.start_in_tray.load(Ordering::Relaxed)
    }

    fn set_start_in_tray(&self, value: bool) {
        self.start_in_tray.store(value, Ordering::Relaxed);
    }

    pub fn custom_window_decorations(&self) -> bool {
        self.custom_window_decorations.load(Ordering::Relaxed)
    }

    fn set_custom_window_decorations(&self, value: bool) {
        self.custom_window_decorations
            .store(value, Ordering::Relaxed);
    }

    pub fn language_code(&self) -> String {
        self.language_code
            .lock()
            .map(|code| code.clone())
            .unwrap_or_else(|_| default_language_code())
    }

    fn set_language_code(&self, value: &str) {
        if let Ok(mut code) = self.language_code.lock() {
            *code = i18n::normalize_language_code(value).to_string();
        }
    }

    pub fn theme_mode(&self) -> DesktopThemeMode {
        self.theme_mode.lock().map(|mode| *mode).unwrap_or_default()
    }

    fn set_theme_mode(&self, value: DesktopThemeMode) {
        if let Ok(mut mode) = self.theme_mode.lock() {
            *mode = value;
        }
    }

    fn save(&self) -> CommandResult<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                CommandError::new(CommandErrorCode::Io, format!("create settings dir: {e}"))
            })?;
        }
        let file = DesktopSettingsFile {
            close_to_tray: self.close_to_tray(),
            start_in_tray: self.start_in_tray(),
            custom_window_decorations: Some(self.custom_window_decorations()),
            language_code: self.language_code(),
            theme_mode: self.theme_mode(),
        };
        let json = serde_json::to_string_pretty(&file).map_err(|e| {
            CommandError::new(
                CommandErrorCode::Unknown,
                format!("serialize desktop settings: {e}"),
            )
        })?;
        fs::write(&self.path, json).map_err(|e| {
            CommandError::new(CommandErrorCode::Io, format!("write desktop settings: {e}"))
        })
    }
}

fn default_language_code() -> String {
    "en".to_string()
}

pub fn default_custom_window_decorations() -> bool {
    !cfg!(target_os = "macos")
}

pub fn should_close_to_tray(app: &AppHandle) -> bool {
    app.try_state::<DesktopSettings>()
        .map(|settings| settings.close_to_tray())
        .unwrap_or(false)
}

pub fn should_start_in_tray(app: &AppHandle) -> bool {
    app.try_state::<DesktopSettings>()
        .map(|settings| settings.start_in_tray())
        .unwrap_or(false)
}

pub fn should_use_custom_window_decorations(app: &AppHandle) -> bool {
    app.try_state::<DesktopSettings>()
        .map(|settings| settings.custom_window_decorations())
        .unwrap_or_else(default_custom_window_decorations)
}

pub fn apply_window_decorations(app: &AppHandle, custom_decorations: bool) -> CommandResult<()> {
    let native_decorations = !custom_decorations;
    for (label, window) in app.webview_windows() {
        window.set_decorations(native_decorations).map_err(|e| {
            CommandError::new(
                CommandErrorCode::Tauri,
                format!("set decorations for {label}: {e}"),
            )
        })?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_close_to_tray(settings: State<'_, DesktopSettings>) -> bool {
    settings.close_to_tray()
}

#[tauri::command]
pub fn set_close_to_tray(
    _app: AppHandle,
    settings: State<'_, DesktopSettings>,
    value: bool,
) -> CommandResult<()> {
    settings.set_close_to_tray(value);
    settings.save()
}

#[tauri::command]
pub fn get_start_in_tray(settings: State<'_, DesktopSettings>) -> bool {
    settings.start_in_tray()
}

#[tauri::command]
pub fn set_start_in_tray(
    _app: AppHandle,
    settings: State<'_, DesktopSettings>,
    value: bool,
) -> CommandResult<()> {
    settings.set_start_in_tray(value);
    settings.save()
}

#[tauri::command]
pub fn get_custom_window_decorations(settings: State<'_, DesktopSettings>) -> bool {
    settings.custom_window_decorations()
}

#[tauri::command]
pub fn set_custom_window_decorations(
    app: AppHandle,
    settings: State<'_, DesktopSettings>,
    value: bool,
) -> CommandResult<()> {
    settings.set_custom_window_decorations(value);
    settings.save()?;
    apply_window_decorations(&app, value)?;
    app.emit(CUSTOM_WINDOW_DECORATIONS_CHANGED_EVENT, value)
        .map_err(|e| {
            CommandError::new(
                CommandErrorCode::Tauri,
                format!("emit window decorations change: {e}"),
            )
        })
}

#[tauri::command]
pub fn get_desktop_language(settings: State<'_, DesktopSettings>) -> String {
    settings.language_code()
}

#[tauri::command]
pub fn set_desktop_language(
    app: AppHandle,
    settings: State<'_, DesktopSettings>,
    code: String,
) -> CommandResult<()> {
    settings.set_language_code(&code);
    settings.save()?;
    #[cfg(target_os = "macos")]
    crate::native_menu::set_language(&app);
    crate::tray::set_language(&app, &settings.language_code());
    Ok(())
}

#[tauri::command]
pub fn get_desktop_theme_mode(settings: State<'_, DesktopSettings>) -> DesktopThemeMode {
    settings.theme_mode()
}

#[tauri::command]
pub fn set_desktop_theme_mode(
    settings: State<'_, DesktopSettings>,
    mode: DesktopThemeMode,
) -> CommandResult<()> {
    settings.set_theme_mode(mode);
    settings.save()
}
