//! Plugin settings, stored in the vault database.
//!
//! # Why these are not in the settings store
//!
//! App settings live in the WebView's `localStorage`. That is fine for
//! settings the WebView is the only consumer of, but plugin settings are not
//! one of those: a scripted plugin receives them as `ctx.settings`, and every
//! decision about *what* a plugin sees is the backend's to make. While they sat
//! in `localStorage`, the backend could not read them — so the frontend had to
//! assemble the script context and hand it over, which meant the backend could
//! never invoke a plugin on its own. No events, no watchers, no scheduled work:
//! not because the effect model forbids it, but because nothing except a UI
//! action could build the argument.
//!
//! Keeping them here also fixes the thing `{setting:<id>}` had to work around
//! in `preview_service`, where a settings snapshot was passed down from the
//! frontend at launch precisely because the backend had no way to read one.
//!
//! Values are stored as JSON text so a setting keeps its type — a toggle comes
//! back as a boolean, a slider as a number — rather than everything becoming a
//! string on the way through.

use std::collections::BTreeMap;

use chrono::Utc;
use rusqlite::{params, Connection};

use crate::error::AppResult;

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

/// Drop every setting for a plugin. Called when it is uninstalled: leaving its
/// configuration behind would silently reapply to a later reinstall the user
/// may have meant as a fresh start.
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
