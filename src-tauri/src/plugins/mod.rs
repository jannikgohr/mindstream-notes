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

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};

use crate::db::Db;
use crate::error::{AppError, AppResult, CommandResult};

pub mod discovery;
pub mod luau;
pub mod preview_service;
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginArtifactManifest {
    id: String,
    kind: String,
    version: String,
    url: String,
    sha256: String,
    file_name: String,
    size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginNativeToolManifest {
    id: String,
    binary_name: String,
    description_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginArtifactStatus {
    pub plugin_id: String,
    pub artifact_id: String,
    pub kind: String,
    pub version: String,
    pub file_name: String,
    pub installed: bool,
    pub bytes: Option<u64>,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginNativeToolStatus {
    pub plugin_id: String,
    pub tool_id: String,
    pub binary_name: String,
    pub available: bool,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginNativeToolOutput {
    pub status_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStorageEntry {
    pub path: String,
    pub is_dir: bool,
    pub bytes: Option<u64>,
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

/// Disable a plugin that hard-crashed (its host runtime panicked, not a mere
/// script error) and record why. A crashing plugin must not be able to take the
/// app down *or* keep re-triggering the fault, so it stays disabled until the
/// user re-enables it — surfaced in the plugins UI via `last_load_error`.
pub fn disable_crashed(conn: &Connection, id: &str, reason: &str) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE plugins SET enabled = 0, last_load_error = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, reason, now],
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

// ---------- Host-managed artifacts + plugin data -------------------------

const PERM_PLUGIN_ARTIFACTS_DOWNLOAD: &str = "pluginArtifacts.download";
const PERM_PLUGIN_STORAGE_READ: &str = "pluginStorage.read";
const PERM_PLUGIN_STORAGE_WRITE: &str = "pluginStorage.write";
const PERM_NATIVE_TOOLS_RUN_DECLARED: &str = "nativeTools.runDeclared";
const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_NATIVE_TOOL_ARGS: usize = 64;
const MAX_NATIVE_TOOL_ARG_BYTES: usize = 4096;
const MAX_NATIVE_TOOL_STDIN_BYTES: usize = 8 * 1024 * 1024;

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn require_enabled_permission(
    conn: &Connection,
    id: &str,
    permission: &str,
) -> AppResult<PluginRecord> {
    let record = require(conn, id)?;
    if !record.enabled {
        return Err(AppError::InvalidArg(format!("plugin {id} is not enabled")));
    }
    if !record
        .granted_permissions
        .iter()
        .any(|granted| granted == permission)
    {
        return Err(AppError::InvalidArg(format!(
            "plugin {id} lacks permission {permission}"
        )));
    }
    Ok(record)
}

fn safe_segment(value: &str, label: &str) -> AppResult<()> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err(AppError::InvalidArg(format!("unsafe {label} '{value}'")));
    }
    Ok(())
}

fn parse_artifacts(manifest: &serde_json::Value) -> AppResult<Vec<PluginArtifactManifest>> {
    let Some(value) = manifest.get("contributes").and_then(|c| c.get("artifacts")) else {
        return Ok(Vec::new());
    };
    serde_json::from_value(value.clone())
        .map_err(|e| AppError::InvalidArg(format!("manifest.contributes.artifacts: {e}")))
}

fn parse_native_tools(manifest: &serde_json::Value) -> AppResult<Vec<PluginNativeToolManifest>> {
    let Some(value) = manifest
        .get("contributes")
        .and_then(|c| c.get("nativeTools"))
    else {
        return Ok(Vec::new());
    };
    serde_json::from_value(value.clone())
        .map_err(|e| AppError::InvalidArg(format!("manifest.contributes.nativeTools: {e}")))
}

fn find_native_tool(
    manifest: &serde_json::Value,
    tool_id: &str,
) -> AppResult<PluginNativeToolManifest> {
    parse_native_tools(manifest)?
        .into_iter()
        .find(|tool| tool.id == tool_id)
        .ok_or_else(|| AppError::NotFound(format!("plugin native tool {tool_id}")))
}

fn validate_binary_name(binary_name: &str) -> AppResult<()> {
    if binary_name.is_empty()
        || binary_name.contains('/')
        || binary_name.contains('\\')
        || binary_name.contains("..")
        || Path::new(binary_name)
            .extension()
            .is_some_and(|ext| !ext.to_string_lossy().eq_ignore_ascii_case("exe"))
        || !binary_name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-'))
    {
        return Err(AppError::InvalidArg(format!(
            "unsafe native tool binary name '{binary_name}'"
        )));
    }
    Ok(())
}

fn ensure_write_target_safe(root: &Path, target: &Path) -> AppResult<()> {
    match fs::symlink_metadata(target) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(AppError::InvalidArg(
                    "plugin storage path targets a symlink".into(),
                ));
            }
            ensure_inside_data_root(root, target)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let parent = target
                .parent()
                .ok_or_else(|| AppError::InvalidArg("plugin storage path has no parent".into()))?;
            ensure_inside_data_root(root, parent)
        }
        Err(err) => Err(err.into()),
    }
}

