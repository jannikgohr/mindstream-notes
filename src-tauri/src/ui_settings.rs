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
    if document.version != 1 || document.values.keys().any(|id| device_scope(id) != device) {
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

fn initialize(
    root: &Path,
    vault: &Path,
    vault_id: &str,
    device_raw: Option<&str>,
    vault_raw: Option<&str>,
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
    let device = if need_device {
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
    let vault_doc = if need_vault {
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
    if need_device {
        save(&device_path, &device, true)?;
    }
    if need_vault {
        save(&vault_path, &vault_doc, false)?;
    }
    for path in [&device_path, &vault_path] {
        if !marker(path).try_exists()? {
            crate::atomic_file::write(&marker(path), b"1")?;
        }
    }
    Ok(snapshot(device, vault_doc))
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
    if let Some((id, value)) = patch {
        if id.is_empty() || id.len() > 512 {
            return Err(invalid());
        }
        let is_device = device_scope(&id);
        let document = if is_device { &mut device } else { &mut content };
        if let Some(value) = value {
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
) -> CommandResult<Snapshot> {
    let (root, vault) = context(&app, &expected_vault_id)?;
    Ok(tauri::async_runtime::spawn_blocking(move || {
        initialize(
            &root,
            &vault,
            &expected_vault_id,
            device_raw.as_deref(),
            vault_raw.as_deref(),
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
}
