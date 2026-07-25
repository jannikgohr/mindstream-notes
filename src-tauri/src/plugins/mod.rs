//! Per-profile plugin registry — durable install/enable state + integrity.
//!
//! The frontend owns each plugin's manifest and contributions (bundled
//! first-party plugins ship their manifest in the JS bundle; a future
//! third-party flow will read it from an installed package). This module is the
//! Rust-side record of *which* plugins exist for the active profile, whether
//! they're enabled, and the hash the user/app accepted — so the security-
//! relevant state lives in the DB rather than in web storage that a cache clear
//! can wipe.
//!
//! Integrity gate: an **installed** (third-party) plugin whose manifest
//! checksum no longer matches its `accepted_hash` is auto-disabled with a load
//! error until the user re-approves it. **Builtin** plugins ship inside the
//! signed app bundle and are trusted, so a checksum change (a shipped update)
//! is accepted automatically.

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::error::{AppError, AppResult, CommandResult};

/// Where a plugin came from. Governs the integrity gate: builtins are trusted,
/// installed plugins must keep a matching accepted hash.
pub const SOURCE_BUILTIN: &str = "builtin";

/// Durable record for one plugin in the active profile.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginRecord {
    pub id: String,
    pub version: String,
    pub enabled: bool,
    /// `"builtin"` or `"installed"`.
    pub source: String,
    pub source_path: Option<String>,
    /// Canonical manifest checksum accepted for this plugin.
    pub accepted_hash: String,
    pub granted_permissions: Vec<String>,
    pub last_load_error: Option<String>,
    pub installed_at: String,
    pub updated_at: String,
}

/// Frontend payload to register/refresh a plugin from its loaded manifest.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertPlugin {
    pub id: String,
    pub version: String,
    /// Current canonical checksum of the manifest being loaded.
    pub checksum: String,
    pub source: String,
    pub source_path: Option<String>,
    pub permissions: Vec<String>,
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<PluginRecord> {
    let permissions_json: String = row.get("granted_permissions")?;
    let granted_permissions =
        serde_json::from_str::<Vec<String>>(&permissions_json).unwrap_or_default();
    Ok(PluginRecord {
        id: row.get("id")?,
        version: row.get("version")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        source: row.get("source")?,
        source_path: row.get("source_path")?,
        accepted_hash: row.get("accepted_hash")?,
        granted_permissions,
        last_load_error: row.get("last_load_error")?,
        installed_at: row.get("installed_at")?,
        updated_at: row.get("updated_at")?,
    })
}

const SELECT_COLUMNS: &str = "id, version, enabled, source, source_path, accepted_hash, \
     granted_permissions, last_load_error, installed_at, updated_at";

pub fn list(conn: &Connection) -> AppResult<Vec<PluginRecord>> {
    let sql = format!("SELECT {SELECT_COLUMNS} FROM plugins ORDER BY installed_at, id");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_record)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Option<PluginRecord>> {
    let sql = format!("SELECT {SELECT_COLUMNS} FROM plugins WHERE id = ?1");
    Ok(conn
        .query_row(&sql, params![id], row_to_record)
        .optional()?)
}

fn require(conn: &Connection, id: &str) -> AppResult<PluginRecord> {
    get(conn, id)?.ok_or_else(|| AppError::NotFound(format!("plugin {id}")))
}

