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

use crate::app_events::AppEvent;
use crate::error::{CommandError, CommandErrorCode, CommandResult};
use crate::i18n;
use crate::storage_locks::RootLock;

const SETTINGS_FILE: &str = "desktop-settings.json";

#[derive(Debug, Deserialize, Serialize)]
struct DesktopSettingsFile {
    #[serde(default)]
    revision: u64,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
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

impl Default for DesktopSettingsFile {
    fn default() -> Self {
        Self {
            revision: 0,
            extra: serde_json::Map::new(),
            close_to_tray: false,
            start_in_tray: false,
            custom_window_decorations: None,
            language_code: default_language_code(),
            theme_mode: DesktopThemeMode::default(),
        }
    }
}

fn validate_settings_bytes(raw: &[u8]) -> crate::error::AppResult<()> {
    serde_json::from_slice::<DesktopSettingsFile>(raw)
        .map(|_| ())
        .map_err(|err| {
            crate::error::AppError::InvalidArg(format!("desktop settings corrupt: {err}"))
        })
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
    fn refresh(&self) -> CommandResult<DesktopSettingsFile> {
        let parent = self.path.parent().ok_or_else(|| {
            CommandError::new(CommandErrorCode::Io, "settings path has no parent")
        })?;
        let _lock = RootLock::acquire(parent)?;
        // A refresh never replaces corrupt or missing documents with defaults.
        let raw = fs::read(&self.path)?;
        let file: DesktopSettingsFile = serde_json::from_slice(&raw).map_err(|_| {
            CommandError::new(
                CommandErrorCode::InvalidArgument,
                "desktop settings corrupt",
            )
        })?;
        self.close_to_tray
            .store(file.close_to_tray, Ordering::Relaxed);
        self.start_in_tray
            .store(file.start_in_tray, Ordering::Relaxed);
        self.custom_window_decorations.store(
            file.custom_window_decorations
                .unwrap_or_else(default_custom_window_decorations),
            Ordering::Relaxed,
        );
        if let Ok(mut code) = self.language_code.lock() {
            *code = i18n::normalize_language_code(&file.language_code).to_string();
        }
        if let Ok(mut mode) = self.theme_mode.lock() {
            *mode = file.theme_mode;
        }
        Ok(file)
    }

    fn current_file(&self) -> Option<DesktopSettingsFile> {
        serde_json::from_slice(&fs::read(&self.path).ok()?).ok()
    }
    pub fn load(app: &App) -> CommandResult<Self> {
        let root = crate::paths::app_data_root(app)?;
        let vault = crate::paths::app_data_dir(app)?;
        Self::load_at(&root, &vault)
    }

    pub(crate) fn load_for_coordinator(root: &std::path::Path, id: &str) -> CommandResult<Self> {
        if !crate::profiles::valid_id(id) {
            return Err(CommandError::new(
                CommandErrorCode::InvalidArgument,
                "invalid startup vault",
            ));
        }
        let vault = crate::profiles::profile_dir(root, id);
        Self::load_document(root, &vault, true)
    }

    fn load_at(root: &std::path::Path, vault: &std::path::Path) -> CommandResult<Self> {
        Self::load_document(root, vault, false)
    }

    fn load_document(
        root: &std::path::Path,
        vault: &std::path::Path,
        require_source: bool,
    ) -> CommandResult<Self> {
        let _lock = RootLock::acquire(root)?;
        let path = root.join(SETTINGS_FILE);
        let marker = root.join(".desktop-settings-migrated");
        if marker.try_exists()? && fs::read(&marker)? != b"1" {
            return Err(CommandError::new(
                CommandErrorCode::InvalidArgument,
                "desktop settings migration marker is corrupt; recovery required",
            ));
        }
        crate::root_documents::recover(&path, validate_settings_bytes, validate_settings_bytes)?;
        if !path.try_exists()? {
            if marker.try_exists()? {
                return Err(CommandError::new(
                    CommandErrorCode::Io,
                    "root desktop settings are missing after migration; recovery required",
                ));
            }
            if require_source && !vault.is_dir() {
                return Err(CommandError::new(
                    CommandErrorCode::Io,
                    "startup vault is missing; desktop settings migration refused",
                ));
            }
            let file = Self::read_file(&vault.join(SETTINGS_FILE))?;
            crate::root_documents::write(
                &path,
                &serde_json::to_vec_pretty(&file)
                    .map_err(|err| CommandError::new(CommandErrorCode::Unknown, err.to_string()))?,
                validate_settings_bytes,
            )?;
        }
        let settings = Self::load_from_path(path)?;
        if !marker.try_exists()? {
            crate::atomic_file::write(&marker, b"1")?;
        }
        Ok(settings)
    }

    fn load_from_path(path: PathBuf) -> CommandResult<Self> {
        let file = Self::read_file(&path)?;
        Ok(Self {
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
        })
    }

    fn read_file(path: &std::path::Path) -> CommandResult<DesktopSettingsFile> {
        match fs::read(path) {
            Ok(raw) => serde_json::from_slice::<DesktopSettingsFile>(&raw).map_err(|e| {
                CommandError::new(
                    CommandErrorCode::InvalidArgument,
                    format!("desktop settings corrupt at {}: {e}", path.display()),
                )
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Ok(DesktopSettingsFile::default())
            }
            Err(e) => Err(CommandError::new(
                CommandErrorCode::Io,
                format!("read desktop settings at {}: {e}", path.display()),
            )),
        }
    }

    fn close_to_tray(&self) -> bool {
        if let Some(file) = self.current_file() {
            return file.close_to_tray;
        }
        self.close_to_tray.load(Ordering::Relaxed)
    }

    fn set_close_to_tray(&self, value: bool) -> CommandResult<()> {
        self.update(|file| file.close_to_tray = value)?;
        self.close_to_tray.store(value, Ordering::Relaxed);
        Ok(())
    }

    fn start_in_tray(&self) -> bool {
        if let Some(file) = self.current_file() {
            return file.start_in_tray;
        }
        self.start_in_tray.load(Ordering::Relaxed)
    }

    fn set_start_in_tray(&self, value: bool) -> CommandResult<()> {
        self.update(|file| file.start_in_tray = value)?;
        self.start_in_tray.store(value, Ordering::Relaxed);
        Ok(())
    }

    pub fn custom_window_decorations(&self) -> bool {
        if let Some(file) = self.current_file() {
            return file
                .custom_window_decorations
                .unwrap_or_else(default_custom_window_decorations);
        }
        self.custom_window_decorations.load(Ordering::Relaxed)
    }

    fn set_custom_window_decorations(&self, value: bool) -> CommandResult<()> {
        self.update(|file| file.custom_window_decorations = Some(value))?;
        self.custom_window_decorations
            .store(value, Ordering::Relaxed);
        Ok(())
    }

    pub fn language_code(&self) -> String {
        if let Some(file) = self.current_file() {
            return i18n::normalize_language_code(&file.language_code).to_string();
        }
        self.language_code
            .lock()
            .map(|code| code.clone())
            .unwrap_or_else(|_| default_language_code())
    }

    fn set_language_code(&self, value: &str) -> CommandResult<()> {
        self.update(|file| file.language_code = i18n::normalize_language_code(value).to_string())?;
        if let Ok(mut code) = self.language_code.lock() {
            *code = i18n::normalize_language_code(value).to_string();
        }
        Ok(())
    }

    pub fn theme_mode(&self) -> DesktopThemeMode {
        if let Some(file) = self.current_file() {
            return file.theme_mode;
        }
        self.theme_mode.lock().map(|mode| *mode).unwrap_or_default()
    }

    fn set_theme_mode(&self, value: DesktopThemeMode) -> CommandResult<()> {
        self.update(|file| file.theme_mode = value)?;
        if let Ok(mut mode) = self.theme_mode.lock() {
            *mode = value;
        }
        Ok(())
    }

    fn update(&self, patch: impl FnOnce(&mut DesktopSettingsFile)) -> CommandResult<()> {
        let parent = self.path.parent().ok_or_else(|| {
            CommandError::new(CommandErrorCode::Io, "settings path has no parent")
        })?;
        let _lock = RootLock::acquire(parent)?;
        let mut file = Self::read_file(&self.path)?;
        if parent.join(".desktop-settings-migrated").try_exists()? && !self.path.try_exists()? {
            return Err(CommandError::new(
                CommandErrorCode::Io,
                "root settings disappeared; recovery required",
            ));
        }
        patch(&mut file);
        file.revision = file.revision.checked_add(1).ok_or_else(|| {
            CommandError::new(
                CommandErrorCode::InvalidArgument,
                "desktop settings revision exhausted",
            )
        })?;
        let json = serde_json::to_string_pretty(&file).map_err(|e| {
            CommandError::new(
                CommandErrorCode::Unknown,
                format!("serialize desktop settings: {e}"),
            )
        })?;
        Ok(crate::root_documents::write(
            &self.path,
            json.as_bytes(),
            validate_settings_bytes,
        )?)
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
        if window.is_decorated().ok() == Some(native_decorations) {
            continue;
        }
        window.set_decorations(native_decorations).map_err(|e| {
            CommandError::new(
                CommandErrorCode::Tauri,
                format!("set decorations for {label}: {e}"),
            )
        })?;
    }
    Ok(())
}

/// Call on the native event thread, reading after the callback is scheduled.
/// No root transaction is held while changing windows or publishing events.
pub fn refresh_runtime(app: &AppHandle) -> CommandResult<()> {
    let settings = app.state::<DesktopSettings>();
    let file = settings.refresh()?;
    let custom = file
        .custom_window_decorations
        .unwrap_or_else(default_custom_window_decorations);
    let decorations = apply_window_decorations(app, custom);
    #[cfg(target_os = "macos")]
    crate::native_menu::set_language(app);
    crate::tray::set_language(app, i18n::normalize_language_code(&file.language_code));
    app.emit(AppEvent::CustomWindowDecorationsChanged.as_str(), custom)?;
    app.emit(AppEvent::DesktopSettingsChanged.as_str(), ())?;
    decorations
}

fn changed(app: &AppHandle) -> CommandResult<()> {
    let result = refresh_runtime(app);
    // Persisted changes must reach peers even if a local native window failed.
    #[cfg(desktop)]
    crate::vault_supervisor::device_settings_changed(app);
    result
}

#[tauri::command]
pub fn get_close_to_tray(settings: State<'_, DesktopSettings>) -> bool {
    settings.close_to_tray()
}

#[tauri::command]
pub fn set_close_to_tray(
    app: AppHandle,
    settings: State<'_, DesktopSettings>,
    value: bool,
) -> CommandResult<()> {
    settings.set_close_to_tray(value)?;
    changed(&app)
}

#[tauri::command]
pub fn get_start_in_tray(settings: State<'_, DesktopSettings>) -> bool {
    settings.start_in_tray()
}

#[tauri::command]
pub fn set_start_in_tray(
    app: AppHandle,
    settings: State<'_, DesktopSettings>,
    value: bool,
) -> CommandResult<()> {
    settings.set_start_in_tray(value)?;
    changed(&app)
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
    settings.set_custom_window_decorations(value)?;
    changed(&app)
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
    settings.set_language_code(&code)?;
    changed(&app)
}

#[tauri::command]
pub fn get_desktop_theme_mode(settings: State<'_, DesktopSettings>) -> DesktopThemeMode {
    settings.theme_mode()
}

#[tauri::command]
pub fn set_desktop_theme_mode(
    app: AppHandle,
    settings: State<'_, DesktopSettings>,
    mode: DesktopThemeMode,
) -> CommandResult<()> {
    settings.set_theme_mode(mode)?;
    changed(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_recovery_uses_previous_copy_and_never_reseeds_from_a_stale_vault() {
        let root =
            std::env::temp_dir().join(format!("ms-desktop-recover-{}", uuid::Uuid::new_v4()));
        let vault = root.join("vault");
        fs::create_dir_all(&vault).unwrap();
        let settings = DesktopSettings::load_at(&root, &vault).unwrap();
        settings.set_close_to_tray(true).unwrap();
        settings.set_theme_mode(DesktopThemeMode::Dark).unwrap();
        fs::write(root.join(SETTINGS_FILE), b"broken latest settings").unwrap();
        fs::write(vault.join(SETTINGS_FILE), b"{\"close_to_tray\":false}").unwrap();
        let recovered = DesktopSettings::load_at(&root, &vault).unwrap();
        assert!(recovered.close_to_tray());
        assert_eq!(recovered.theme_mode(), DesktopThemeMode::System);
        fs::remove_file(root.join(SETTINGS_FILE)).unwrap();
        assert!(DesktopSettings::load_at(&root, &vault)
            .unwrap()
            .close_to_tray());
        assert!(fs::read_dir(&root).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("desktop-settings.json.corrupt-")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_completion_marker_is_preserved_and_refused() {
        let root = std::env::temp_dir().join(format!("ms-desktop-marker-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let marker = root.join(".desktop-settings-migrated");
        fs::write(&marker, b"bad marker").unwrap();
        assert!(DesktopSettings::load_at(&root, &root.join("vault")).is_err());
        assert_eq!(fs::read(marker).unwrap(), b"bad marker");
        assert!(!root.join(SETTINGS_FILE).exists());
        fs::remove_dir_all(root).unwrap();
    }

    fn root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("ms-desktop-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn coordinator_seeds_selected_vault_before_concurrent_worker_loads() {
        let root = root();
        let selected = crate::profiles::profile_dir(&root, "selected");
        let other = crate::profiles::profile_dir(&root, "other");
        fs::create_dir_all(&selected).unwrap();
        fs::create_dir_all(&other).unwrap();
        let selected_bytes = br#"{"language_code":"en","theme_mode":"dark","custom_window_decorations":true,"close_to_tray":true,"future":{"keep":1}}"#;
        let other_bytes = br#"{"language_code":"de","theme_mode":"light","custom_window_decorations":false,"close_to_tray":false}"#;
        fs::write(selected.join(SETTINGS_FILE), selected_bytes).unwrap();
        fs::write(other.join(SETTINGS_FILE), other_bytes).unwrap();
        let coordinator = DesktopSettings::load_for_coordinator(&root, "selected").unwrap();
        let canonical = fs::read(root.join(SETTINGS_FILE)).unwrap();
        // The other worker may be first to initialize its native settings.
        std::thread::scope(|scope| {
            for vault in [&other, &selected] {
                let root = &root;
                scope.spawn(move || {
                    let worker = DesktopSettings::load_at(root, vault).unwrap();
                    assert_eq!(worker.language_code(), "en");
                    assert_eq!(worker.theme_mode(), DesktopThemeMode::Dark);
                    assert!(worker.close_to_tray() && worker.custom_window_decorations());
                });
            }
        });
        assert_eq!(coordinator.theme_mode(), DesktopThemeMode::Dark);
        assert_eq!(fs::read(root.join(SETTINGS_FILE)).unwrap(), canonical);
        assert_eq!(
            DesktopSettings::read_file(&root.join(SETTINGS_FILE))
                .unwrap()
                .extra["future"]["keep"],
            1
        );
        assert_eq!(
            fs::read(selected.join(SETTINGS_FILE)).unwrap(),
            selected_bytes
        );
        assert_eq!(fs::read(other.join(SETTINGS_FILE)).unwrap(), other_bytes);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn coordinator_requires_a_real_source_only_for_first_migration() {
        let root = root();
        assert!(DesktopSettings::load_for_coordinator(&root, "../other").is_err());
        assert!(DesktopSettings::load_for_coordinator(&root, "missing").is_err());
        assert!(!root.join(SETTINGS_FILE).exists());
        assert!(!root.join(".desktop-settings-migrated").exists());
        assert!(!root.join("profiles").exists());
        let selected = crate::profiles::profile_dir(&root, "selected");
        fs::create_dir_all(&selected).unwrap();
        fs::write(selected.join(SETTINGS_FILE), br#"{"theme_mode":"dark"}"#).unwrap();
        DesktopSettings::load_for_coordinator(&root, "selected").unwrap();
        let canonical = fs::read(root.join(SETTINGS_FILE)).unwrap();
        // Existing root settings do not depend on the last-used vault still
        // being available; the host can later focus another vault or a picker.
        let loaded = DesktopSettings::load_for_coordinator(&root, "missing").unwrap();
        assert_eq!(loaded.theme_mode(), DesktopThemeMode::Dark);
        assert_eq!(fs::read(root.join(SETTINGS_FILE)).unwrap(), canonical);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refresh_adopts_peer_values_but_preserves_cache_and_evidence_on_bad_reads() {
        let root = root();
        let a = DesktopSettings::load_at(&root, &root.join("a")).unwrap();
        let b = DesktopSettings::load_at(&root, &root.join("b")).unwrap();
        b.set_theme_mode(DesktopThemeMode::Dark).unwrap();
        b.set_language_code("de").unwrap();
        b.set_close_to_tray(true).unwrap();
        let before = fs::read(root.join(SETTINGS_FILE)).unwrap();
        let file = a.refresh().unwrap();
        assert_eq!(file.theme_mode, DesktopThemeMode::Dark);
        assert_eq!(a.language_code(), "de");
        assert_eq!(fs::read(root.join(SETTINGS_FILE)).unwrap(), before);
        fs::write(root.join(SETTINGS_FILE), b"broken").unwrap();
        assert!(a.refresh().is_err());
        assert_eq!(a.theme_mode(), DesktopThemeMode::Dark);
        assert!(a.close_to_tray());
        assert_eq!(fs::read(root.join(SETTINGS_FILE)).unwrap(), b"broken");
        fs::remove_file(root.join(SETTINGS_FILE)).unwrap();
        assert!(a.refresh().is_err());
        assert!(!root.join(SETTINGS_FILE).exists());
        assert_eq!(a.language_code(), "de");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migration_seeds_selected_vault_once_and_root_wins_on_switch() {
        let root = root();
        let vault = root.join("vault");
        fs::create_dir_all(&vault).unwrap();
        fs::write(
            vault.join(SETTINGS_FILE),
            br#"{"close_to_tray":true,"future":{"keep":1}}"#,
        )
        .unwrap();
        let first = DesktopSettings::load_at(&root, &vault).unwrap();
        assert!(first.close_to_tray());
        first.set_start_in_tray(true).unwrap();
        fs::write(vault.join(SETTINGS_FILE), br#"{"close_to_tray":false}"#).unwrap();
        let switched = DesktopSettings::load_at(&root, &root.join("another")).unwrap();
        assert!(switched.close_to_tray() && switched.start_in_tray());
        let file = DesktopSettings::read_file(&root.join(SETTINGS_FILE)).unwrap();
        assert_eq!(file.extra["future"]["keep"], 1);
        assert_eq!(file.revision, 1);
        assert!(vault.join(SETTINGS_FILE).exists());
        fs::remove_file(root.join(SETTINGS_FILE)).unwrap();
        assert!(first.set_close_to_tray(false).is_err());
        let recovered = DesktopSettings::load_at(&root, &vault).unwrap();
        assert!(recovered.close_to_tray());
        assert!(!recovered.start_in_tray());
        fs::remove_file(root.join(SETTINGS_FILE)).unwrap();
        fs::remove_file(root.join("desktop-settings.json.previous")).unwrap();
        assert!(DesktopSettings::load_at(&root, &vault).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn independent_settings_instances_merge_field_patches_and_get_latest_values() {
        let root = root();
        let a = DesktopSettings::load_at(&root, &root.join("a")).unwrap();
        let b = DesktopSettings::load_at(&root, &root.join("b")).unwrap();
        std::thread::scope(|scope| {
            scope.spawn(|| a.set_close_to_tray(true).unwrap());
            scope.spawn(|| b.set_start_in_tray(true).unwrap());
        });
        assert!(a.start_in_tray() && b.close_to_tray());
        assert_eq!(
            DesktopSettings::read_file(&root.join(SETTINGS_FILE))
                .unwrap()
                .revision,
            2
        );
        fs::write(root.join(SETTINGS_FILE), b"{broken").unwrap();
        assert!(a.set_theme_mode(DesktopThemeMode::Dark).is_err());
        assert_eq!(fs::read(root.join(SETTINGS_FILE)).unwrap(), b"{broken");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_settings_are_reported_without_overwriting_them() {
        let root = std::env::temp_dir().join(format!("ms-desktop-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join(SETTINGS_FILE);
        fs::write(&path, b"{broken").unwrap();
        let err = DesktopSettings::load_from_path(path.clone()).err().unwrap();
        assert_eq!(err.code, CommandErrorCode::InvalidArgument);
        assert_eq!(fs::read(path).unwrap(), b"{broken");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_missing_settings_use_defaults() {
        let root = std::env::temp_dir().join(format!("ms-desktop-{}", uuid::Uuid::new_v4()));
        let path = root.join(SETTINGS_FILE);
        let settings = DesktopSettings::load_from_path(path.clone()).unwrap();
        assert!(!settings.close_to_tray());
        settings.set_close_to_tray(true).unwrap();
        let loaded = DesktopSettings::load_from_path(path).unwrap();
        assert!(loaded.close_to_tray());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unreadable_settings_are_not_treated_as_missing() {
        let root = std::env::temp_dir().join(format!("ms-desktop-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let err = DesktopSettings::load_from_path(root.clone()).err().unwrap();
        assert_eq!(err.code, CommandErrorCode::Io);
        assert!(root.is_dir());
        fs::remove_dir_all(root).unwrap();
    }
}
