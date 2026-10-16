//! Root-owned data-only themes. Numeric OKLCH tokens cannot inject CSS or URLs.
use crate::{
    error::{AppError, AppResult, CommandResult},
    storage_locks::RootLock,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::Path};
use tauri::{AppHandle, Emitter, Manager};

const FILE: &str = "theme-presets.json";
const MAX_BYTES: usize = 256 * 1024;
const TOKENS: [&str; 12] = [
    "surface-0",
    "surface-1",
    "surface-2",
    "surface-3",
    "border-subtle",
    "border-strong",
    "foreground",
    "muted-foreground",
    "primary",
    "primary-foreground",
    "accent-brand",
    "accent-brand-foreground",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Preset {
    version: u32,
    pub id: String,
    name: String,
    light: BTreeMap<String, [f64; 3]>,
    dark: BTreeMap<String, [f64; 3]>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Document {
    version: u32,
    presets: BTreeMap<String, Preset>,
}

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.as_bytes()[0].is_ascii_lowercase()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn invalid() -> AppError {
    AppError::InvalidArg(
        "invalid theme preset; expected version 1 with validated light/dark OKLCH tokens".into(),
    )
}

fn luminance([l, c, h]: [f64; 3]) -> f64 {
    let a = c * h.to_radians().cos();
    let b = c * h.to_radians().sin();
    let ll = (l + 0.3963377774 * a + 0.2158037573 * b).powi(3);
    let mm = (l - 0.1055613458 * a - 0.0638541728 * b).powi(3);
    let ss = (l - 0.0894841775 * a - 1.2914855480 * b).powi(3);
    let r = (4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss).clamp(0.0, 1.0);
    let g = (-1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss).clamp(0.0, 1.0);
    let blue = (-0.0041960863 * ll - 0.7034186147 * mm + 1.7076147010 * ss).clamp(0.0, 1.0);
    0.2126 * r + 0.7152 * g + 0.0722 * blue
}

fn contrast(a: [f64; 3], b: [f64; 3]) -> f64 {
    let a = luminance(a);
    let b = luminance(b);
    (a.max(b) + 0.05) / (a.min(b) + 0.05)
}

fn validate(preset: &Preset) -> AppResult<()> {
    if preset.version != 1
        || !valid_id(&preset.id)
        || preset.name.trim().is_empty()
        || preset.name.len() > 160
    {
        return Err(invalid());
    }
    for palette in [&preset.light, &preset.dark] {
        if palette.len() != TOKENS.len() || TOKENS.iter().any(|key| !palette.contains_key(*key)) {
            return Err(invalid());
        }
        for [l, c, h] in palette.values() {
            if !l.is_finite()
                || !c.is_finite()
                || !h.is_finite()
                || !(0.0..=1.0).contains(l)
                || !(0.0..=0.4).contains(c)
                || !(0.0..=360.0).contains(h)
            {
                return Err(invalid());
            }
        }
        let surfaces = ["surface-0", "surface-1", "surface-2", "surface-3"].map(|key| palette[key]);
        if surfaces.windows(2).any(|pair| pair[0][0] >= pair[1][0]) {
            return Err(invalid());
        }
        for surface in surfaces {
            if contrast(surface, palette["foreground"]) < 4.5
                || contrast(surface, palette["muted-foreground"]) < 4.5
                || contrast(surface, palette["accent-brand"]) < 3.0
                || contrast(surface, palette["border-subtle"]) < 1.1
                || contrast(surface, palette["border-strong"]) < 1.25
            {
                return Err(invalid());
            }
        }
        if contrast(palette["primary"], palette["primary-foreground"]) < 4.5
            || contrast(palette["accent-brand"], palette["accent-brand-foreground"]) < 4.5
        {
            return Err(invalid());
        }
    }
    Ok(())
}

fn builtins() -> Vec<Preset> {
    serde_json::from_str(include_str!("../../src/lib/settings/theme-presets.json"))
        .expect("bundled theme presets")
}

fn decode(raw: &[u8]) -> AppResult<Document> {
    if raw.len() > MAX_BYTES {
        return Err(invalid());
    }
    let document: Document = serde_json::from_slice(raw).map_err(|_| invalid())?;
    if document.version != 1 || document.presets.len() > 64 {
        return Err(invalid());
    }
    for (id, preset) in &document.presets {
        validate(preset)?;
        if id != &preset.id || builtins().iter().any(|builtin| builtin.id == *id) {
            return Err(invalid());
        }
    }
    Ok(document)
}

fn load(root: &Path) -> AppResult<Document> {
    let path = root.join(FILE);
    if fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(invalid());
    }
    crate::root_documents::recover(
        &path,
        |raw| decode(raw).map(|_| ()),
        |raw| decode(raw).map(|_| ()),
    )?;
    match fs::read(path) {
        Ok(raw) => decode(&raw),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Document {
            version: 1,
            ..Document::default()
        }),
        Err(error) => Err(error.into()),
    }
}

