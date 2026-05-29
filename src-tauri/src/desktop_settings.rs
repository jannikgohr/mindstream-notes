use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

use serde::{Deserialize, Serialize};
use tauri::{App, AppHandle, Manager, State};

use crate::i18n;

const SETTINGS_FILE: &str = "desktop-settings.json";

#[derive(Debug, Default, Deserialize, Serialize)]
struct DesktopSettingsFile {
    #[serde(default)]
    close_to_tray: bool,
    #[serde(default = "default_language_code")]
    language_code: String,
}

pub struct DesktopSettings {
    close_to_tray: AtomicBool,
    language_code: Mutex<String>,
    path: PathBuf,
}

impl DesktopSettings {
    pub fn load(app: &App) -> Self {
        let path = app
            .path()
            .app_data_dir()
            .expect("could not resolve app_data_dir")
            .join(SETTINGS_FILE);
        let file = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<DesktopSettingsFile>(&raw).ok())
            .unwrap_or_default();
        Self {
            close_to_tray: AtomicBool::new(file.close_to_tray),
            language_code: Mutex::new(
                i18n::normalize_language_code(&file.language_code).to_string(),
            ),
            path,
        }
    }

    fn close_to_tray(&self) -> bool {
        self.close_to_tray.load(Ordering::Relaxed)
    }

    fn set_close_to_tray(&self, value: bool) {
        self.close_to_tray.store(value, Ordering::Relaxed);
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

    fn save(&self) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create settings dir: {e}"))?;
        }
        let file = DesktopSettingsFile {
            close_to_tray: self.close_to_tray(),
            language_code: self.language_code(),
        };
        let json = serde_json::to_string_pretty(&file)
            .map_err(|e| format!("serialize desktop settings: {e}"))?;
        fs::write(&self.path, json).map_err(|e| format!("write desktop settings: {e}"))
    }
}

fn default_language_code() -> String {
    "en".to_string()
}

pub fn should_close_to_tray(app: &AppHandle) -> bool {
    app.try_state::<DesktopSettings>()
        .map(|settings| settings.close_to_tray())
        .unwrap_or(false)
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
) -> Result<(), String> {
    settings.set_close_to_tray(value);
    settings.save()
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
) -> Result<(), String> {
    settings.set_language_code(&code);
    settings.save()?;
    crate::tray::set_language(&app, &settings.language_code());
    Ok(())
}
