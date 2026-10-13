//! Backend plugin settings. D values belong to the root document; V values
//! remain in the vault database. Legacy rows are retained as migration evidence.
//! Runtime consumers receive the effective values plus manifest defaults.

use std::collections::BTreeMap;

use chrono::Utc;
use rusqlite::{params, Connection};

use crate::error::AppResult;

#[derive(Default, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DeviceSettings {
    owner: String,
    values: BTreeMap<String, PluginSettings>,
    migrated: std::collections::BTreeSet<String>,
}

fn parse_device(raw: &[u8]) -> AppResult<DeviceSettings> {
    serde_json::from_slice(raw)
        .map_err(|e| crate::error::AppError::InvalidArg(format!("device plugin settings: {e}")))
}

fn read_device(root: &std::path::Path) -> AppResult<DeviceSettings> {
    let path = root.join("plugin-settings.json");
    crate::root_documents::recover(
        &path,
        |raw| parse_device(raw).map(|_| ()),
        |raw| parse_device(raw).map(|_| ()),
    )?;
    match std::fs::read(path) {
        Ok(raw) => parse_device(&raw),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(DeviceSettings::default()),
        Err(e) => Err(e.into()),
    }
}

fn save_device(root: &std::path::Path, document: &DeviceSettings) -> AppResult<()> {
    let bytes = serde_json::to_vec_pretty(document)
        .map_err(|e| crate::error::AppError::InvalidArg(e.to_string()))?;
    crate::root_documents::write(&root.join("plugin-settings.json"), &bytes, |raw| {
        parse_device(raw).map(|_| ())
    })
}

/// Backup callers hold RootLock. Physical migration owners stay on this device.
pub(crate) fn backup_values(root: &std::path::Path) -> AppResult<BTreeMap<String, PluginSettings>> {
    Ok(read_device(root)?.values)
}

pub(crate) fn restore_backup_values(
    root: &std::path::Path,
    values: &BTreeMap<String, PluginSettings>,
) -> AppResult<()> {
    let mut document = read_device(root)?;
    for (id, settings) in values {
        for (key, value) in settings {
            if document.migrated.contains(&format!("{id}:{key}"))
                && !document
                    .values
                    .get(id)
                    .is_some_and(|settings| settings.contains_key(key))
            {
                continue;
            }
            document.migrated.insert(format!("{id}:{key}"));
            document
                .values
                .entry(id.clone())
                .or_default()
                .entry(key.clone())
                .or_insert_with(|| value.clone());
        }
    }
    save_device(root, &document)
}

pub(crate) fn scoped_device_keys(
    plugin: &super::discovery::DiscoveredPlugin,
) -> std::collections::BTreeSet<String> {
    device_keys(plugin)
}

/// Imported database rows are vault configuration, never legacy D migration
/// input. Even an unavailable plugin must not seed shared values when installed
/// later. Existing root values and reset receipts remain authoritative.
pub(crate) fn seal_restored_rows(
    root: &std::path::Path,
    rows: &[(String, String)],
) -> AppResult<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let _lock = crate::storage_locks::RootLock::acquire(root)?;
    let mut document = read_device(root)?;
    for (id, key) in rows {
        document.migrated.insert(format!("{id}:{key}"));
    }
    save_device(root, &document)
}

/// Pin the selected migration source before workers can race to seed D values.
pub fn prepare(root: &std::path::Path, selected: &std::path::Path) -> AppResult<()> {
    let _lock = crate::storage_locks::RootLock::acquire(root)?;
    let mut document = read_device(root)?;
    if document.owner.is_empty() {
        document.owner = selected
            .canonicalize()
            .unwrap_or_else(|_| selected.to_path_buf())
            .to_string_lossy()
            .into_owned();
        save_device(root, &document)?;
    }
    Ok(())
}

fn device_keys(plugin: &super::discovery::DiscoveredPlugin) -> std::collections::BTreeSet<String> {
    plugin.manifest_json["contributes"]["settings"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|section| section["settings"].as_array().into_iter().flatten())
        .filter(|setting| setting["scope"] == "D")
        .filter_map(|setting| setting["id"].as_str().map(str::to_owned))
        .collect()
}