fn edit(root: &Path, preset: Option<Preset>, id: &str) -> AppResult<()> {
    let _lock = RootLock::acquire(root)?;
    if !valid_id(id) || builtins().iter().any(|preset| preset.id == id) {
        return Err(invalid());
    }
    let mut document = load(root)?;
    if let Some(preset) = preset {
        validate(&preset)?;
        document.presets.insert(id.into(), preset);
    } else {
        document.presets.remove(id);
    }
    let raw = serde_json::to_vec_pretty(&document).map_err(|_| invalid())?;
    crate::root_documents::write(&root.join(FILE), &raw, |raw| decode(raw).map(|_| ()))
}

/// Caller holds RootLock; builtins travel in the application, not the backup.
pub(crate) fn backup_presets(root: &Path) -> AppResult<Vec<Preset>> {
    Ok(load(root)?.presets.into_values().collect())
}

pub(crate) fn validate_backup_presets(presets: &[Preset]) -> AppResult<()> {
    let mut document = Document {
        version: 1,
        ..Document::default()
    };
    for preset in presets {
        if document
            .presets
            .insert(preset.id.clone(), preset.clone())
            .is_some()
        {
            return Err(invalid());
        }
    }
    decode(&serde_json::to_vec(&document).map_err(|_| invalid())?)?;
    Ok(())
}

/// Caller holds RootLock. Existing IDs, including builtins, always win.
pub(crate) fn restore_backup_presets(root: &Path, presets: &[Preset]) -> AppResult<()> {
    validate_backup_presets(presets)?;
    let mut document = load(root)?;
    for preset in presets {
        document
            .presets
            .entry(preset.id.clone())
            .or_insert_with(|| preset.clone());
    }
    let raw = serde_json::to_vec(&document).map_err(|_| invalid())?;
    crate::root_documents::write(&root.join(FILE), &raw, |raw| decode(raw).map(|_| ()))
}

fn notify(app: &AppHandle) {
    let _ = app.emit(crate::app_events::AppEvent::UiSettingsChanged.as_str(), ());
    #[cfg(desktop)]
    crate::vault_supervisor::device_settings_changed(app);
}

#[tauri::command]
pub fn get_theme_appearance(app: AppHandle) -> CommandResult<serde_json::Value> {
    Ok(appearance(&app)?)
}

fn appearance(app: &AppHandle) -> AppResult<serde_json::Value> {
    let root = crate::paths::app_data_root(app)?;
    #[cfg(desktop)]
    let mode = app
        .try_state::<crate::desktop_settings::DesktopSettings>()
        .map(|settings| settings.theme_mode())
        .unwrap_or_default();
    #[cfg(not(desktop))]
    let mode: Option<&str> = None;
    appearance_at(&root, mode)
}

/// The appearance a new window paints before its settings load.
fn appearance_at(root: &Path, mode: impl Serialize) -> AppResult<serde_json::Value> {
    let _lock = RootLock::acquire(root)?;
    let values = crate::ui_settings::appearance_values(root)?;
    let id = values
        .get("appearance.preset")
        .and_then(|id| id.as_str())
        .unwrap_or("default");
    let mut presets = builtins();
    match load(root) {
        Ok(document) => presets.extend(document.presets.into_values()),
        Err(error) => log::warn!("theme catalog unavailable; using built-in fallback: {error}"),
    }
    let preset = presets
        .iter()
        .find(|preset| preset.id == id)
        .unwrap_or(&presets[0]);
    Ok(
        serde_json::json!({"preset":preset,"accent":values.get("appearance.accent"),"uiFontSize":values.get("appearance.uiFontSize").cloned().unwrap_or(serde_json::json!(16)),"mode":mode}),
    )
}

pub(crate) fn initialization_script(app: &AppHandle) -> AppResult<String> {
    let appearance = appearance(app)?;
    Ok(format!("window.__MINDSTREAM_APPEARANCE__ = {appearance};try {{localStorage.setItem('mindstream:appearance:v1', JSON.stringify(window.__MINDSTREAM_APPEARANCE__));if(typeof window.__MINDSTREAM_APPEARANCE__.mode === 'string') localStorage.setItem('mode-watcher-mode', window.__MINDSTREAM_APPEARANCE__.mode);}} catch (_) {{}}"))
}

#[tauri::command]
pub fn list_theme_presets(app: AppHandle) -> CommandResult<Vec<Preset>> {
    Ok(catalog(&crate::paths::app_data_root(&app)?)?)
}

/// Built-ins first, then the root's user presets.
fn catalog(root: &Path) -> AppResult<Vec<Preset>> {
    let _lock = RootLock::acquire(root)?;
    let mut presets = builtins();
    presets.extend(load(root)?.presets.into_values());
    Ok(presets)
}

