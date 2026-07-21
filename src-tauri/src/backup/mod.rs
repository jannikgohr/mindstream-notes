//! Backup export — Slice A of the Data & Backup feature.
//!
//! A backup is a zip file containing:
//!   - `manifest.json` — versioning, account identity, content counts
//!   - `data.db`       — full SQLite snapshot produced by VACUUM INTO
//!
//! Slice B will add the import preview, slice C the staged-restart
//! restore, slice D the in-process merge. Everything they need to read
//! the manifest is defined here so they reuse the same types.
//!
//! Account identity in the manifest follows the design we settled on:
//! the `etebase_collection_uid` for notes + folders read from the
//! source DB's `sync_state` table. Same UID → same account. The
//! friendly `username` / `server_url` come from the on-disk session
//! file purely for UI surfacing on mismatch — they don't gate the
//! match decision.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;
use zip::write::FileOptions;
use zip::CompressionMethod;

use crate::auth;
use crate::collections::TRASH_ID;
use crate::db::{migrations, Db};
use crate::error::{AppError, AppResult};

/// Bump only when the on-disk layout becomes incompatible with older
/// readers — adding new optional manifest fields shouldn't require it.
pub const MANIFEST_FORMAT_VERSION: u32 = 1;

/// Name of the SQLite snapshot inside the zip. Hardcoded so import
/// always knows where to look; `manifest.contents.db_filename` echoes
/// the value so a future schema change has a forward-compatible path.
pub const DB_ENTRY_NAME: &str = "data.db";

/// Name of the manifest file inside the zip.
pub const MANIFEST_ENTRY_NAME: &str = "manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub format_version: u32,
    pub app_version: String,
    pub schema_version: u32,
    pub created_at: String,
    /// True if the source DB's `sync_state` table had rows at export
    /// time. False ⇒ `account` is `None` and import treats this as a
    /// local-only backup regardless of who's signed in.
    pub account_present_at_export: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<AccountIdentity>,
    pub contents: Contents,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountIdentity {
    /// Etebase collection UID for the user's notes collection on the
    /// remote — the actual identity check on import compares this
    /// against the importing DB's `sync_state`.
    pub etebase_collection_uid_notes: String,
    pub etebase_collection_uid_folders: String,
    /// Friendly display, optional — surfaces in mismatch dialogs but
    /// isn't part of the equality check. Both fields are filled from
    /// the on-disk session file when available; absent if the user
    /// signed out after their data synced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Contents {
    pub db_filename: String,
    pub counts: Counts,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Counts {
    pub notes: u32,
    pub folders: u32,
    /// Total `size` column across the assets table. Lets the import
    /// preview show a "this backup carries X MB of attachments" line
    /// without extracting the zip first.
    pub assets_bytes: u64,
}

/// Result of a successful `backup_now`. The destination path is what
/// the user picked; the counts mirror the manifest so the JS side can
/// surface a "backup contains N notes" toast without re-reading.
#[derive(Debug, Clone, Serialize)]
pub struct BackupReport {
    pub destination: String,
    pub counts: Counts,
    pub account_present: bool,
}

mod export;
mod merge;
mod restore;
mod staging;

pub use export::*;
pub use merge::*;
pub use restore::*;
pub use staging::*;

#[cfg(test)]
mod tests;
