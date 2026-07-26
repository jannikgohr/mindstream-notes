//! Per-profile plugin registry — durable install/enable state + integrity.
//!
//! Plugins are discovered from disk by [`discovery`]: bundled core plugins from
//! the app resource dir (`builtin`) and third-party plugins from the profile's
//! app-data dir (`installed`). This module reconciles what was discovered with
//! the durable DB record of *which* plugins exist for the active profile,
//! whether they're enabled, and the hash the user/app accepted — so the
//! security-relevant state lives in the DB rather than in web storage that a
//! cache clear can wipe. The frontend receives the reconciled records + parsed
//! manifests and registers the contributions of the enabled ones.
//!
//! Integrity gate: an **installed** (third-party) plugin whose manifest
//! checksum no longer matches its `accepted_hash` is auto-disabled with a load
//! error until the user re-approves it. **Builtin** plugins ship inside the
//! signed app bundle and are trusted, so a checksum change (a shipped update)
//! is accepted automatically.

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::db::Db;
use crate::error::{AppError, AppResult, CommandResult};

pub mod discovery;
pub mod luau;
pub mod signing;

/// Where a plugin came from. Governs the integrity gate: builtins are trusted,
/// installed plugins must keep a matching accepted hash.
pub const SOURCE_BUILTIN: &str = "builtin";
/// Third-party plugins loaded from the user-writable app-data dir.
pub const SOURCE_INSTALLED: &str = "installed";

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
    /// SHA-256 fingerprint of the accepted signer's public key (pinned on
    /// approval), or `None` for unsigned plugins.
    pub signer: Option<String>,
    /// Last observed signature verification: `"unsigned"` | `"valid"` | `"invalid"`.
    pub signature_status: String,
    pub installed_at: String,
    pub updated_at: String,
}

/// Internal reconcile payload, built from a {@link discovery::DiscoveredPlugin}.
/// NOTE: not a command input — `source` is set by the Rust discovery layer from
/// the load location, never supplied by the frontend, so a plugin can't claim a
/// trust level it wasn't loaded with.
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
    /// Signer fingerprint from signature verification (`None` if unsigned/invalid).
    pub signer: Option<String>,
    /// Signature verification result: `"unsigned"` | `"valid"` | `"invalid"`.
    pub signature_status: String,
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
        signer: row.get("signer")?,
        signature_status: row.get("signature_status")?,
        installed_at: row.get("installed_at")?,
        updated_at: row.get("updated_at")?,
    })
}

const SELECT_COLUMNS: &str = "id, version, enabled, source, source_path, accepted_hash, \
     granted_permissions, last_load_error, signer, signature_status, installed_at, updated_at";

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
/// - New id → inserted enabled, accepting the current checksum + signer.
/// - Builtin (trusted by location) → always accept; enabled state + install
///   timestamp preserved.
/// - Installed, unchanged hash → refresh.
/// - Installed, **changed** hash but validly signed by the SAME pinned signer →
///   auto-approved (the update is provably from the same author).
/// - Installed, changed hash otherwise (unsigned edit / invalid signature /
///   different signer) → disabled with a load error, the old accepted hash +
///   pinned signer retained, pending re-approval via [`approve`].
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
                    granted_permissions, last_load_error, signer, signature_status,
                    installed_at, updated_at
                 ) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9, ?9)",
                params![
                    input.id,
                    input.version,
                    input.source,
                    input.source_path,
                    input.checksum,
                    permissions_json,
                    input.signer,
                    input.signature_status,
                    now,
                ],
            )?;
        }
        Some(existing) => {
            let trusted = input.source == SOURCE_BUILTIN;
            let hash_matches = existing.accepted_hash == input.checksum;
            let signed_valid = input.signature_status == "valid";
            // Same author only when both are present and the fingerprints match.
            let same_signer =
                input.signer.is_some() && input.signer.as_deref() == existing.signer.as_deref();
            let accept = trusted || hash_matches || (signed_valid && same_signer);

            if accept {
                // Trusted, unchanged, or a valid same-signer update: accept the
                // current manifest + signer, clear any error, keep enabled state.
                conn.execute(
                    "UPDATE plugins SET
                        version = ?2, source = ?3, source_path = ?4,
                        accepted_hash = ?5, granted_permissions = ?6,
                        signer = ?7, signature_status = ?8,
                        last_load_error = NULL, updated_at = ?9
                     WHERE id = ?1",
                    params![
                        input.id,
                        input.version,
                        input.source,
                        input.source_path,
                        input.checksum,
                        permissions_json,
                        input.signer,
                        input.signature_status,
                        now,
                    ],
                )?;
            } else {
                // Changed since approval and not provably the same author: gate
                // it off. Keep the old accepted hash + pinned signer so a later
                // legitimate re-sign by the original author auto-recovers. Update
                // signature_status so the UI can explain why.
                let reason = if input.signature_status == "invalid" {
                    "plugin signature is invalid; re-approval required"
                } else if signed_valid {
                    "plugin is signed by a different key than approved; re-approval required"
                } else {
                    "manifest hash changed since it was approved; re-approval required"
                };
                conn.execute(
                    "UPDATE plugins SET
                        version = ?2, source = ?3, source_path = ?4,
                        enabled = 0, signature_status = ?5,
                        last_load_error = ?6, updated_at = ?7
                     WHERE id = ?1",
                    params![
                        input.id,
                        input.version,
                        input.source,
                        input.source_path,
                        input.signature_status,
                        reason,
                        now,
                    ],
                )?;
            }
        }
    }
    require(conn, &input.id)
}