fn path_extensions(binary_name: &str) -> Vec<OsString> {
    #[cfg(windows)]
    {
        if Path::new(binary_name).extension().is_some() {
            return vec![OsString::new()];
        }
        let pathext = std::env::var_os("PATHEXT").unwrap_or_else(|| ".EXE".into());
        let mut out = std::env::split_paths(&pathext)
            .flat_map(|p| p.into_os_string().into_string().ok())
            .flat_map(|s| s.split(';').map(str::to_string).collect::<Vec<_>>())
            .filter(|s| s.eq_ignore_ascii_case(".exe"))
            .map(OsString::from)
            .collect::<Vec<_>>();
        if out.is_empty() {
            out.push(".exe".into());
        }
        out
    }
    #[cfg(not(windows))]
    {
        let _ = binary_name;
        vec![OsString::new()]
    }
}

fn resolve_path_binary(binary_name: &str) -> AppResult<Option<PathBuf>> {
    validate_binary_name(binary_name)?;
    let Some(path_var) = std::env::var_os("PATH") else {
        return Ok(None);
    };
    for dir in std::env::split_paths(&path_var) {
        for ext in path_extensions(binary_name) {
            let mut candidate = dir.join(binary_name);
            if !ext.is_empty() {
                candidate.set_extension(
                    ext.to_string_lossy()
                        .trim_start_matches('.')
                        .to_ascii_lowercase(),
                );
            }
            if candidate.is_file() {
                return Ok(Some(candidate));
            }
        }
    }
    Ok(None)
}

fn native_tool_status(
    plugin_id: &str,
    tool: &PluginNativeToolManifest,
) -> AppResult<PluginNativeToolStatus> {
    let _ = &tool.description_key;
    let path = resolve_path_binary(&tool.binary_name)?;
    Ok(PluginNativeToolStatus {
        plugin_id: plugin_id.to_string(),
        tool_id: tool.id.clone(),
        binary_name: tool.binary_name.clone(),
        available: path.is_some(),
        path: path.map(|p| p.to_string_lossy().into_owned()),
    })
}

/// Resolve every native tool a manifest declares to its PATH binary (`None` when
/// not found), for exposure via the Luau `ms.nativeTools` host API. On mobile
/// native tools are unavailable, so every declared tool maps to `None` — the
/// script sees the tool but `available` is always false, matching the
/// desktop-only guard on the direct `plugins_run_native_tool` command.
fn resolve_native_tools(manifest: &serde_json::Value) -> HashMap<String, Option<PathBuf>> {
    let tools = parse_native_tools(manifest).unwrap_or_default();
    tools
        .into_iter()
        .map(|tool| {
            let resolved = if cfg!(mobile) {
                None
            } else {
                resolve_path_binary(&tool.binary_name).ok().flatten()
            };
            (tool.id, resolved)
        })
        .collect()
}