/// Runtime consumers receive defaults as well as stored values. The UI cache
/// receives stored values only, so its reset/default indicators remain exact.
pub fn with_defaults(
    plugin: &super::discovery::DiscoveredPlugin,
    mut values: PluginSettings,
) -> PluginSettings {
    for section in plugin.manifest_json["contributes"]["settings"]
        .as_array()
        .into_iter()
        .flatten()
    {
        for setting in section["settings"].as_array().into_iter().flatten() {
            if let (Some(id), Some(value)) = (setting["id"].as_str(), setting.get("default")) {
                values.entry(id.into()).or_insert_with(|| value.clone());
            }
        }
    }
    values
}

pub fn effective(
    root: &std::path::Path,
    vault: &std::path::Path,
    conn: &Connection,
    plugin: &super::discovery::DiscoveredPlugin,
) -> AppResult<PluginSettings> {
    let mut values = all(conn, &plugin.id)?;
    let _lock = crate::storage_locks::RootLock::acquire(root)?;
    let mut document = read_device(root)?;
    let owner = vault.canonicalize()?.to_string_lossy() == document.owner;
    let mut changed = false;
    for key in device_keys(plugin) {
        let legacy = values.remove(&key);
        let receipt = format!("{}:{key}", plugin.id);
        if owner && document.migrated.insert(receipt) {
            if let Some(value) = legacy {
                document
                    .values
                    .entry(plugin.id.clone())
                    .or_default()
                    .entry(key.clone())
                    .or_insert(value);
            }
            changed = true;
        }
        if let Some(value) = document
            .values
            .get(&plugin.id)
            .and_then(|settings| settings.get(&key))
        {
            values.insert(key, value.clone());
        }
    }
    if changed {
        save_device(root, &document)?;
    }
    Ok(values)
}

pub fn set_scoped(
    root: &std::path::Path,
    conn: &Connection,
    plugin: &super::discovery::DiscoveredPlugin,
    key: &str,
    value: Option<&serde_json::Value>,
) -> AppResult<()> {
    if !device_keys(plugin).contains(key) {
        return match value {
            Some(value) => set(conn, &plugin.id, key, value),
            None => remove(conn, &plugin.id, key),
        };
    }
    let _lock = crate::storage_locks::RootLock::acquire(root)?;
    let mut document = read_device(root)?;
    document.migrated.insert(format!("{}:{key}", plugin.id));
    let values = document.values.entry(plugin.id.clone()).or_default();
    match value {
        Some(value) => {
            values.insert(key.into(), value.clone());
        }
        None => {
            values.remove(key);
        }
    }
    save_device(root, &document)
}

pub fn notify(app: &tauri::AppHandle) {
    use tauri::Emitter;
    let _ = app.emit(crate::app_events::AppEvent::PluginsChanged.as_str(), ());
    #[cfg(desktop)]
    crate::vault_supervisor::device_settings_changed(app);
}

/// Every setting stored for one plugin, keyed by its plugin-local id.
///
/// A `BTreeMap` so the order is stable: this ends up in `ctx.settings`, and a
/// script that serializes it should not see the key order shuffle between runs.
pub type PluginSettings = BTreeMap<String, serde_json::Value>;

