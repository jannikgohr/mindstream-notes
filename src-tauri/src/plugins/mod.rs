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
//! Integrity gate: a **newly-discovered installed** (third-party) plugin is
//! never trusted on sight — it is registered *disabled and unapproved* and
//! contributes nothing until the user explicitly approves it. Likewise, an
//! already-approved installed plugin whose manifest checksum no longer matches
//! its `accepted_hash` is auto-disabled with a load error until re-approved.
//! **Builtin** plugins ship inside the signed app bundle and are trusted, so
//! they are enabled on discovery unless their manifest opts out, and a checksum
//! change (a shipped update) is accepted automatically.

use std::path::Path;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::db::Db;
use crate::error::{AppError, AppResult, CommandResult};

pub mod discovery;
pub mod luau;
pub mod signing;
pub mod wasm;

/// Where a plugin came from. Governs the integrity gate: builtins are trusted,
/// installed plugins must keep a matching accepted hash.
pub const SOURCE_BUILTIN: &str = "builtin";
/// Third-party plugins loaded from the user-writable app-data dir.
pub const SOURCE_INSTALLED: &str = "installed";

/// Load error recorded for a newly-discovered third-party plugin that the user
/// has not yet approved. Surfaces the "needs approval" state in the UI and keeps
/// the plugin disabled until [`approve`] pins its hash + signer and enables it.
const NEW_INSTALL_GATE_REASON: &str = "new third-party plugin; approve it to enable";

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
    /// Builtin plugins are enabled on first discovery unless this is false.
    /// Installed plugins ignore it and always start gated/disabled.
    #[serde(default = "default_enabled_by_default")]
    pub enabled_by_default: bool,
    /// Signer fingerprint from signature verification (`None` if unsigned/invalid).
    pub signer: Option<String>,
    /// Signature verification result: `"unsigned"` | `"valid"` | `"invalid"`.
    pub signature_status: String,
}