fn validate_native_tool_args(args: &[String], stdin: &Option<String>) -> AppResult<()> {
    if args.len() > MAX_NATIVE_TOOL_ARGS {
        return Err(AppError::InvalidArg(format!(
            "native tool received too many arguments ({})",
            args.len()
        )));
    }
    for arg in args {
        if arg.len() > MAX_NATIVE_TOOL_ARG_BYTES || arg.contains('\0') {
            return Err(AppError::InvalidArg(
                "native tool argument is too large or contains NUL".into(),
            ));
        }
    }
    if let Some(stdin) = stdin {
        if stdin.len() > MAX_NATIVE_TOOL_STDIN_BYTES || stdin.contains('\0') {
            return Err(AppError::InvalidArg(
                "native tool stdin is too large or contains NUL".into(),
            ));
        }
    }
    Ok(())
}

/// Raw process result with **unlossy** stdout/stderr bytes. Kept binary so a
/// tool that emits a PDF/PNG (not UTF-8 text) survives; text callers convert
/// via `String::from_utf8_lossy`, the Luau binary path base64-encodes.
pub(super) struct RawToolOutput {
    pub status_code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub timed_out: bool,
}

fn run_native_tool_process(
    binary: PathBuf,
    cwd: PathBuf,
    args: Vec<String>,
    stdin: Option<String>,
    timeout_ms: Option<u64>,
) -> AppResult<RawToolOutput> {
    validate_native_tool_args(&args, &stdin)?;
    fs::create_dir_all(&cwd)?;
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(10_000).clamp(100, 30_000));
    let mut child = Command::new(binary)
        .args(args)
        .current_dir(cwd)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(input) = stdin {
        if let Some(mut pipe) = child.stdin.take() {
            pipe.write_all(input.as_bytes())?;
        }
    }
    let start = std::time::Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            let output = child.wait_with_output()?;
            return Ok(RawToolOutput {
                status_code: output.status.code(),
                stdout: output.stdout,
                stderr: output.stderr,
                timed_out: false,
            });
        }
        if start.elapsed() >= timeout {
            child.kill()?;
            let output = child.wait_with_output()?;
            return Ok(RawToolOutput {
                status_code: output.status.code(),
                stdout: output.stdout,
                stderr: output.stderr,
                timed_out: true,
            });
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

fn find_artifact(
    manifest: &serde_json::Value,
    artifact_id: &str,
) -> AppResult<PluginArtifactManifest> {
    parse_artifacts(manifest)?
        .into_iter()
        .find(|artifact| artifact.id == artifact_id)
        .ok_or_else(|| AppError::NotFound(format!("plugin artifact {artifact_id}")))
}

fn plugin_artifact_root(app: &AppHandle, plugin_id: &str) -> AppResult<PathBuf> {
    safe_segment(plugin_id, "plugin id")?;
    Ok(crate::paths::app_data_dir(app)?
        .join("plugin-artifacts")
        .join(plugin_id))
}

fn artifact_file_path(
    app: &AppHandle,
    plugin_id: &str,
    artifact: &PluginArtifactManifest,
) -> AppResult<PathBuf> {
    safe_segment(&artifact.id, "artifact id")?;
    safe_segment(&artifact.version, "artifact version")?;
    safe_segment(&artifact.file_name, "artifact file name")?;
    Ok(plugin_artifact_root(app, plugin_id)?
        .join(&artifact.id)
        .join(&artifact.version)
        .join(&artifact.file_name))
}

fn artifact_status(
    app: &AppHandle,
    plugin_id: &str,
    artifact: &PluginArtifactManifest,
) -> AppResult<PluginArtifactStatus> {
    let path = artifact_file_path(app, plugin_id, artifact)?;
    let bytes = fs::metadata(&path).ok().map(|m| m.len());
    let sha256 = fs::read(&path).ok().map(|bytes| sha256_hex(&bytes));
    let installed = sha256.as_deref() == Some(artifact.sha256.as_str());
    Ok(PluginArtifactStatus {
        plugin_id: plugin_id.to_string(),
        artifact_id: artifact.id.clone(),
        kind: artifact.kind.clone(),
        version: artifact.version.clone(),
        file_name: artifact.file_name.clone(),
        installed,
        bytes,
        sha256,
    })
}

async fn download_artifact(
    app: AppHandle,
    plugin_id: String,
    artifact: PluginArtifactManifest,
) -> AppResult<PluginArtifactStatus> {
    let url = reqwest::Url::parse(&artifact.url)
        .map_err(|e| AppError::InvalidArg(format!("artifact URL: {e}")))?;
    if url.scheme() != "https" {
        return Err(AppError::InvalidArg("artifact URL must use HTTPS".into()));
    }
    let bytes = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| AppError::InvalidArg(format!("artifact HTTP client: {e}")))?
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::InvalidArg(format!("artifact download failed: {e}")))?
        .error_for_status()
        .map_err(|e| AppError::InvalidArg(format!("artifact download failed: {e}")))?
        .bytes()
        .await
        .map_err(|e| AppError::InvalidArg(format!("artifact download body: {e}")))?;

    let len = u64::try_from(bytes.len())
        .map_err(|_| AppError::InvalidArg("artifact is too large".into()))?;
    if len > MAX_ARTIFACT_BYTES {
        return Err(AppError::InvalidArg(format!(
            "artifact is too large ({len} bytes)"
        )));
    }
    if let Some(expected) = artifact.size_bytes {
        if len != expected {
            return Err(AppError::InvalidArg(format!(
                "artifact size mismatch: expected {expected}, got {len}"
            )));
        }
    }
    let actual_hash = sha256_hex(&bytes);
    if actual_hash != artifact.sha256 {
        return Err(AppError::InvalidArg(format!(
            "artifact digest mismatch: expected {}, got {actual_hash}",
            artifact.sha256
        )));
    }

    let final_path = artifact_file_path(&app, &plugin_id, &artifact)?;
    let version_dir = final_path
        .parent()
        .ok_or_else(|| AppError::InvalidArg("artifact path has no parent".into()))?;
    let staging_dir = plugin_artifact_root(&app, &plugin_id)?.join(".staging");
    fs::create_dir_all(&staging_dir)?;
    fs::create_dir_all(version_dir)?;
    let staging_path = staging_dir.join(format!(
        "{}-{}-{}",
        artifact.id,
        artifact.version,
        uuid::Uuid::new_v4()
    ));
    fs::write(&staging_path, &bytes)?;
    if final_path.exists() {
        fs::remove_file(&final_path)?;
    }
    fs::rename(&staging_path, &final_path)?;
    artifact_status(&app, &plugin_id, &artifact)
}

