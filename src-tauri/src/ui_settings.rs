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
        "appearance.leftSidebarWidth" | "appearance.rightSidebarWidth"
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
    let need_preferences = match fs::read(&preferences_marker) {
        Ok(raw) if raw == b"1" => false,
        Ok(_) => {
            return Err(AppError::InvalidArg(
                "invalid UI preferences migration record".into(),
            ))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => true,
        Err(err) => return Err(err.into()),
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
        if need_preferences && !vault_doc.values.contains_key("appearance.sortStrategy") {
            vault_doc
                .values
                .insert("appearance.sortStrategy".into(), sort);
            vault_changed = true;
        }
    }
    if need_preferences {
        let preferences = legacy(preferences_raw)?;
        for (key, id, is_device) in [
            ("leftSidebarWidth", "appearance.leftSidebarWidth", true),
            ("rightSidebarWidth", "appearance.rightSidebarWidth", true),
            ("leftSidebarOpen", "ui.leftSidebarOpen", false),
            ("rightSidebarOpen", "ui.rightSidebarOpen", false),
            ("sortStrategy", "appearance.sortStrategy", false),
            ("sortDirection", "ui.sortDirection", false),
        ] {
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
        crate::atomic_file::write(&preferences_marker, b"1")?;
    }
    if need_layout {
        crate::atomic_file::write(&layout_marker, b"1")?;
    }
    Ok(snapshot(device, vault_doc))
}

fn validate_preference(id: &str, value: &Value) -> AppResult<()> {
    let valid = match id {
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
) -> CommandResult<Snapshot> {
    let (root, vault) = context(&app, &expected_vault_id)?;
    Ok(tauri::async_runtime::spawn_blocking(move || {
        initialize_with_browser_state(
            &root,
            &vault,
            &expected_vault_id,
            device_raw.as_deref(),
            vault_raw.as_deref(),
            preferences_raw.as_deref(),
            layout_raw.as_deref(),
        )
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
    let result = tauri::async_runtime::spawn_blocking(move || {
        access(&root, &vault, Some((id, (!remove).then_some(value))))
    })
    .await
    .map_err(|_| invalid())??;
    if let Err(err) = app.emit(crate::app_events::AppEvent::UiSettingsChanged.as_str(), ()) {
        log::warn!("UI settings persisted but window notification failed: {err}");
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
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
