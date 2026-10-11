//! Schema settings persisted outside WebView storage. Every transaction holds
//! RootLock; the process also holds the active vault's lifetime ownership lock.
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{AppError, AppResult, CommandResult};
use crate::storage_locks::RootLock;

type Values = BTreeMap<String, Value>;
const MAX_BYTES: usize = 1024 * 1024;
static SCOPES: LazyLock<BTreeMap<String, bool>> = LazyLock::new(|| {
    let schema: Value = serde_json::from_str(include_str!("../../src/lib/settings/schema.json"))
        .expect("bundled settings schema");
    let mut scopes = BTreeMap::new();
    for category in schema["categories"].as_array().expect("categories") {
        for section in category["sections"].as_array().expect("sections") {
            for setting in section["settings"].as_array().expect("settings") {
                scopes.insert(
                    setting["id"].as_str().expect("id").to_owned(),
                    setting["scope"] == "D",
                );
            }
        }
    }
    scopes
});

fn device_scope(id: &str) -> bool {
    if matches!(
        id,
        "appearance.leftSidebarWidth"
            | "appearance.rightSidebarWidth"
            | "ui.fileTreeToolbar"
            | "ui.mobileDisplayMode"
    ) {
        return true;
    }
    // Dynamic command bindings are device preferences. Unknown/plugin entries
    // stay with their vault until their separate persistence owner migrates them.
    SCOPES
        .get(id)
        .copied()
        .unwrap_or_else(|| id.starts_with("hotkey."))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Document {
    version: u32,
    revision: u64,
    values: Values,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    device_revision: u64,
    vault_revision: u64,
    values: Values,
}

fn invalid() -> AppError {
    AppError::InvalidArg("invalid UI settings document; preserve it for recovery".into())
}

fn validate_values(values: &Values) -> AppResult<()> {
    if values.len() > 4096 || values.keys().any(|id| id.is_empty() || id.len() > 512) {
        return Err(invalid());
    }
    Ok(())
}

fn decode(raw: &[u8], device: bool) -> AppResult<Document> {
    if raw.len() > MAX_BYTES {
        return Err(invalid());
    }
    let document: Document = serde_json::from_slice(raw).map_err(|_| invalid())?;
    validate_values(&document.values)?;
    for (id, value) in &document.values {
        validate_preference(id, value)?;
    }
    if document.version != 1
        || document
            .values
            .keys()
            .any(|id| device_scope(id) != device && !(device && id == "appearance.sortStrategy"))
    {
        return Err(invalid());
    }
    Ok(document)
}

fn read(path: &Path, device: bool) -> AppResult<Document> {
    decode(&fs::read(path)?, device)
}

fn marker(path: &Path) -> std::path::PathBuf {
    path.with_extension("migrated")
}

fn recover(path: &Path, device: bool) -> AppResult<()> {
    crate::root_documents::recover(
        path,
        |raw| decode(raw, device).map(|_| ()),
        |raw| decode(raw, device).map(|_| ()),
    )?;
    match fs::read(marker(path)) {
        Ok(raw) if raw == b"1" && path.try_exists()? => Ok(()),
        Ok(_) => Err(AppError::InvalidArg(
            "UI settings migration record cannot be reconciled".into(),
        )),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

fn legacy(raw: Option<&str>) -> AppResult<Values> {
    let Some(raw) = raw else {
        return Ok(Values::new());
    };
    if raw.len() > MAX_BYTES {
        return Err(invalid());
    }
    let values: Values = serde_json::from_str(raw).map_err(|_| invalid())?;
    validate_values(&values)?;
    Ok(values)
}

fn save(path: &Path, document: &Document, device: bool) -> AppResult<()> {
    let raw = serde_json::to_vec_pretty(document).map_err(|_| invalid())?;
    crate::root_documents::write(path, &raw, |raw| decode(raw, device).map(|_| ()))
}

fn snapshot(device: Document, vault: Document) -> Snapshot {
    let mut values = device.values;
    values.extend(vault.values);
    Snapshot {
        device_revision: device.revision,
        vault_revision: vault.revision,
        values,
    }
}

fn initialize_with_browser_state(
    root: &Path,
    vault: &Path,
    vault_id: &str,
    device_raw: Option<&str>,
    vault_raw: Option<&str>,
    preferences_raw: Option<&str>,
    layout_raw: Option<&str>,
) -> AppResult<Snapshot> {
    initialize_classified(
        root,
        vault,
        vault_id,
        BrowserState {
            device_raw,
            vault_raw,
            preferences_raw,
            layout_raw,
            archive_owner: None,
        },
    )
}

struct BrowserState<'a> {
    device_raw: Option<&'a str>,
    vault_raw: Option<&'a str>,
    preferences_raw: Option<&'a str>,
    layout_raw: Option<&'a str>,
    archive_owner: Option<bool>,
}

fn initialize_classified(
    root: &Path,
    vault: &Path,
    vault_id: &str,
    input: BrowserState<'_>,
) -> AppResult<Snapshot> {
    let BrowserState {
        device_raw,
        vault_raw,
        preferences_raw,
        layout_raw,
        archive_owner,
    } = input;
    let _lock = RootLock::acquire(root)?;
    let device_path = root.join("ui-settings.json");
    let vault_path = vault.join("content-settings.json");
    recover(&device_path, true)?;
    recover(&vault_path, false)?;
    // Prepare both candidates before publishing either, so a malformed legacy
    // bucket cannot be replaced by defaults from a partial migration.
    let need_device = !device_path.try_exists()?;
    let need_vault = !vault_path.try_exists()?;
    let legacy_device =
        if need_device || (need_vault && vault_id == "default" && vault_raw.is_none()) {
            legacy(device_raw)?
        } else {
            Values::new()
        };
    let mut device = if need_device {
        Document {
            version: 1,
            revision: 0,
            values: legacy_device
                .iter()
                .filter(|(id, _)| device_scope(id))
                .map(|(id, v)| (id.clone(), v.clone()))
                .collect(),
        }
    } else {
        read(&device_path, true)?
    };
    let mut vault_doc = if need_vault {
        let values = if vault_raw.is_some() {
            legacy(vault_raw)?
        } else if vault_id == "default" {
            legacy_device
        } else {
            Values::new()
        };
        Document {
            version: 1,
            revision: 0,
            values: values
                .into_iter()
                .filter(|(id, _)| !device_scope(id))
                .collect(),
        }
    } else {
        read(&vault_path, false)?
    };
    let preferences_marker = root.join(".ui-preferences-migrated");
    let preferences_receipt = match fs::read(&preferences_marker) {
        Ok(raw) if raw == b"1" || raw == b"2" => Some(raw),
        Ok(_) => {
            return Err(AppError::InvalidArg(
                "invalid UI preferences migration record".into(),
            ))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => return Err(err.into()),
    };
    let need_preferences = preferences_receipt.is_none();
    let content_preferences_marker = vault.join(".ui-content-preferences-migrated");
    let need_content_preferences = match archive_owner {
        None => need_preferences,
        Some(false) => false,
        // Version 1 already imported all preferences in the live legacy store.
        Some(true) if preferences_receipt.as_deref() == Some(b"1") => false,
        Some(true) => match fs::read(&content_preferences_marker) {
            Ok(raw) if raw == b"1" => false,
            Ok(_) => return Err(invalid()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => true,
            Err(err) => return Err(err.into()),
        },
    };
    let mut device_changed = false;
    let mut vault_changed = false;
    let layout_marker = vault.join(".dock-layout-migrated");
    let need_layout = match fs::read(&layout_marker) {
        Ok(raw) if raw == b"1" => false,
        Ok(_) => {
            return Err(AppError::InvalidArg(
                "invalid dock layout migration record".into(),
            ))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => true,
        Err(err) => return Err(err.into()),
    };
    if need_layout && !vault_doc.values.contains_key("ui.dockLayout") {
        if let Some(raw) = layout_raw {
            if raw.len() > MAX_BYTES {
                return Err(invalid());
            }
            let value: Value = serde_json::from_str(raw).map_err(|_| invalid())?;
            validate_preference("ui.dockLayout", &value)?;
            if value.is_null() {
                return Err(invalid());
            }
            vault_doc.values.insert("ui.dockLayout".into(), value);
            vault_changed = true;
        }
    }
    if let Some(sort) = device.values.remove("appearance.sortStrategy") {
        device_changed = true;
        if need_content_preferences && !vault_doc.values.contains_key("appearance.sortStrategy") {
            vault_doc
                .values
                .insert("appearance.sortStrategy".into(), sort);
            vault_changed = true;
        }
    }
    if need_preferences || need_content_preferences {
        let preferences = legacy(preferences_raw)?;
        for (key, id, is_device) in [
            ("leftSidebarWidth", "appearance.leftSidebarWidth", true),
            ("rightSidebarWidth", "appearance.rightSidebarWidth", true),
            ("leftSidebarOpen", "ui.leftSidebarOpen", false),
            ("rightSidebarOpen", "ui.rightSidebarOpen", false),
            ("sortStrategy", "appearance.sortStrategy", false),
            ("sortDirection", "ui.sortDirection", false),
        ] {
            if (is_device && !need_preferences) || (!is_device && !need_content_preferences) {
                continue;
            }
            if let Some(value) = preferences.get(key) {
                validate_preference(id, value)?;
                let document = if is_device {
                    &mut device
                } else {
                    &mut vault_doc
                };
                if !document.values.contains_key(id) {
                    document.values.insert(id.into(), value.clone());
                    if is_device {
                        device_changed = true;
                    } else {
                        vault_changed = true;
                    }
                }
            }
        }
    }
    if device_changed && !need_device {
        device.revision = device.revision.checked_add(1).ok_or_else(invalid)?;
    }
    if vault_changed && !need_vault {
        vault_doc.revision = vault_doc.revision.checked_add(1).ok_or_else(invalid)?;
    }
    if need_vault || vault_changed {
        save(&vault_path, &vault_doc, false)?;
    }
    if need_device || device_changed {
        save(&device_path, &device, true)?;
    }
    for path in [&device_path, &vault_path] {
        if !marker(path).try_exists()? {
            crate::atomic_file::write(&marker(path), b"1")?;
        }
    }
    if need_preferences {
        crate::atomic_file::write(
            &preferences_marker,
            if archive_owner.is_some() { b"2" } else { b"1" },
        )?;
    }
    if need_content_preferences && archive_owner == Some(true) {
        crate::atomic_file::write(&content_preferences_marker, b"1")?;
    }
    if need_layout {
        crate::atomic_file::write(&layout_marker, b"1")?;
    }
    Ok(snapshot(device, vault_doc))
}

fn validate_preference(id: &str, value: &Value) -> AppResult<()> {
    let valid = match id {
        "ui.mobileDisplayMode" => matches!(value.as_str(), Some("list" | "grid")),
        "ui.fileTreeToolbar" => {
            value.is_object()
                && ["toolbar", "more"].iter().all(|key| {
                    value[*key].as_array().is_some_and(|ids| {
                        ids.len() <= 512
                            && ids.iter().all(|id| {
                                id.as_str()
                                    .is_some_and(|id| !id.is_empty() && id.len() <= 512)
                            })
                    })
                })
        }
        "appearance.leftSidebarWidth" | "appearance.rightSidebarWidth" => value
            .as_f64()
            .is_some_and(|v| v.is_finite() && (0.0..=10000.0).contains(&v)),
        "ui.leftSidebarOpen" | "ui.rightSidebarOpen" => value.is_boolean(),
        "appearance.sortStrategy" => matches!(
            value.as_str(),
            Some("alphabetical" | "modified" | "created")
        ),
        "ui.sortDirection" => matches!(value.as_str(), Some("asc" | "desc")),
        "ui.dockLayout" => {
            value.is_null()
                || (value.is_object()
                    && value["version"].as_u64() == Some(1)
                    && value["dock"].is_object()
                    && value.get("activeNoteId").is_some_and(|v| {
                        v.is_null() || v.as_str().is_some_and(|id| id.len() <= 1024)
                    })
                    && value["savedAt"].as_str().is_some_and(|date| {
                        chrono::DateTime::parse_from_rfc3339(date).is_ok_and(|t| {
                            t.with_timezone(&chrono::Utc)
                                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                                == date
                        })
                    }))
        }
        _ => true,
    };
    if valid {
        Ok(())
    } else {
        Err(invalid())
    }
}

/// Inputs remain raw until the backend has checked the root's migration receipt.
/// A completed migration must not be blocked or overwritten by stale browser bytes.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceBrowserState {
    toolbar_raw: Option<String>,
    had_existing_data: bool,
    display_mode_raw: Option<String>,
}

fn migrate_device_ui(root: &Path, input: &DeviceBrowserState) -> AppResult<()> {
    let _lock = RootLock::acquire(root)?;
    let receipt = root.join(".device-ui-migrated");
    match fs::read(&receipt) {
        Ok(raw) if raw == b"1" => return Ok(()),
        Ok(_) => return Err(invalid()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.into()),
    }
    let path = root.join("ui-settings.json");
    recover(&path, true)?;
    let mut document = read(&path, true)?;
    let mut changed = false;
    if !document.values.contains_key("ui.fileTreeToolbar") {
        let value = if let Some(raw) = &input.toolbar_raw {
            if raw.len() > MAX_BYTES {
                return Err(invalid());
            }
            serde_json::from_str(raw).map_err(|_| invalid())?
        } else if input.had_existing_data {
            serde_json::json!({"toolbar": ["folder", "drawing", "ink", "kanban", "pdf", "note"], "more": []})
        } else {
            serde_json::json!({"toolbar": ["note", "folder", "drawing"], "more": ["ink", "pdf", "kanban"]})
        };
        validate_preference("ui.fileTreeToolbar", &value)?;
        document.values.insert("ui.fileTreeToolbar".into(), value);
        changed = true;
    }
    if !document.values.contains_key("ui.mobileDisplayMode") {
        let value = Value::String(
            input
                .display_mode_raw
                .clone()
                .unwrap_or_else(|| "list".into()),
        );
        validate_preference("ui.mobileDisplayMode", &value)?;
        document.values.insert("ui.mobileDisplayMode".into(), value);
        changed = true;
    }
    if changed {
        document.revision = document.revision.checked_add(1).ok_or_else(invalid)?;
        save(&path, &document, true)?;
    }
    crate::atomic_file::write(&receipt, b"1")?;
    Ok(())
}

fn access(
    root: &Path,
    vault: &Path,
    patch: Option<(String, Option<Value>)>,
) -> AppResult<Snapshot> {
    let _lock = RootLock::acquire(root)?;
    let device_path = root.join("ui-settings.json");
    let vault_path = vault.join("content-settings.json");
    recover(&device_path, true)?;
    recover(&vault_path, false)?;
    let mut device = read(&device_path, true)?;
    let mut content = read(&vault_path, false)?;
    // A previous root copy can predate the completed scope correction. Keep
    // that legacy field out of all snapshots; the one-time migration already
    // copied it to its owner. The recovery copy retains its original bytes.
    if device.values.remove("appearance.sortStrategy").is_some() {
        device.revision = device.revision.checked_add(1).ok_or_else(invalid)?;
        save(&device_path, &device, true)?;
    }
    if let Some((id, value)) = patch {
        if id.is_empty() || id.len() > 512 {
            return Err(invalid());
        }
        let is_device = device_scope(&id);
        let document = if is_device { &mut device } else { &mut content };
        if let Some(value) = value {
            validate_preference(&id, &value)?;
            document.values.insert(id, value);
        } else {
            document.values.remove(&id);
        }
        document.revision = document.revision.checked_add(1).ok_or_else(invalid)?;
        save(
            if is_device { &device_path } else { &vault_path },
            document,
            is_device,
        )?;
    }
    Ok(snapshot(device, content))
}

fn context(
    app: &AppHandle,
    expected_vault_id: &str,
) -> AppResult<(std::path::PathBuf, std::path::PathBuf)> {
    let profile = app.state::<crate::paths::ActiveProfile>();
    if profile.id != expected_vault_id {
        return Err(AppError::InvalidArg(
            "settings vault does not match the running worker".into(),
        ));
    }
    Ok((crate::paths::app_data_root(app)?, profile.dir.clone()))
}

#[tauri::command]
pub async fn initialize_ui_settings(
    app: AppHandle,
    expected_vault_id: String,
    device_raw: Option<String>,
    vault_raw: Option<String>,
    preferences_raw: Option<String>,
    layout_raw: Option<String>,
    device_ui: Option<DeviceBrowserState>,
) -> CommandResult<Snapshot> {
    let (root, vault) = context(&app, &expected_vault_id)?;
    Ok(tauri::async_runtime::spawn_blocking(move || {
        if let Some(source) = app.try_state::<crate::browser_migration::Source>() {
            let owner = crate::legacy_content::is_owner(&root, &expected_vault_id, &vault)?;
            initialize_classified(
                &root,
                &vault,
                &expected_vault_id,
                BrowserState {
                    device_raw: source.raw("notes-app:settings:v1"),
                    vault_raw: source.vault_settings(&expected_vault_id),
                    preferences_raw: source.raw("notes-app:preferences:v1"),
                    layout_raw: source.layout(&expected_vault_id),
                    archive_owner: Some(owner),
                },
            )?;
            migrate_device_ui(
                &root,
                &DeviceBrowserState {
                    toolbar_raw: source
                        .raw("notes-app:file-tree-create-toolbar:v1")
                        .map(str::to_owned),
                    had_existing_data: source.had_existing_data(),
                    display_mode_raw: source
                        .raw("notes-app:mobile:displayMode")
                        .map(str::to_owned),
                },
            )?;
            return access(&root, &vault, None);
        }
        let snapshot = initialize_with_browser_state(
            &root,
            &vault,
            &expected_vault_id,
            device_raw.as_deref(),
            vault_raw.as_deref(),
            preferences_raw.as_deref(),
            layout_raw.as_deref(),
        )?;
        if let Some(input) = device_ui {
            migrate_device_ui(&root, &input)?;
            access(&root, &vault, None)
        } else {
            Ok(snapshot)
        }
    })
    .await
    .map_err(|_| invalid())??)
}

#[tauri::command]
pub async fn load_ui_settings(
    app: AppHandle,
    expected_vault_id: String,
) -> CommandResult<Snapshot> {
    let (root, vault) = context(&app, &expected_vault_id)?;
    Ok(
        tauri::async_runtime::spawn_blocking(move || access(&root, &vault, None))
            .await
            .map_err(|_| invalid())??,
    )
}

#[tauri::command]
pub async fn patch_ui_setting(
    app: AppHandle,
    expected_vault_id: String,
    id: String,
    value: Value,
    remove: bool,
) -> CommandResult<Snapshot> {
    let (root, vault) = context(&app, &expected_vault_id)?;
    let device_changed = device_scope(&id);
    let result = tauri::async_runtime::spawn_blocking(move || {
        access(&root, &vault, Some((id, (!remove).then_some(value))))
    })
    .await
    .map_err(|_| invalid())??;
    if let Err(err) = app.emit(crate::app_events::AppEvent::UiSettingsChanged.as_str(), ()) {
        log::warn!("UI settings persisted but window notification failed: {err}");
    }
    #[cfg(desktop)]
    if device_changed {
        crate::vault_supervisor::device_settings_changed(&app);
    }
    #[cfg(not(desktop))]
    let _ = device_changed;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_owner_imports_content_even_when_another_vault_opens_first() {
        let dirs = TestDirs::new();
        let raw = r#"{"leftSidebarWidth":350,"sortStrategy":"modified","leftSidebarOpen":false}"#;
        let initialize = |vault: &Path, id: &str, owner, preferences| {
            initialize_classified(
                &dirs.root,
                vault,
                id,
                BrowserState {
                    device_raw: Some(r#"{"appearance.reduceMotion":"on"}"#),
                    vault_raw: None,
                    preferences_raw: preferences,
                    layout_raw: None,
                    archive_owner: Some(owner),
                },
            )
        };
        let other = initialize(&dirs.b, "other", false, Some(raw)).unwrap();
        assert_eq!(other.values["appearance.leftSidebarWidth"], 350);
        assert!(!other.values.contains_key("ui.leftSidebarOpen"));
        assert!(!other.values.contains_key("appearance.sortStrategy"));
        assert_eq!(
            fs::read(dirs.root.join(".ui-preferences-migrated")).unwrap(),
            b"2"
        );
        assert!(!dirs.a.join(".ui-content-preferences-migrated").exists());
        access(
            &dirs.root,
            &dirs.b,
            Some(("appearance.leftSidebarWidth".into(), Some(Value::from(400)))),
        )
        .unwrap();
        let owner = initialize(&dirs.a, "default", true, Some(raw)).unwrap();
        assert_eq!(owner.values["appearance.leftSidebarWidth"], 400);
        assert_eq!(owner.values["appearance.sortStrategy"], "modified");
        assert_eq!(owner.values["ui.leftSidebarOpen"], false);
        assert_eq!(
            fs::read(dirs.a.join(".ui-content-preferences-migrated")).unwrap(),
            b"1"
        );
        access(
            &dirs.root,
            &dirs.a,
            Some(("ui.leftSidebarOpen".into(), None)),
        )
        .unwrap();
        let retry = initialize(&dirs.a, "default", true, Some("malformed stale source")).unwrap();
        assert!(!retry.values.contains_key("ui.leftSidebarOpen"));
    }

    #[test]
    fn completed_live_preferences_do_not_reseed_from_archive_and_failed_owner_import_stays_pending()
    {
        let dirs = TestDirs::new();
        initialize_with_preferences(
            &dirs.root,
            &dirs.a,
            "default",
            None,
            None,
            Some(r#"{"sortStrategy":"modified"}"#),
        )
        .unwrap();
        access(
            &dirs.root,
            &dirs.a,
            Some(("appearance.sortStrategy".into(), None)),
        )
        .unwrap();
        let result = initialize_classified(
            &dirs.root,
            &dirs.a,
            "default",
            BrowserState {
                device_raw: None,
                vault_raw: None,
                preferences_raw: Some("malformed stale source"),
                layout_raw: None,
                archive_owner: Some(true),
            },
        )
        .unwrap();
        assert!(!result.values.contains_key("appearance.sortStrategy"));

        let fresh = TestDirs::new();
        initialize_classified(
            &fresh.root,
            &fresh.b,
            "other",
            BrowserState {
                device_raw: None,
                vault_raw: None,
                preferences_raw: Some(r#"{"sortStrategy":"invalid"}"#),
                layout_raw: None,
                archive_owner: Some(false),
            },
        )
        .unwrap();
        assert!(initialize_classified(
            &fresh.root,
            &fresh.a,
            "default",
            BrowserState {
                device_raw: None,
                vault_raw: None,
                preferences_raw: Some(r#"{"sortStrategy":"invalid"}"#),
                layout_raw: None,
                archive_owner: Some(true),
            }
        )
        .is_err());
        assert!(!fresh.a.join(".ui-content-preferences-migrated").exists());
        assert!(!fresh.a.join("content-settings.json").exists());
    }
    #[test]
    fn device_ui_migration_preserves_custom_plugin_ids_and_never_reseeds() {
        let dirs = TestDirs::new();
        initialize(&dirs.root, &dirs.a, "default", None, None).unwrap();
        initialize(&dirs.root, &dirs.b, "other", None, None).unwrap();
        let input = DeviceBrowserState {
            toolbar_raw: Some(r#"{"toolbar":["plugins.test.action"],"more":["note"]}"#.into()),
            had_existing_data: true,
            display_mode_raw: Some("grid".into()),
        };
        migrate_device_ui(&dirs.root, &input).unwrap();
        let snapshot = access(&dirs.root, &dirs.b, None).unwrap();
        assert_eq!(
            snapshot.values["ui.fileTreeToolbar"]["toolbar"][0],
            "plugins.test.action"
        );
        assert_eq!(snapshot.values["ui.mobileDisplayMode"], "grid");
        assert!(!read(&dirs.a.join("content-settings.json"), false)
            .unwrap()
            .values
            .contains_key("ui.fileTreeToolbar"));
        access(
            &dirs.root,
            &dirs.a,
            Some((
                "ui.mobileDisplayMode".into(),
                Some(Value::String("list".into())),
            )),
        )
        .unwrap();
        migrate_device_ui(
            &dirs.root,
            &DeviceBrowserState {
                toolbar_raw: Some("broken stale bytes".into()),
                had_existing_data: false,
                display_mode_raw: Some("broken".into()),
            },
        )
        .unwrap();
        assert_eq!(
            access(&dirs.root, &dirs.b, None).unwrap().values["ui.mobileDisplayMode"],
            "list"
        );
    }

    #[test]
    fn device_ui_bad_input_cannot_publish_partial_candidates() {
        let dirs = TestDirs::new();
        initialize(&dirs.root, &dirs.a, "default", None, None).unwrap();
        let path = dirs.root.join("ui-settings.json");
        let bytes = fs::read(&path).unwrap();
        for (toolbar, display) in [
            (Some("broken"), None),
            (Some(r#"{"toolbar":[],"more":[2]}"#), None),
            (None, Some("bad")),
        ] {
            assert!(migrate_device_ui(
                &dirs.root,
                &DeviceBrowserState {
                    toolbar_raw: toolbar.map(str::to_owned),
                    had_existing_data: false,
                    display_mode_raw: display.map(str::to_owned)
                }
            )
            .is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert!(!dirs.root.join(".device-ui-migrated").exists());
        }
        fs::write(dirs.root.join(".device-ui-migrated"), b"bad receipt").unwrap();
        assert!(migrate_device_ui(
            &dirs.root,
            &DeviceBrowserState {
                toolbar_raw: None,
                had_existing_data: false,
                display_mode_raw: None
            }
        )
        .is_err());
    }

    #[test]
    fn device_ui_defaults_keep_the_existing_installation_toolbar() {
        for existing in [false, true] {
            let dirs = TestDirs::new();
            initialize(&dirs.root, &dirs.a, "default", None, None).unwrap();
            migrate_device_ui(
                &dirs.root,
                &DeviceBrowserState {
                    toolbar_raw: None,
                    had_existing_data: existing,
                    display_mode_raw: None,
                },
            )
            .unwrap();
            let snapshot = access(&dirs.root, &dirs.a, None).unwrap();
            assert_eq!(
                snapshot.values["ui.fileTreeToolbar"]["toolbar"]
                    .as_array()
                    .unwrap()
                    .len(),
                if existing { 6 } else { 3 }
            );
            assert_eq!(snapshot.values["ui.mobileDisplayMode"], "list");
        }
    }
    fn initialize_with_preferences(
        root: &Path,
        vault: &Path,
        id: &str,
        device: Option<&str>,
        content: Option<&str>,
        preferences: Option<&str>,
    ) -> AppResult<Snapshot> {
        initialize_with_browser_state(root, vault, id, device, content, preferences, None)
    }
    fn initialize(
        root: &Path,
        vault: &Path,
        id: &str,
        device: Option<&str>,
        content: Option<&str>,
    ) -> AppResult<Snapshot> {
        initialize_with_preferences(root, vault, id, device, content, None)
    }
    struct TestDirs {
        root: std::path::PathBuf,
        a: std::path::PathBuf,
        b: std::path::PathBuf,
    }
    impl TestDirs {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("ms-ui-settings-{}", uuid::Uuid::new_v4()));
            let a = root.join("default");
            let b = root.join("other");
            fs::create_dir_all(&a).unwrap();
            fs::create_dir_all(&b).unwrap();
            Self { root, a, b }
        }
    }
    impl Drop for TestDirs {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn migrate_scopes_and_never_seed_other_vault_from_default_account() {
        let dirs = TestDirs::new();
        let raw = r#"{"appearance.reduceMotion":"on","account.serverUrl":"https://one.example","hotkey.app.search":"Ctrl+F","plugins.unknown.folder":"f-1"}"#;
        let a = initialize(&dirs.root, &dirs.a, "default", Some(raw), None).unwrap();
        assert_eq!(a.values.len(), 4);
        let root = read(&dirs.root.join("ui-settings.json"), true).unwrap();
        assert_eq!(root.values.len(), 2);
        let b = initialize(&dirs.root, &dirs.b, "other", Some(raw), None).unwrap();
        assert_eq!(b.values, root.values);
        assert!(!b.values.contains_key("account.serverUrl"));
        assert_eq!(
            read(&dirs.a.join("content-settings.json"), false)
                .unwrap()
                .values
                .len(),
            2
        );
    }

    #[test]
    fn canonical_files_win_and_corrupt_legacy_is_retained_without_partial_publish() {
        let dirs = TestDirs::new();
        assert!(initialize(&dirs.root, &dirs.a, "default", Some("{}"), Some("[]")).is_err());
        assert!(!dirs.root.join("ui-settings.json").exists());
        initialize(&dirs.root, &dirs.a, "default", Some("{}"), None).unwrap();
        access(
            &dirs.root,
            &dirs.a,
            Some(("account.serverType".into(), Some(Value::from("managed")))),
        )
        .unwrap();
        let result = initialize(
            &dirs.root,
            &dirs.a,
            "default",
            Some("broken"),
            Some("broken"),
        )
        .unwrap();
        assert_eq!(result.values["account.serverType"], "managed");
    }

    #[test]
    fn concurrent_workers_patch_fields_without_lost_updates_and_isolate_accounts() {
        let dirs = TestDirs::new();
        initialize(&dirs.root, &dirs.a, "default", None, None).unwrap();
        initialize(&dirs.root, &dirs.b, "other", None, None).unwrap();
        std::thread::scope(|scope| {
            for (vault, id, value) in [
                (&dirs.a, "appearance.reduceMotion", Value::from("on")),
                (&dirs.b, "hotkey.app.search", Value::from("Ctrl+F")),
                (
                    &dirs.a,
                    "account.serverUrl",
                    Value::from("https://a.example"),
                ),
                (
                    &dirs.b,
                    "account.serverUrl",
                    Value::from("https://b.example"),
                ),
            ] {
                let root = &dirs.root;
                scope.spawn(move || access(root, vault, Some((id.into(), Some(value)))).unwrap());
            }
        });
        for (vault, url) in [
            (&dirs.a, "https://a.example"),
            (&dirs.b, "https://b.example"),
        ] {
            let result = access(&dirs.root, vault, None).unwrap();
            assert_eq!(result.device_revision, 2);
            assert_eq!(result.values["appearance.reduceMotion"], "on");
            assert_eq!(result.values["hotkey.app.search"], "Ctrl+F");
            assert_eq!(result.values["account.serverUrl"], url);
        }
        let reset = access(
            &dirs.root,
            &dirs.a,
            Some(("appearance.reduceMotion".into(), None)),
        )
        .unwrap();
        assert!(!reset.values.contains_key("appearance.reduceMotion"));
        assert_eq!(reset.device_revision, 3);
    }

    #[test]
    fn recover_previous_before_refresh_and_never_reseed_missing_migrated_document() {
        let dirs = TestDirs::new();
        initialize(&dirs.root, &dirs.a, "default", None, None).unwrap();
        access(
            &dirs.root,
            &dirs.a,
            Some(("appearance.reduceMotion".into(), Some(Value::from("on")))),
        )
        .unwrap();
        let path = dirs.root.join("ui-settings.json");
        fs::write(&path, b"corrupt").unwrap();
        let recovered = access(&dirs.root, &dirs.a, None).unwrap();
        assert_eq!(recovered.device_revision, 0);
        assert!(fs::read_dir(&dirs.root).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".corrupt-")));
        fs::remove_file(path).unwrap();
        fs::remove_file(dirs.root.join("ui-settings.json.previous")).unwrap();
        assert!(initialize(
            &dirs.root,
            &dirs.a,
            "default",
            Some(r#"{"appearance.reduceMotion":"on"}"#),
            None
        )
        .is_err());
        assert!(!dirs.root.join("ui-settings.json").exists());
    }

    #[test]
    fn unscoped_preferences_seed_only_selected_legacy_vault_and_widths_are_shared() {
        let dirs = TestDirs::new();
        let raw = r#"{"leftSidebarWidth":320,"rightSidebarWidth":280,"leftSidebarOpen":false,"rightSidebarOpen":true,"sortStrategy":"modified","sortDirection":"desc","unknown":"retained in browser"}"#;
        let a = initialize_with_preferences(&dirs.root, &dirs.a, "default", None, None, Some(raw))
            .unwrap();
        assert_eq!(a.values["appearance.leftSidebarWidth"], 320);
        assert_eq!(a.values["appearance.sortStrategy"], "modified");
        assert_eq!(a.values["ui.leftSidebarOpen"], false);
        let b = initialize_with_preferences(
            &dirs.root,
            &dirs.b,
            "other",
            None,
            None,
            Some("corrupt ignored source"),
        )
        .unwrap();
        assert_eq!(b.values["appearance.leftSidebarWidth"], 320);
        assert!(!b.values.contains_key("appearance.sortStrategy"));
        assert!(!b.values.contains_key("ui.leftSidebarOpen"));
        access(
            &dirs.root,
            &dirs.b,
            Some((
                "appearance.rightSidebarWidth".into(),
                Some(Value::from(300)),
            )),
        )
        .unwrap();
        access(
            &dirs.root,
            &dirs.b,
            Some((
                "appearance.sortStrategy".into(),
                Some(Value::from("created")),
            )),
        )
        .unwrap();
        let a = access(&dirs.root, &dirs.a, None).unwrap();
        assert_eq!(a.values["appearance.rightSidebarWidth"], 300);
        assert_eq!(a.values["appearance.sortStrategy"], "modified");
        assert_eq!(a.values["ui.sortDirection"], "desc");
    }

    #[test]
    fn malformed_preferences_and_marker_refuse_publication_and_invalid_patches_preserve_values() {
        let dirs = TestDirs::new();
        for raw in [
            "broken",
            "[]",
            r#"{"leftSidebarOpen":"false"}"#,
            r#"{"sortStrategy":"invalid"}"#,
        ] {
            assert!(initialize_with_preferences(
                &dirs.root,
                &dirs.a,
                "default",
                None,
                None,
                Some(raw)
            )
            .is_err());
            assert!(!dirs.root.join("ui-settings.json").exists());
            assert!(!dirs.a.join("content-settings.json").exists());
            assert!(!dirs.root.join(".ui-preferences-migrated").exists());
        }
        initialize(&dirs.root, &dirs.a, "default", None, None).unwrap();
        let previous = fs::read(dirs.a.join("content-settings.json")).unwrap();
        assert!(access(
            &dirs.root,
            &dirs.a,
            Some((
                "appearance.sortStrategy".into(),
                Some(Value::from("invalid"))
            ))
        )
        .is_err());
        assert_eq!(
            fs::read(dirs.a.join("content-settings.json")).unwrap(),
            previous
        );
        fs::write(dirs.root.join(".ui-preferences-migrated"), b"broken marker").unwrap();
        assert!(initialize(&dirs.root, &dirs.a, "default", None, None).is_err());
        assert_eq!(
            fs::read(dirs.root.join(".ui-preferences-migrated")).unwrap(),
            b"broken marker"
        );
    }

    #[test]
    fn existing_documents_win_and_previous_root_sort_scope_is_corrected_without_leaking() {
        let dirs = TestDirs::new();
        let device_path = dirs.root.join("ui-settings.json");
        let mut values = Values::new();
        values.insert("appearance.sortStrategy".into(), Value::from("created"));
        values.insert("appearance.leftSidebarWidth".into(), Value::from(290));
        save(
            &device_path,
            &Document {
                version: 1,
                revision: 4,
                values,
            },
            true,
        )
        .unwrap();
        let raw = r#"{"leftSidebarWidth":350,"sortStrategy":"modified"}"#;
        let a = initialize_with_preferences(&dirs.root, &dirs.a, "default", None, None, Some(raw))
            .unwrap();
        assert_eq!(a.values["appearance.sortStrategy"], "created");
        assert_eq!(a.values["appearance.leftSidebarWidth"], 290);
        assert_eq!(a.device_revision, 5);
        assert!(!read(&device_path, true)
            .unwrap()
            .values
            .contains_key("appearance.sortStrategy"));
        let b = initialize(&dirs.root, &dirs.b, "other", None, None).unwrap();
        assert!(!b.values.contains_key("appearance.sortStrategy"));
        // Recovery of the old root copy must pass through scope correction.
        fs::write(&device_path, b"corrupt").unwrap();
        let recovered = access(&dirs.root, &dirs.b, None).unwrap();
        assert!(!recovered.values.contains_key("appearance.sortStrategy"));
        assert_eq!(
            access(&dirs.root, &dirs.a, None).unwrap().values["appearance.sortStrategy"],
            "created"
        );
        assert!(!read(&device_path, true)
            .unwrap()
            .values
            .contains_key("appearance.sortStrategy"));
    }

    #[test]
    fn migrate_layout_into_one_vault_and_preserve_clear_tombstone_on_restart() {
        let dirs = TestDirs::new();
        let raw = r#"{"version":1,"dock":{"panels":{"a":{"title":"A"}}},"activeNoteId":"a","savedAt":"2026-10-10T00:00:00.000Z"}"#;
        let a = initialize_with_browser_state(
            &dirs.root,
            &dirs.a,
            "default",
            None,
            None,
            None,
            Some(raw),
        )
        .unwrap();
        assert_eq!(a.values["ui.dockLayout"]["activeNoteId"], "a");
        let b = initialize(&dirs.root, &dirs.b, "other", None, None).unwrap();
        assert!(!b.values.contains_key("ui.dockLayout"));
        access(
            &dirs.root,
            &dirs.a,
            Some(("ui.dockLayout".into(), Some(Value::Null))),
        )
        .unwrap();
        let a = initialize_with_browser_state(
            &dirs.root,
            &dirs.a,
            "default",
            None,
            None,
            None,
            Some("malformed stale source"),
        )
        .unwrap();
        assert!(a.values["ui.dockLayout"].is_null());
    }

    #[test]
    fn malformed_layout_refuses_initialization_before_other_candidates_are_published() {
        let dirs = TestDirs::new();
        for raw in [
            "broken",
            "null",
            "[]",
            r#"{"version":1,"dock":{},"activeNoteId":"a","savedAt":"2026-10-10T00:00:00Z"}"#,
        ] {
            assert!(initialize_with_browser_state(
                &dirs.root,
                &dirs.a,
                "default",
                None,
                None,
                None,
                Some(raw)
            )
            .is_err());
            assert!(!dirs.root.join("ui-settings.json").exists());
            assert!(!dirs.a.join("content-settings.json").exists());
            assert!(!dirs.a.join(".dock-layout-migrated").exists());
        }
    }

    #[test]
    fn invalid_layout_updates_and_migration_record_cannot_replace_canonical_state() {
        let dirs = TestDirs::new();
        initialize(&dirs.root, &dirs.a, "default", None, None).unwrap();
        let path = dirs.a.join("content-settings.json");
        let previous = fs::read(&path).unwrap();
        assert!(access(
            &dirs.root,
            &dirs.a,
            Some((
                "ui.dockLayout".into(),
                Some(serde_json::json!({"version": 1, "dock": null}))
            ))
        )
        .is_err());
        assert_eq!(fs::read(&path).unwrap(), previous);
        fs::write(dirs.a.join(".dock-layout-migrated"), b"broken").unwrap();
        assert!(initialize(&dirs.root, &dirs.a, "default", None, None).is_err());
        assert_eq!(
            fs::read(dirs.a.join(".dock-layout-migrated")).unwrap(),
            b"broken"
        );
    }
}