fn plugin_data_root(app: &AppHandle, plugin_id: &str) -> AppResult<PathBuf> {
    safe_segment(plugin_id, "plugin id")?;
    Ok(crate::paths::app_data_dir(app)?
        .join("plugin-data")
        .join(plugin_id))
}

fn split_plugin_rel_path(path: &str, allow_empty: bool) -> AppResult<Vec<String>> {
    if path.starts_with('/') || path.starts_with('\\') || path.contains('\\') {
        return Err(AppError::InvalidArg(format!(
            "unsafe plugin storage path '{path}'"
        )));
    }
    let trimmed = path.trim_matches('/');
    if trimmed.is_empty() {
        if allow_empty {
            return Ok(Vec::new());
        }
        return Err(AppError::InvalidArg("plugin storage path is empty".into()));
    }
    let rel = Path::new(trimmed);
    let mut out = Vec::new();
    for component in rel.components() {
        match component {
            Component::Normal(part) => {
                let part = part.to_string_lossy();
                safe_segment(&part, "plugin storage path segment")?;
                out.push(part.into_owned());
            }
            _ => {
                return Err(AppError::InvalidArg(format!(
                    "unsafe plugin storage path '{path}'"
                )));
            }
        }
    }
    Ok(out)
}

fn plugin_data_path(app: &AppHandle, plugin_id: &str, path: &str) -> AppResult<PathBuf> {
    let mut out = plugin_data_root(app, plugin_id)?;
    for segment in split_plugin_rel_path(path, true)? {
        out.push(segment);
    }
    Ok(out)
}