/// Read a plugin's stored settings. A value that no longer parses as JSON is
/// skipped rather than failing the read — one corrupt row should not stop a
/// plugin from loading with the rest of its configuration.
pub fn all(conn: &Connection, plugin_id: &str) -> AppResult<PluginSettings> {
    let mut stmt =
        conn.prepare("SELECT key, value FROM plugin_settings WHERE plugin_id = ?1 ORDER BY key")?;
    let rows = stmt.query_map(params![plugin_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut out = PluginSettings::new();
    for row in rows {
        let (key, raw) = row?;
        match serde_json::from_str(&raw) {
            Ok(value) => {
                out.insert(key, value);
            }
            Err(e) => log::warn!("[plugins] {plugin_id}: unreadable setting '{key}': {e}"),
        }
    }
    Ok(out)
}

/// Write one setting.
pub fn set(
    conn: &Connection,
    plugin_id: &str,
    key: &str,
    value: &serde_json::Value,
) -> AppResult<()> {
    let encoded = serde_json::to_string(value)
        .map_err(|e| crate::error::AppError::InvalidArg(format!("plugin setting value: {e}")))?;
    conn.execute(
        "INSERT INTO plugin_settings(plugin_id, key, value, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(plugin_id, key) DO UPDATE SET value = ?3, updated_at = ?4",
        params![plugin_id, key, encoded, Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

/// Remove one setting, so the next read falls back to the manifest's default.
pub fn remove(conn: &Connection, plugin_id: &str, key: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM plugin_settings WHERE plugin_id = ?1 AND key = ?2",
        params![plugin_id, key],
    )?;
    Ok(())
}

/// Drop vault settings for an explicit reset. Package removal preserves them.
pub fn clear(conn: &Connection, plugin_id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM plugin_settings WHERE plugin_id = ?1",
        params![plugin_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory_for_tests;

    #[test]
    fn round_trips_values_with_their_types() {
        // JSON text rather than a string column, so a toggle comes back a
        // boolean and a slider a number instead of everything arriving as text.
        let db = open_memory_for_tests();
        db.with_conn(|c| {
            set(c, "com.a.p", "enabled", &serde_json::json!(true))?;
            set(c, "com.a.p", "count", &serde_json::json!(7))?;
            set(c, "com.a.p", "folder", &serde_json::json!("abc"))?;
            set(c, "com.a.p", "absent", &serde_json::json!(null))?;

            let stored = all(c, "com.a.p")?;
            assert_eq!(stored["enabled"], serde_json::json!(true));
            assert_eq!(stored["count"], serde_json::json!(7));
            assert_eq!(stored["folder"], serde_json::json!("abc"));
            assert!(stored["absent"].is_null());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn settings_are_scoped_to_one_plugin() {
        let db = open_memory_for_tests();
        db.with_conn(|c| {
            set(c, "com.a.p", "shared-key", &serde_json::json!("a"))?;
            set(c, "com.b.p", "shared-key", &serde_json::json!("b"))?;
            assert_eq!(all(c, "com.a.p")?["shared-key"], serde_json::json!("a"));
            assert_eq!(all(c, "com.b.p")?["shared-key"], serde_json::json!("b"));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn writing_the_same_key_updates_rather_than_duplicates() {
        let db = open_memory_for_tests();
        db.with_conn(|c| {
            set(c, "com.a.p", "k", &serde_json::json!(1))?;
            set(c, "com.a.p", "k", &serde_json::json!(2))?;
            let stored = all(c, "com.a.p")?;
            assert_eq!(stored.len(), 1);
            assert_eq!(stored["k"], serde_json::json!(2));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn remove_falls_back_to_absent_and_clear_drops_everything() {
        let db = open_memory_for_tests();
        db.with_conn(|c| {
            set(c, "com.a.p", "k", &serde_json::json!(1))?;
            set(c, "com.a.p", "j", &serde_json::json!(2))?;
            remove(c, "com.a.p", "k")?;
            assert!(!all(c, "com.a.p")?.contains_key("k"));
            assert!(all(c, "com.a.p")?.contains_key("j"));

            clear(c, "com.a.p")?;
            assert!(all(c, "com.a.p")?.is_empty());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn an_unreadable_row_is_skipped_not_fatal() {
        // One corrupt value should not stop a plugin loading with the rest of
        // its configuration.
        let db = open_memory_for_tests();
        db.with_conn(|c| {
            set(c, "com.a.p", "good", &serde_json::json!("v"))?;
            c.execute(
                "INSERT INTO plugin_settings(plugin_id, key, value, updated_at)
                 VALUES ('com.a.p', 'bad', 'not json', '2026-01-01T00:00:00Z')",
                [],
            )?;
            let stored = all(c, "com.a.p")?;
            assert_eq!(stored.len(), 1);
            assert_eq!(stored["good"], serde_json::json!("v"));
            Ok(())
        })
        .unwrap();
    }
}