/// A discovered plugin's reconciled record plus its manifest, returned to the
/// frontend so it can register the contributions of enabled plugins.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredPluginView {
    pub record: PluginRecord,
    pub manifest: serde_json::Value,
}

/// Reconcile every discovered plugin with its DB record (applying the trust
/// gate via {@link upsert}) and return the records + manifests. The `source`
/// on each input comes from discovery (the load location), so trust is never
/// frontend-controlled.
pub fn reconcile(
    conn: &Connection,
    discovered: Vec<discovery::DiscoveredPlugin>,
) -> AppResult<Vec<DiscoveredPluginView>> {
    let mut views = Vec::with_capacity(discovered.len());
    for plugin in discovered {
        let record = upsert(
            conn,
            UpsertPlugin {
                id: plugin.id,
                version: plugin.version,
                checksum: plugin.checksum,
                source: plugin.source,
                source_path: None,
                permissions: plugin.permissions,
                signer: plugin.signer,
                signature_status: plugin.signature_status,
            },
        )?;
        views.push(DiscoveredPluginView {
            record,
            manifest: plugin.manifest,
        });
    }
    Ok(views)
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

/// Accept the current on-disk manifest for a plugin (re-approval after a change
/// or a new/rotated signer): pin its checksum + signer, enable it, clear the
/// load error. Pinning the signer means the author's *next* update auto-approves.
pub fn approve(
    conn: &Connection,
    id: &str,
    checksum: &str,
    signer: Option<&str>,
    signature_status: &str,
) -> AppResult<PluginRecord> {
    let now = Utc::now().to_rfc3339();
    let changed = conn.execute(
        "UPDATE plugins SET accepted_hash = ?2, signer = ?3, signature_status = ?4,
            enabled = 1, last_load_error = NULL, updated_at = ?5 WHERE id = ?1",
        params![id, checksum, signer, signature_status, now],
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

/// Discover plugins from disk (core = bundled resource dir, third-party =
/// app-data dir), reconcile them with the DB, and return records + manifests.
/// This is the *only* path that assigns trust, and it does so from the load
/// location — there is deliberately no command that lets the frontend declare a
/// plugin's `source`.
#[tauri::command]
pub fn plugins_discover(
    app: AppHandle,
    db: State<'_, Db>,
) -> CommandResult<Vec<DiscoveredPluginView>> {
    let core_dir = discovery::core_plugins_dir(&app)?;
    let third_party_dir = discovery::third_party_plugins_dir(&app)?;
    discovery::ensure_third_party_dir(&third_party_dir);
    let discovered = discovery::discover(&core_dir, &third_party_dir);
    db.with_conn(|c| reconcile(c, discovered))
        .map_err(Into::into)
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

/// Re-approve a gated plugin by accepting whatever is currently on disk. Trust
/// is still location-derived (discovery re-reads the dirs); the frontend can't
/// smuggle in a checksum or signer — they come from the on-disk manifest.
#[tauri::command]
pub fn plugins_approve(
    app: AppHandle,
    db: State<'_, Db>,
    id: String,
) -> CommandResult<PluginRecord> {
    let core_dir = discovery::core_plugins_dir(&app)?;
    let third_party_dir = discovery::third_party_plugins_dir(&app)?;
    let plugin = discovery::discover(&core_dir, &third_party_dir)
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| AppError::NotFound(format!("plugin {id} not found on disk")))?;
    db.with_conn(|c| {
        approve(
            c,
            &plugin.id,
            &plugin.checksum,
            plugin.signer.as_deref(),
            &plugin.signature_status,
        )
    })
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
