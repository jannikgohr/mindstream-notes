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

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;
use zip::write::FileOptions;
use zip::CompressionMethod;

use crate::auth;
use crate::db::Db;
use crate::error::{AppError, AppResult, CommandResult};

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
mod portable;
mod restore;
mod staging;
pub use mindstream_storage_core::backup::*;

pub use export::*;
pub use merge::*;
pub use restore::*;
pub use staging::*;

#[cfg(test)]
use crate::db::migrations;
#[cfg(test)]
use rusqlite::params;

#[cfg(test)]
mod portable_tests;
#[cfg(test)]
mod tests;