fn default_enabled_by_default() -> bool {
    true
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
/// - New **builtin** id → inserted enabled unless its manifest opts out,
///   accepting the current checksum + signer (trusted by its bundled location).
/// - New **installed** id → inserted DISABLED and unapproved (empty accepted
///   hash, no pinned signer, gate load error). A third-party plugin never runs
///   or contributes on mere discovery; the user must explicitly [`approve`] it,
///   which is what pins its hash + signer and enables it.
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
        None if input.source == SOURCE_BUILTIN => {
            // Trusted by location: current checksum + signer accepted. Most
            // builtins start enabled; experimental builtins may opt out.
            let enabled = input.enabled_by_default;
            conn.execute(
                "INSERT INTO plugins(
                    id, version, enabled, source, source_path, accepted_hash,
                    granted_permissions, last_load_error, signer, signature_status,
                    installed_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9, ?10, ?10)",
                params![
                    input.id,
                    input.version,
                    enabled as i64,
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
        None => {
            // A brand-new third-party plugin is never trusted on discovery.
            // Install it DISABLED and UNAPPROVED: no accepted hash and no pinned
            // signer (both are set only by `approve`), plus a gate load error so
            // the UI prompts for approval. This is the fix for auto-enabling a
            // plugin merely dropped into the plugins folder — it contributes
            // nothing and no script runs until the user approves it.
            conn.execute(
                "INSERT INTO plugins(
                    id, version, enabled, source, source_path, accepted_hash,
                    granted_permissions, last_load_error, signer, signature_status,
                    installed_at, updated_at
                 ) VALUES (?1, ?2, 0, ?3, ?4, '', ?5, ?6, NULL, ?7, ?8, ?8)",
                params![
                    input.id,
                    input.version,
                    input.source,
                    input.source_path,
                    permissions_json,
                    NEW_INSTALL_GATE_REASON,
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
                enabled_by_default: plugin.enabled_by_default,
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

/// Delete a third-party plugin's directory, refusing anything that isn't
/// physically inside `third_party_dir`. Both paths are canonicalized first so a
/// `..` segment or symlink can't escape the plugins folder — defense in depth so
/// this can never remove a builtin or unrelated directory even if handed a bad
/// path.
fn remove_plugin_dir(third_party_dir: &Path, dir: &Path) -> AppResult<()> {
    let base = third_party_dir
        .canonicalize()
        .unwrap_or_else(|_| third_party_dir.to_path_buf());
    let target = dir
        .canonicalize()
        .map_err(|e| AppError::InvalidArg(format!("plugin dir {}: {e}", dir.display())))?;
    if target == base || !target.starts_with(&base) {
        return Err(AppError::InvalidArg(format!(
            "refusing to delete '{}' outside the plugins folder",
            target.display()
        )));
    }
    std::fs::remove_dir_all(&target)?;
    Ok(())
}

/// Read a bundled text file `<dir>/<file>` where `file` is a safe relative path
/// (a doc `.md`, an icon `.svg`, …). Rejects any path that escapes the plugin
/// dir (traversal / symlink), returning `None` when the file simply doesn't
/// exist — an absent locale variant (`guide.de.md`) is expected, so the caller
/// falls back to another candidate rather than erroring.
/// Read one of a plugin's bundled text files from a filesystem dir, delegating
/// to the traversal-guarded [`discovery::PluginFiles`] read. The command path
/// reads through the discovered plugin's `files` directly (so builtins resolve
/// from the embedded tree); this thin wrapper keeps the filesystem read
/// unit-testable in isolation.
#[cfg(test)]
fn read_plugin_file(dir: &Path, file: &str) -> AppResult<Option<String>> {
    discovery::PluginFiles::Fs(dir.to_path_buf()).read_text(file)
}

// ---------- Scripted execution ----------

fn manifest_id(manifest: &serde_json::Value) -> &str {
    manifest
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("plugin")
}

fn manifest_entry<'a>(
    manifest: &'a serde_json::Value,
    runtime: &str,
    extension: &str,
) -> AppResult<&'a str> {
    let entry = manifest
        .get("entry")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::InvalidArg(format!("{runtime} plugin has no entry")))?;
    if entry.contains('/') || entry.contains('\\') || entry.contains("..") {
        return Err(AppError::InvalidArg(format!("unsafe entry '{entry}'")));
    }
    if !entry.ends_with(extension) {
        return Err(AppError::InvalidArg(format!(
            "{runtime} plugin entry must end in {extension}"
        )));
    }
    Ok(entry)
}

fn limit_usize(
    manifest: &serde_json::Value,
    field: &str,
    default: usize,
    min: usize,
    max: usize,
) -> usize {
    manifest
        .get("limits")
        .and_then(|v| v.get(field))
        .and_then(|v| v.as_u64())
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or(default)
        .clamp(min, max)
}

fn limit_u64(manifest: &serde_json::Value, field: &str, default: u64, min: u64, max: u64) -> u64 {
    manifest
        .get("limits")
        .and_then(|v| v.get(field))
        .and_then(|v| v.as_u64())
        .unwrap_or(default)
        .clamp(min, max)
}

fn limit_duration(
    manifest: &serde_json::Value,
    default: std::time::Duration,
    min: std::time::Duration,
    max: std::time::Duration,
) -> std::time::Duration {
    let millis = manifest
        .get("limits")
        .and_then(|v| v.get("timeoutMs"))
        .and_then(|v| v.as_u64())
        .map(std::time::Duration::from_millis)
        .unwrap_or(default);
    millis.clamp(min, max)
}

fn luau_limits(manifest: &serde_json::Value) -> luau::Limits {
    let defaults = luau::Limits::default();
    luau::Limits {
        memory_bytes: limit_usize(
            manifest,
            "memoryBytes",
            defaults.memory_bytes,
            1024 * 1024,
            64 * 1024 * 1024,
        ),
        timeout: limit_duration(
            manifest,
            defaults.timeout,
            std::time::Duration::from_millis(50),
            std::time::Duration::from_secs(5),
        ),
    }
}

fn wasm_limits(manifest: &serde_json::Value) -> wasm::Limits {
    let defaults = wasm::Limits::default();
    wasm::Limits {
        memory_bytes: limit_usize(
            manifest,
            "memoryBytes",
            defaults.memory_bytes,
            16 * 1024 * 1024,
            512 * 1024 * 1024,
        ),
        timeout: limit_duration(
            manifest,
            defaults.timeout,
            std::time::Duration::from_millis(100),
            std::time::Duration::from_secs(30),
        ),
        fuel: limit_u64(manifest, "fuel", defaults.fuel, 10_000, 10_000_000_000),
    }
}

/// Load a scripted plugin's entry and run its `export` function with `input`,
/// under the selected runtime's sandbox + resource limits. `manifest` is the
/// plugin's parsed manifest (for `runtime`/`entry`/`id`); `granted` is the
/// permission set that decides the host API surface.
///
/// Factored out of the command so it is unit-testable without a Tauri handle.
pub fn run_plugin_script(
    files: &discovery::PluginFiles,
    manifest: &serde_json::Value,
    checksum: &str,
    granted: Vec<String>,
    export: &str,
    input: serde_json::Value,
    notes: Vec<luau::NoteMeta>,
) -> AppResult<serde_json::Value> {
    match manifest.get("runtime").and_then(|v| v.as_str()) {
        Some("luau") => {
            let entry = manifest_entry(manifest, "luau", ".luau")?;
            let source = files
                .read_text(entry)?
                .ok_or_else(|| AppError::InvalidArg(format!("entry '{entry}' not found")))?;
            // The plugin's other `.luau` files, resolvable via a plugin-scoped `require`.
            let modules = files.luau_modules()?;
            let id = manifest_id(manifest);
            luau::run(luau::ScriptRequest {
                source,
                chunk_name: format!("{id}/{entry}"),
                export: export.to_string(),
                input,
                permissions: granted,
                notes,
                modules,
                limits: luau_limits(manifest),
            })
        }
        Some("wasm") => {
            run_wasm_plugin_script(files, manifest, checksum, granted, export, input, notes)
        }
        Some(other) => Err(AppError::InvalidArg(format!(
            "plugin runtime '{other}' is not executable"
        ))),
        None => Err(AppError::InvalidArg("plugin has no runtime".into())),
    }
}

fn run_wasm_plugin_script(
    files: &discovery::PluginFiles,
    manifest: &serde_json::Value,
    checksum: &str,
    granted: Vec<String>,
    export: &str,
    input: serde_json::Value,
    notes: Vec<luau::NoteMeta>,
) -> AppResult<serde_json::Value> {
    let entry = manifest_entry(manifest, "wasm", ".wasm")?;
    let wasm = files
        .read_bytes(entry)?
        .ok_or_else(|| AppError::InvalidArg(format!("entry '{entry}' not found")))?;
    wasm::run(wasm::ScriptRequest {
        wasm,
        module_name: format!("{}/{}", manifest_id(manifest), entry),
        checksum: checksum.to_string(),
        export: export.to_string(),
        input,
        permissions: granted,
        notes,
        limits: wasm_limits(manifest),
    })
}

/// Build the read-only note snapshot exposed via `ms.notes`. One `notes::list`
/// plus a folder-path index over `collections::list`; excludes trashed notes.
fn note_snapshot(conn: &Connection) -> AppResult<Vec<luau::NoteMeta>> {
    let folders = crate::collections::list(conn)?;
    let by_id: std::collections::HashMap<String, (String, Option<String>)> = folders
        .into_iter()
        .map(|c| (c.id, (c.name, c.parent_collection_id)))
        .collect();
    let folder_path = |mut id: Option<String>| -> String {
        let mut parts = Vec::new();
        let mut seen = std::collections::HashSet::new();
        while let Some(cur) = id {
            if !seen.insert(cur.clone()) {
                break;
            }
            match by_id.get(&cur) {
                Some((name, parent)) => {
                    parts.push(name.clone());
                    id = parent.clone();
                }
                None => break,
            }
        }
        parts.reverse();
        parts.join(" / ")
    };
    Ok(crate::notes::list(conn, false)?
        .into_iter()
        .map(|s| luau::NoteMeta {
            id: s.id,
            title: s.title,
            tags: s.tags,
            kind: s.note_kind.as_str().to_string(),
            folder_path: folder_path(s.parent_collection_id.clone()),
            folder_id: s.parent_collection_id,
            created: s.created,
            modified: s.modified,
        })
        .collect())
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

/// Discover plugins (builtin = embedded in the binary, third-party = app-data
/// dir), reconcile them with the DB, and return records + manifests.
/// This is the *only* path that assigns trust, and it does so from the load
/// location — there is deliberately no command that lets the frontend declare a
/// plugin's `source`.
#[tauri::command]
pub fn plugins_discover(
    app: AppHandle,
    db: State<'_, Db>,
) -> CommandResult<Vec<DiscoveredPluginView>> {
    let third_party_dir = discovery::third_party_plugins_dir(&app)?;
    discovery::ensure_third_party_dir(&third_party_dir);
    let discovered = discovery::discover(&third_party_dir);
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
    let third_party_dir = discovery::third_party_plugins_dir(&app)?;
    let plugin = discovery::find(&third_party_dir, &id)
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

/// Uninstall a plugin: delete its files from the third-party plugins dir — so it
/// does not reappear on the next discovery — and drop its DB record. A built-in
/// plugin can't be removed: it ships inside the signed app bundle and discovery
/// would re-add it, so removing only its record would be a lie. The frontend
/// hides the trash affordance for builtins; this is the backend enforcement.
#[tauri::command]
pub fn plugins_remove(app: AppHandle, db: State<'_, Db>, id: String) -> CommandResult<()> {
    if let Some(record) = db.with_conn(|c| get(c, &id))? {
        if record.source == SOURCE_BUILTIN {
            return Err(
                AppError::InvalidArg(format!("cannot remove built-in plugin '{id}'")).into(),
            );
        }
    }

    // Re-locate the plugin on disk (trust stays location-derived) and delete its
    // directory when it's a third-party install. Already gone from disk is fine —
    // we still clear the DB record below so a stale row can't linger.
    let third_party_dir = discovery::third_party_plugins_dir(&app)?;
    if let Some(plugin) = discovery::find(&third_party_dir, &id) {
        if let Some(dir) = plugin.files.fs_path() {
            remove_plugin_dir(&third_party_dir, dir)?;
        }
    }

    db.with_conn(|c| remove(c, &id)).map_err(Into::into)
}

/// Read one of a plugin's bundled text files (docs `.md`, icon `.svg`, …).
/// Trust stays location-derived (the plugin is re-located on disk); the path is
/// guarded against traversal. Available for builtin + installed plugins
/// regardless of enabled state — these are read-only assets with no code
/// execution, legitimately read before a plugin is approved (e.g. to show its
/// docs). `None` means the file isn't present, letting the caller fall back
/// from a missing locale variant.
#[tauri::command]
pub fn plugins_read_file(
    app: AppHandle,
    id: String,
    file: String,
) -> CommandResult<Option<String>> {
    let third_party_dir = discovery::third_party_plugins_dir(&app)?;
    let plugin = discovery::find(&third_party_dir, &id)
        .ok_or_else(|| AppError::NotFound(format!("plugin {id} not found on disk")))?;
    plugin.files.read_text(&file).map_err(Into::into)
}

/// Run a scripted plugin's entry function. The plugin is re-located on disk
/// (trust stays location-derived) and must be **enabled** in the DB — a gated or
/// disabled plugin never executes. The script runs on a blocking worker so a
/// long or runaway script can't stall the async runtime; its resource limits
/// still bound it. Permissions come from the DB record, not the
/// caller, so a script only gets the host API its manifest was granted.
#[tauri::command]
pub async fn plugins_run_script(
    app: AppHandle,
    db: State<'_, Db>,
    id: String,
    export: String,
    input: serde_json::Value,
) -> CommandResult<serde_json::Value> {
    let third_party_dir = discovery::third_party_plugins_dir(&app)?;

    let record = db
        .with_conn(|c| get(c, &id))?
        .ok_or_else(|| AppError::NotFound(format!("plugin {id}")))?;
    if !record.enabled {
        return Err(AppError::InvalidArg(format!("plugin {id} is not enabled")).into());
    }

    let plugin = discovery::find(&third_party_dir, &id)
        .ok_or_else(|| AppError::NotFound(format!("plugin {id} not found on disk")))?;

    let files = plugin.files;
    let manifest = plugin.manifest;
    let checksum = plugin.checksum;
    let granted = record.granted_permissions;
    // Capture the note snapshot up front (while we hold the DB) so the blocking
    // worker needs no DB access; empty unless the plugin holds notes.read.
    let notes = if granted.iter().any(|p| p == "notes.read") {
        db.with_conn(note_snapshot)?
    } else {
        Vec::new()
    };
    tauri::async_runtime::spawn_blocking(move || {
        run_plugin_script(&files, &manifest, &checksum, granted, &export, input, notes)
    })
    .await
    .map_err(|e| AppError::InvalidArg(format!("script task failed: {e}")))?
    .map_err(Into::into)
}

#[cfg(test)]
mod tests;