/// Register a freshly-loaded plugin, or reconcile an existing record with the
/// manifest currently being loaded.
///
/// - New id → inserted enabled, accepting the current checksum + permissions.
/// - Builtin (trusted) → always accept the current checksum; enabled state and
///   install timestamp are preserved.
/// - Installed with a matching accepted hash → refresh version/permissions.
/// - Installed with a **changed** checksum → disabled with a load error, the
///   old accepted hash retained, pending re-approval via [`approve`].
pub fn upsert(conn: &Connection, input: UpsertPlugin) -> AppResult<PluginRecord> {
    let now = Utc::now().to_rfc3339();
    let permissions_json =
        serde_json::to_string(&input.permissions).unwrap_or_else(|_| "[]".into());

    let existing = get(conn, &input.id)?;
    match existing {
        None => {
            conn.execute(
                "INSERT INTO plugins(
                    id, version, enabled, source, source_path, accepted_hash,
                    granted_permissions, last_load_error, installed_at, updated_at
                 ) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, NULL, ?7, ?7)",
                params![
                    input.id,
                    input.version,
                    input.source,
                    input.source_path,
                    input.checksum,
                    permissions_json,
                    now,
                ],
            )?;
        }
        Some(existing) => {
            let trusted = input.source == SOURCE_BUILTIN;
            let hash_matches = existing.accepted_hash == input.checksum;
            if trusted || hash_matches {
                // Trusted update, or an unchanged installed plugin: accept the
                // current manifest, clear any prior error, keep enabled state.
                conn.execute(
                    "UPDATE plugins SET
                        version = ?2, source = ?3, source_path = ?4,
                        accepted_hash = ?5, granted_permissions = ?6,
                        last_load_error = NULL, updated_at = ?7
                     WHERE id = ?1",
                    params![
                        input.id,
                        input.version,
                        input.source,
                        input.source_path,
                        input.checksum,
                        permissions_json,
                        now,
                    ],
                )?;
            } else {
                // Installed plugin whose manifest changed since approval: gate
                // it off, keep the old accepted hash so re-approval can compare.
                conn.execute(
                    "UPDATE plugins SET
                        version = ?2, source = ?3, source_path = ?4,
                        enabled = 0,
                        last_load_error = ?5, updated_at = ?6
                     WHERE id = ?1",
                    params![
                        input.id,
                        input.version,
                        input.source,
                        input.source_path,
                        "manifest hash changed since it was approved; re-approval required",
                        now,
                    ],
                )?;
            }
        }
    }
    require(conn, &input.id)
}

fn set_enabled(conn: &Connection, id: &str, enabled: bool) -> AppResult<PluginRecord> {
    let now = Utc::now().to_rfc3339();
    let changed = conn.execute(
        "UPDATE plugins SET enabled = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, enabled as i64, now],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(format!("plugin {id}")));
    }
    require(conn, id)
}

/// Accept the given checksum for a plugin (re-approval after a manifest change),
/// enable it, and clear any load error.
pub fn approve(conn: &Connection, id: &str, checksum: &str) -> AppResult<PluginRecord> {
    let now = Utc::now().to_rfc3339();
    let changed = conn.execute(
        "UPDATE plugins SET accepted_hash = ?2, enabled = 1,
            last_load_error = NULL, updated_at = ?3 WHERE id = ?1",
        params![id, checksum, now],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(format!("plugin {id}")));
    }
    require(conn, id)
}

pub fn set_load_error(conn: &Connection, id: &str, error: Option<&str>) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE plugins SET last_load_error = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, error, now],
    )?;
    Ok(())
}

pub fn remove(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM plugins WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------- Tauri commands ----------

#[tauri::command]
pub fn plugins_list(db: tauri::State<'_, Db>) -> CommandResult<Vec<PluginRecord>> {
    db.with_conn(list).map_err(Into::into)
}

#[tauri::command]
pub fn plugins_get(db: tauri::State<'_, Db>, id: String) -> CommandResult<Option<PluginRecord>> {
    db.with_conn(|c| get(c, &id)).map_err(Into::into)
}

#[tauri::command]
pub fn plugins_upsert(
    db: tauri::State<'_, Db>,
    input: UpsertPlugin,
) -> CommandResult<PluginRecord> {
    db.with_conn(|c| upsert(c, input)).map_err(Into::into)
}

#[tauri::command]
pub fn plugins_enable(db: tauri::State<'_, Db>, id: String) -> CommandResult<PluginRecord> {
    db.with_conn(|c| set_enabled(c, &id, true))
        .map_err(Into::into)
}

#[tauri::command]
pub fn plugins_disable(db: tauri::State<'_, Db>, id: String) -> CommandResult<PluginRecord> {
    db.with_conn(|c| set_enabled(c, &id, false))
        .map_err(Into::into)
}

#[tauri::command]
pub fn plugins_approve(
    db: tauri::State<'_, Db>,
    id: String,
    checksum: String,
) -> CommandResult<PluginRecord> {
    db.with_conn(|c| approve(c, &id, &checksum))
        .map_err(Into::into)
}

#[tauri::command]
pub fn plugins_set_load_error(
    db: tauri::State<'_, Db>,
    id: String,
    error: Option<String>,
) -> CommandResult<()> {
    db.with_conn(|c| set_load_error(c, &id, error.as_deref()))
        .map_err(Into::into)
}

#[tauri::command]
pub fn plugins_remove(db: tauri::State<'_, Db>, id: String) -> CommandResult<()> {
    db.with_conn(|c| remove(c, &id)).map_err(Into::into)
}

#[cfg(test)]
mod tests;