fn ensure_inside_data_root(root: &Path, target: &Path) -> AppResult<()> {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let target = target
        .canonicalize()
        .map_err(|e| AppError::InvalidArg(format!("plugin storage path: {e}")))?;
    if !target.starts_with(root) {
        return Err(AppError::InvalidArg(
            "plugin storage path escapes plugin data directory".into(),
        ));
    }
    Ok(())
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
#[allow(clippy::too_many_arguments)]
pub fn run_plugin_script(
    files: &discovery::PluginFiles,
    manifest: &serde_json::Value,
    checksum: &str,
    granted: Vec<String>,
    export: &str,
    input: serde_json::Value,
    notes: Vec<luau::NoteMeta>,
    native_tool_cwd: Option<PathBuf>,
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
            // Resolve the plugin's declared PATH binaries only when the tool
            // permission was granted; the map decides `ms.nativeTools` availability.
            let native_tools = if granted.iter().any(|p| p == PERM_NATIVE_TOOLS_RUN_DECLARED) {
                resolve_native_tools(manifest)
            } else {
                HashMap::new()
            };
            luau::run(luau::ScriptRequest {
                source,
                chunk_name: format!("{id}/{entry}"),
                export: export.to_string(),
                input,
                permissions: granted,
                notes,
                native_tools,
                native_tool_cwd,
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

#[tauri::command]
pub fn plugins_artifacts_status(
    app: AppHandle,
    db: State<'_, Db>,
    id: String,
) -> CommandResult<Vec<PluginArtifactStatus>> {
    db.with_conn(|c| require_enabled_permission(c, &id, PERM_PLUGIN_ARTIFACTS_DOWNLOAD))?;
    let third_party_dir = discovery::third_party_plugins_dir(&app)?;
    let plugin = discovery::find(&third_party_dir, &id)
        .ok_or_else(|| AppError::NotFound(format!("plugin {id} not found on disk")))?;
    parse_artifacts(&plugin.manifest)?
        .iter()
        .map(|artifact| artifact_status(&app, &id, artifact))
        .collect::<AppResult<Vec<_>>>()
        .map_err(Into::into)
}

#[tauri::command]
pub async fn plugins_download_artifact(
    app: AppHandle,
    db: State<'_, Db>,
    id: String,
    artifact_id: String,
) -> CommandResult<PluginArtifactStatus> {
    db.with_conn(|c| require_enabled_permission(c, &id, PERM_PLUGIN_ARTIFACTS_DOWNLOAD))?;
    let third_party_dir = discovery::third_party_plugins_dir(&app)?;
    let plugin = discovery::find(&third_party_dir, &id)
        .ok_or_else(|| AppError::NotFound(format!("plugin {id} not found on disk")))?;
    let artifact = find_artifact(&plugin.manifest, &artifact_id)?;
    download_artifact(app, id, artifact)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub fn plugins_read_artifact(
    app: AppHandle,
    db: State<'_, Db>,
    id: String,
    artifact_id: String,
) -> CommandResult<Vec<u8>> {
    db.with_conn(|c| require_enabled_permission(c, &id, PERM_PLUGIN_ARTIFACTS_DOWNLOAD))?;
    let third_party_dir = discovery::third_party_plugins_dir(&app)?;
    let plugin = discovery::find(&third_party_dir, &id)
        .ok_or_else(|| AppError::NotFound(format!("plugin {id} not found on disk")))?;
    let artifact = find_artifact(&plugin.manifest, &artifact_id)?;
    let path = artifact_file_path(&app, &id, &artifact)?;
    let bytes = fs::read(&path).map_err(|_| {
        AppError::NotFound(format!("installed artifact {artifact_id} for plugin {id}"))
    })?;
    let actual_hash = sha256_hex(&bytes);
    if actual_hash != artifact.sha256 {
        return Err(AppError::InvalidArg(format!(
            "installed artifact digest mismatch: expected {}, got {actual_hash}",
            artifact.sha256
        ))
        .into());
    }
    Ok(bytes)
}

#[tauri::command]
pub fn plugins_storage_read_text(
    app: AppHandle,
    db: State<'_, Db>,
    id: String,
    path: String,
) -> CommandResult<Option<String>> {
    db.with_conn(|c| require_enabled_permission(c, &id, PERM_PLUGIN_STORAGE_READ))?;
    split_plugin_rel_path(&path, false)?;
    let root = plugin_data_root(&app, &id)?;
    let target = plugin_data_path(&app, &id, &path)?;
    if !target.exists() {
        return Ok(None);
    }
    ensure_inside_data_root(&root, &target)?;
    fs::read_to_string(&target).map(Some).map_err(Into::into)
}

#[tauri::command]
pub fn plugins_storage_write_text(
    app: AppHandle,
    db: State<'_, Db>,
    id: String,
    path: String,
    contents: String,
) -> CommandResult<()> {
    db.with_conn(|c| require_enabled_permission(c, &id, PERM_PLUGIN_STORAGE_WRITE))?;
    split_plugin_rel_path(&path, false)?;
    let root = plugin_data_root(&app, &id)?;
    let target = plugin_data_path(&app, &id, &path)?;
    let parent = target
        .parent()
        .ok_or_else(|| AppError::InvalidArg("plugin storage path has no parent".into()))?;
    fs::create_dir_all(parent)?;
    ensure_inside_data_root(&root, parent)?;
    ensure_write_target_safe(&root, &target)?;
    fs::write(target, contents).map_err(Into::into)
}

#[tauri::command]
pub fn plugins_storage_delete(
    app: AppHandle,
    db: State<'_, Db>,
    id: String,
    path: String,
) -> CommandResult<()> {
    db.with_conn(|c| require_enabled_permission(c, &id, PERM_PLUGIN_STORAGE_WRITE))?;
    split_plugin_rel_path(&path, false)?;
    let root = plugin_data_root(&app, &id)?;
    let target = plugin_data_path(&app, &id, &path)?;
    if !target.exists() {
        return Ok(());
    }
    ensure_inside_data_root(&root, &target)?;
    if target.is_dir() {
        fs::remove_dir_all(target)?;
    } else {
        fs::remove_file(target)?;
    }
    Ok(())
}

#[tauri::command]
pub fn plugins_storage_list(
    app: AppHandle,
    db: State<'_, Db>,
    id: String,
    path: String,
) -> CommandResult<Vec<PluginStorageEntry>> {
    db.with_conn(|c| require_enabled_permission(c, &id, PERM_PLUGIN_STORAGE_READ))?;
    let root = plugin_data_root(&app, &id)?;
    let target = plugin_data_path(&app, &id, &path)?;
    if !target.exists() {
        return Ok(Vec::new());
    }
    ensure_inside_data_root(&root, &target)?;
    let base_segments = split_plugin_rel_path(&path, true)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&target)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        safe_segment(&name, "plugin storage entry")?;
        let metadata = entry.metadata()?;
        let mut parts = base_segments.clone();
        parts.push(name);
        out.push(PluginStorageEntry {
            path: parts.join("/"),
            is_dir: metadata.is_dir(),
            bytes: if metadata.is_file() {
                Some(metadata.len())
            } else {
                None
            },
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

#[tauri::command]
pub fn plugins_native_tool_status(
    app: AppHandle,
    db: State<'_, Db>,
    id: String,
    tool_id: String,
) -> CommandResult<PluginNativeToolStatus> {
    db.with_conn(|c| require_enabled_permission(c, &id, PERM_NATIVE_TOOLS_RUN_DECLARED))?;
    let third_party_dir = discovery::third_party_plugins_dir(&app)?;
    let plugin = discovery::find(&third_party_dir, &id)
        .ok_or_else(|| AppError::NotFound(format!("plugin {id} not found on disk")))?;
    let tool = find_native_tool(&plugin.manifest, &tool_id)?;
    // Native tools are desktop-only. Report a uniform "not available" status on
    // mobile rather than erroring, so the frontend can fall back to source-only.
    if cfg!(mobile) {
        return Ok(PluginNativeToolStatus {
            plugin_id: id,
            tool_id: tool.id,
            binary_name: tool.binary_name,
            available: false,
            path: None,
        });
    }
    native_tool_status(&id, &tool).map_err(Into::into)
}

#[tauri::command]
pub async fn plugins_run_native_tool(
    app: AppHandle,
    db: State<'_, Db>,
    id: String,
    tool_id: String,
    args: Vec<String>,
    stdin: Option<String>,
    timeout_ms: Option<u64>,
) -> CommandResult<PluginNativeToolOutput> {
    if cfg!(mobile) {
        return Err(AppError::InvalidArg("native tools are desktop-only".into()).into());
    }
    db.with_conn(|c| require_enabled_permission(c, &id, PERM_NATIVE_TOOLS_RUN_DECLARED))?;
    let third_party_dir = discovery::third_party_plugins_dir(&app)?;
    let plugin = discovery::find(&third_party_dir, &id)
        .ok_or_else(|| AppError::NotFound(format!("plugin {id} not found on disk")))?;
    let tool = find_native_tool(&plugin.manifest, &tool_id)?;
    let binary = resolve_path_binary(&tool.binary_name)?.ok_or_else(|| {
        AppError::NotFound(format!(
            "native tool '{}' was not found in PATH",
            tool.binary_name
        ))
    })?;
    let cwd = plugin_data_root(&app, &id)?;
    let raw = tauri::async_runtime::spawn_blocking(move || {
        run_native_tool_process(binary, cwd, args, stdin, timeout_ms)
    })
    .await
    .map_err(|e| AppError::InvalidArg(format!("native tool task failed: {e}")))??;
    Ok(PluginNativeToolOutput {
        status_code: raw.status_code,
        stdout: String::from_utf8_lossy(&raw.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&raw.stderr).into_owned(),
        timed_out: raw.timed_out,
    })
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
    // The plugin's isolated data root is the cwd for any native tool the script
    // runs via `ms.nativeTools`; resolved here (needs the AppHandle) so the
    // blocking worker stays Tauri-free.
    let native_tool_cwd = plugin_data_root(&app, &id).ok();
    // Run on a blocking worker: this isolates the guest so a hard crash can't
    // abort the app. Guest *logic* errors (Luau/wasm) come back as `Ok(Err(..))`
    // and are just surfaced to the user; a `JoinError` means the host runtime
    // itself panicked — a crash — so we disable the plugin before returning.
    let export_label = export.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        run_plugin_script(
            &files,
            &manifest,
            &checksum,
            granted,
            &export,
            input,
            notes,
            native_tool_cwd,
        )
    })
    .await;
    match outcome {
        Ok(result) => result.map_err(Into::into),
        Err(join_err) => {
            let reason = format!("plugin crashed while running '{export_label}': {join_err}");
            log::error!("[plugins] {reason}");
            let _ = db.with_conn(|c| disable_crashed(c, &id, &reason));
            Err(AppError::InvalidArg(reason).into())
        }
    }
}

#[cfg(test)]
mod tests;