#[tauri::command]
pub fn save_theme_preset(app: AppHandle, raw: String) -> CommandResult<()> {
    if raw.len() > 16384 {
        return Err(invalid().into());
    }
    let preset: Preset = serde_json::from_str(&raw).map_err(|_| invalid())?;
    let job = app.state::<crate::vault_jobs::Saves>().enter()?;
    edit(
        &crate::paths::app_data_root(&app)?,
        Some(preset.clone()),
        &preset.id,
    )?;
    notify(&app);
    drop(job);
    Ok(())
}

#[tauri::command]
pub fn delete_theme_preset(app: AppHandle, id: String) -> CommandResult<()> {
    let job = app.state::<crate::vault_jobs::Saves>().enter()?;
    edit(&crate::paths::app_data_root(&app)?, None, &id)?;
    notify(&app);
    drop(job);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn builtins_preserve_elevation_and_text_contrast_in_both_modes() {
        for preset in builtins() {
            validate(&preset).unwrap();
        }
    }
    #[test]
    fn invalid_tokens_paths_and_low_contrast_are_rejected() {
        let mut preset = builtins().remove(0);
        preset.id = "../outside".into();
        assert!(validate(&preset).is_err());
        preset.id = "custom".into();
        preset.light.insert("background".into(), [0.9, 0.0, 0.0]);
        assert!(validate(&preset).is_err());
        preset.light.remove("background");
        preset
            .dark
            .insert("foreground".into(), preset.dark["surface-1"]);
        assert!(validate(&preset).is_err());
    }
    #[test]
    fn edits_keep_other_presets_and_recover_corruption_without_discarding_bytes() {
        let root = std::env::temp_dir().join(format!("ms-themes-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let mut preset = builtins().remove(0);
        preset.id = "custom".into();
        edit(&root, Some(preset.clone()), &preset.id).unwrap();
        preset.id = "second".into();
        edit(&root, Some(preset.clone()), &preset.id).unwrap();
        assert_eq!(load(&root).unwrap().presets.len(), 2);
        edit(&root, None, "custom").unwrap();
        assert!(!load(&root).unwrap().presets.contains_key("custom"));
        fs::write(root.join(FILE), b"broken original").unwrap();
        assert_eq!(load(&root).unwrap().presets.len(), 2);
        assert!(fs::read_dir(&root).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".corrupt-")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_vault_edits_publish_both_user_presets_under_the_root_lock() {
        let root = std::env::temp_dir().join(format!("ms-theme-race-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        std::thread::scope(|scope| {
            for id in ["first", "second"] {
                let root = &root;
                scope.spawn(move || {
                    let mut preset = builtins().remove(0);
                    preset.id = id.into();
                    edit(root, Some(preset), id).unwrap();
                });
            }
        });
        let document = load(&root).unwrap();
        assert!(document.presets.contains_key("first") && document.presets.contains_key("second"));
        assert!(edit(&root, Some(builtins().remove(0)), "default").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn new_windows_paint_the_selected_preset_or_fall_back_to_the_first_builtin() {
        let root = std::env::temp_dir().join(format!("ms-theme-paint-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let first = builtins().remove(0);
        let fresh = appearance_at(&root, "dark").unwrap();
        assert_eq!(fresh["preset"]["id"], first.id.as_str());
        assert_eq!(fresh["accent"], serde_json::Value::Null);
        assert_eq!(fresh["uiFontSize"], 16);
        assert_eq!(fresh["mode"], "dark");

        let mut custom = first.clone();
        custom.id = "custom".into();
        edit(&root, Some(custom), "custom").unwrap();
        fs::write(
            root.join("ui-settings.json"),
            r##"{"version":1,"revision":1,"values":{"appearance.preset":"custom","appearance.accent":"#abcdef","appearance.uiFontSize":14}}"##,
        )
        .unwrap();
        let selected = appearance_at(&root, Option::<&str>::None).unwrap();
        assert_eq!(selected["preset"]["id"], "custom");
        assert_eq!(selected["accent"], "#abcdef");
        assert_eq!(selected["uiFontSize"], 14);
        assert_eq!(selected["mode"], serde_json::Value::Null);
        let ids: Vec<_> = catalog(&root)
            .unwrap()
            .into_iter()
            .map(|preset| preset.id)
            .collect();
        assert_eq!(ids.first(), Some(&first.id));
        assert_eq!(ids.last().map(String::as_str), Some("custom"));

        // A damaged catalog cannot block painting; listing reports it.
        fs::write(root.join(FILE), b"broken").unwrap();
        fs::remove_file(root.join(format!("{FILE}.previous"))).ok();
        let fallback = appearance_at(&root, "light").unwrap();
        assert_eq!(fallback["preset"]["id"], first.id.as_str());
        assert!(catalog(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
