//! The backup format, shared by native and browser storage.
//!
//! A backup is a zip holding `manifest.json` and a `data.db` SQLite snapshot.
//! The app also adds portable resources, which `manifest.portable` lists. A
//! browser has none to add, so it writes the older format without them, which
//! every version of the app can open.
//!
//! A backup is made to leave the device, so both platforms prepare the
//! snapshot here and cannot drift apart on what stays behind.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::migrations;

mod merge;
pub use merge::*;

/// Bump only when the on-disk layout becomes incompatible with older
/// readers — adding new optional manifest fields shouldn't require it.
pub const MANIFEST_FORMAT_VERSION: u32 = 2;

/// The format without portable resources. Format 2 requires them, so that a
/// reader can tell an incomplete backup from a complete one.
pub const MANIFEST_FORMAT_WITHOUT_RESOURCES: u32 = 1;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_db_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub portable: Option<PortableIndex>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortableIndex {
    pub files: Vec<PortableEntry>,
    pub directories: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortableEntry {
    pub path: String,
    pub sha256: String,
    pub size: u64,
    pub mode: u32,
}

/// Preview shown in the import-choice dialog so the user knows what
/// they're about to apply. Counts come from the staged DB *after*
/// migrations, so they reflect the schema the import would actually
/// land at.
#[derive(Debug, Clone, Serialize)]
pub struct ImportPreview {
    /// Identifies this staged backup. Pass back into `import_restore`,
    /// `import_merge`, or `import_cleanup` to reference this attempt.
    pub token: String,
    pub backup_counts: Counts,
    pub current_counts: Counts,
    pub backup_app_version: String,
    pub backup_created_at: String,
    /// True if the backup's account UIDs match the current DB's
    /// sync_state. False means import would sanitize sync metadata on
    /// restore (and merge always sanitizes regardless).
    pub same_account: bool,
    /// Friendly identifiers for the dialog copy — both optional;
    /// `None` for the relevant side means "local-only" there.
    pub backup_account: Option<AccountDisplay>,
    pub current_account: Option<AccountDisplay>,
    pub portable: bool,
    pub plugin_packages: u32,
    pub plugin_data_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountDisplay {
    pub username: Option<String>,
    pub server_url: Option<String>,
}

impl Manifest {
    /// `snapshot` is the prepared database that goes into the zip, so the
    /// manifest describes the point-in-time view it ships.
    pub fn for_snapshot(
        snapshot: &Connection,
        app_version: &str,
        account: Option<AccountIdentity>,
        data_db_sha256: Option<String>,
        portable: Option<PortableIndex>,
    ) -> AppResult<Self> {
        Ok(Self {
            format_version: if portable.is_some() {
                MANIFEST_FORMAT_VERSION
            } else {
                MANIFEST_FORMAT_WITHOUT_RESOURCES
            },
            app_version: app_version.to_string(),
            schema_version: snapshot.query_row("PRAGMA user_version", [], |r| r.get(0))?,
            created_at: chrono::Utc::now().to_rfc3339(),
            account_present_at_export: account.is_some(),
            account,
            contents: Contents {
                db_filename: DB_ENTRY_NAME.to_string(),
                counts: read_counts(snapshot)?,
            },
            data_db_sha256,
            portable,
        })
    }
}

pub fn suggested_filename() -> String {
    let now = chrono::Utc::now();
    format!("mindstream-backup-{}.zip", now.format("%Y-%m-%dT%H-%M-%S"))
}

/// Take out of a copy of the database what is of use on this device only.
///
/// The room keys kept here are sealed for this device's session and open
/// nowhere else. A backup is made to leave the device, so they are not in
/// it. `secure_delete` has the freed pages overwritten, so that they are
/// gone from the file and not only from the table. A restored backup gets
/// them again from the server.
pub fn leave_device_secrets_out(snapshot: &Connection) -> AppResult<()> {
    snapshot.pragma_update(None, "secure_delete", "ON")?;
    snapshot.execute("DELETE FROM room_keys", [])?;
    Ok(())
}

/// Drop what ties plugins to this installation. `builtins` keep their state,
/// because they ship with every install. `device_keys` are the plugin settings
/// that belong to this device, by plugin id.
pub fn sanitize_snapshot(
    snapshot: &mut Connection,
    builtins: &BTreeSet<String>,
    device_keys: &BTreeMap<String, BTreeSet<String>>,
) -> AppResult<()> {
    let tx = snapshot.transaction()?;
    let ids = tx
        .prepare("SELECT id FROM plugins")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    tx.execute("UPDATE plugins SET source_path = NULL", [])?;
    for id in ids {
        if !builtins.contains(&id) {
            tx.execute(
                "UPDATE plugins SET enabled = 0, accepted_hash = '', signer = NULL WHERE id = ?1",
                [&id],
            )?;
            tx.execute(
                "DELETE FROM plugin_installations WHERE plugin_id = ?1",
                [&id],
            )?;
        }
    }
    for (id, keys) in device_keys {
        for key in keys {
            tx.execute(
                "DELETE FROM plugin_settings WHERE plugin_id = ?1 AND key = ?2",
                params![id, key],
            )?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// What a reader checks before it trusts anything else in a backup. `entries`
/// are the names of everything in the archive.
pub fn check_manifest(manifest: &Manifest, entries: &[String]) -> AppResult<()> {
    if manifest.format_version == 0 || manifest.format_version > MANIFEST_FORMAT_VERSION {
        return Err(AppError::InvalidArg("unsupported backup format".into()));
    }
    if manifest.contents.db_filename != DB_ENTRY_NAME {
        return Err(AppError::InvalidArg("invalid database entry name".into()));
    }
    let mut names = BTreeSet::new();
    for entry in entries {
        if !names.insert(entry.to_lowercase()) {
            return Err(AppError::InvalidArg("duplicate backup entry".into()));
        }
    }
    if manifest.format_version == 2 {
        let index = manifest
            .portable
            .as_ref()
            .ok_or_else(|| AppError::InvalidArg("backup resources missing".into()))?;
        if entries.len() != index.files.len() + 2 || manifest.data_db_sha256.is_none() {
            return Err(AppError::InvalidArg("incomplete backup".into()));
        }
    } else if manifest.portable.is_some() {
        return Err(AppError::InvalidArg(
            "legacy backup has unsupported resources".into(),
        ));
    }
    Ok(())
}

/// Refuse future schemas and migrate older ones forward. This has to happen
/// before anything reads the staged DB, so that its table shapes match what a
/// restore or merge will encounter.
pub fn prepare_staged(staged: &mut Connection, live: &Connection) -> AppResult<()> {
    let staged_version: u32 = staged.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let live_version: u32 = live.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if staged_version > live_version {
        return Err(AppError::InvalidArg(format!(
            "backup uses schema v{staged_version} but this app understands at most \
             v{live_version} — update the app and try again"
        )));
    }
    validate_looks_like_mindstream_db(staged)?;
    migrations::run(staged)?;
    Ok(())
}

pub fn validate_looks_like_mindstream_db(conn: &Connection) -> AppResult<()> {
    // Cheap structural check — confirms the file is a SQLite DB and
    // has the tables we touch downstream. Real corruption would
    // surface during PRAGMA integrity_check, but that's O(file size)
    // and overkill for the "is this even our format?" question.
    for table in ["notes", "collections", "sync_state", "tombstones"] {
        let found: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
                params![table],
                |r| r.get(0),
            )
            .optional()?;
        if found.is_none() {
            return Err(AppError::InvalidArg(format!(
                "backup is missing the '{table}' table — file is not a Mindstream backup"
            )));
        }
    }
    Ok(())
}

/// Describe a staged backup for the import-choice dialog.
pub fn preview_import(
    token: String,
    manifest: Manifest,
    staged: &Connection,
    live: &Connection,
    current_identity: Option<AccountIdentity>,
) -> AppResult<ImportPreview> {
    let backup_identity = read_account_identity(staged, None, None)?;
    let same_account = match (&backup_identity, &current_identity) {
        (Some(backup), Some(current)) => same_identity(backup, current),
        _ => false,
    };
    // The friendly identifiers come from the *manifest* for the backup
    // side (the staged sync_state has the UIDs but not the user-facing
    // username / server URL — those were captured at export time).
    let display = |identity: &AccountIdentity| AccountDisplay {
        username: identity.username.clone(),
        server_url: identity.server_url.clone(),
    };
    let portable = manifest.portable.as_ref();
    Ok(ImportPreview {
        token,
        backup_counts: read_counts(staged)?,
        current_counts: read_counts(live)?,
        backup_app_version: manifest.app_version.clone(),
        backup_created_at: manifest.created_at.clone(),
        same_account,
        backup_account: manifest.account.as_ref().map(display),
        current_account: current_identity.as_ref().map(display),
        portable: portable.is_some(),
        plugin_packages: portable
            .map(|index| {
                index
                    .directories
                    .iter()
                    .filter(|path| {
                        path.starts_with("portable/packages/") && path.split('/').count() == 3
                    })
                    .count() as u32
            })
            .unwrap_or(0),
        plugin_data_bytes: portable
            .map(|index| {
                index
                    .files
                    .iter()
                    .filter(|entry| entry.path.starts_with("portable/plugin-data/"))
                    .map(|entry| entry.size)
                    .sum()
            })
            .unwrap_or(0),
    })
}

pub fn same_identity(backup: &AccountIdentity, current: &AccountIdentity) -> bool {
    backup.etebase_collection_uid_notes == current.etebase_collection_uid_notes
        && backup.etebase_collection_uid_folders == current.etebase_collection_uid_folders
}

/// Detach a staged database from the account it came from, so that a future
/// push to whatever account the user signs into next treats every row as new.
pub fn sanitize_for_foreign_account(staged: &mut Connection) -> AppResult<()> {
    let tx = staged.transaction()?;
    tx.execute(
        "UPDATE notes SET etebase_uid = NULL, etebase_etag = NULL, dirty = 1",
        [],
    )?;
    tx.execute(
        "UPDATE collections SET etebase_uid = NULL, etebase_etag = NULL, dirty = 1 WHERE id <> 'trash'",
        [],
    )?;
    tx.execute(
        "UPDATE assets SET etebase_uid = NULL, etebase_etag = NULL, dirty = 1",
        [],
    )?;
    tx.execute(
        "UPDATE signatures SET etebase_uid = NULL, etebase_etag = NULL, dirty = 1",
        [],
    )?;
    // Drop the per-kind collection pointers + stoken cursors and any
    // queued tombstones for the foreign account.
    tx.execute("DELETE FROM sync_state", [])?;
    tx.execute("DELETE FROM tombstones", [])?;
    tx.commit()?;
    Ok(())
}

pub fn read_account_identity(
    conn: &Connection,
    server_url: Option<String>,
    username: Option<String>,
) -> AppResult<Option<AccountIdentity>> {
    // Both collection UIDs must be present for the identity block to
    // count — a half-synced DB (one kind pushed, the other not) is a
    // gnarly state we don't try to round-trip identity for.
    let uid = |kind: &str| -> Option<String> {
        conn.query_row(
            "SELECT etebase_collection_uid FROM sync_state WHERE kind = ?1",
            [kind],
            |r| r.get(0),
        )
        .ok()
        .flatten()
    };
    Ok(match (uid("notes"), uid("folders")) {
        (Some(notes), Some(folders)) => Some(AccountIdentity {
            etebase_collection_uid_notes: notes,
            etebase_collection_uid_folders: folders,
            server_url,
            username,
        }),
        _ => None,
    })
}

pub fn read_counts(conn: &Connection) -> AppResult<Counts> {
    let notes: u32 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))?;
    // Folders: exclude the built-in 'trash' collection — it's an
    // always-present implementation detail, not user content. The
    // import flow knows to recreate it.
    let folders: u32 = conn.query_row(
        "SELECT COUNT(*) FROM collections WHERE id <> 'trash'",
        [],
        |r| r.get(0),
    )?;
    let assets_bytes: i64 = conn
        .query_row("SELECT COALESCE(SUM(size), 0) FROM assets", [], |r| {
            r.get(0)
        })
        .unwrap_or(0);
    Ok(Counts {
        notes,
        folders,
        assets_bytes: assets_bytes.max(0) as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrations;
    use crate::notes::{self, CreateNote};

    fn snapshot() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        conn
    }

    fn plugin(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO plugins (id, version, source_path, accepted_hash, signer, installed_at,
                                  updated_at)
             VALUES (?1, '1.0.0', '/plugins', 'hash', 'signer', 'now', 'now')",
            [id],
        )
        .unwrap();
    }

    #[test]
    fn device_secrets_stay_behind() {
        let conn = snapshot();
        let input = CreateNote {
            title: None,
            body: None,
            parent_collection_id: None,
            note_kind: None,
        };
        let note = notes::create(&conn, input).unwrap();
        conn.execute(
            "INSERT INTO room_keys (note_id, sealed) VALUES (?1, x'01')",
            [&note.summary.id],
        )
        .unwrap();
        leave_device_secrets_out(&conn).unwrap();
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM room_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
        let secure: i64 = conn
            .query_row("PRAGMA secure_delete", [], |r| r.get(0))
            .unwrap();
        assert_eq!(secure, 1);
    }

    #[test]
    fn only_shipped_plugins_keep_their_state() {
        let mut conn = snapshot();
        plugin(&conn, "shipped");
        plugin(&conn, "installed");
        let state = |conn: &Connection, id: &str| -> (i64, String, Option<String>) {
            conn.query_row(
                "SELECT enabled, accepted_hash, source_path FROM plugins WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap()
        };
        let builtins = BTreeSet::from(["shipped".to_string()]);
        sanitize_snapshot(&mut conn, &builtins, &BTreeMap::new()).unwrap();
        assert_eq!(state(&conn, "shipped"), (1, "hash".into(), None));
        assert_eq!(state(&conn, "installed"), (0, String::new(), None));
    }

    #[test]
    fn the_manifest_counts_user_content_and_has_no_account_when_local() {
        let conn = snapshot();
        conn.execute(
            "INSERT INTO collections (id, name, created, modified)
             VALUES ('folder', 'Folder', 'now', 'now')",
            [],
        )
        .unwrap();
        let manifest =
            Manifest::for_snapshot(&conn, "1.2.3", None, Some("abc".into()), None).unwrap();
        assert_eq!(manifest.format_version, MANIFEST_FORMAT_WITHOUT_RESOURCES);
        assert_eq!(manifest.app_version, "1.2.3");
        assert!(manifest.schema_version > 0);
        assert!(!manifest.account_present_at_export);
        assert_eq!(manifest.contents.db_filename, DB_ENTRY_NAME);
        assert_eq!(manifest.contents.counts.folders, 1);
        assert_eq!(manifest.data_db_sha256.as_deref(), Some("abc"));

        let json = serde_json::to_value(&manifest).unwrap();
        assert!(json.get("portable").is_none());
        assert!(json.get("account").is_none());
    }

    #[test]
    fn resources_decide_the_format() {
        let index = PortableIndex {
            files: Vec::new(),
            directories: Vec::new(),
        };
        let manifest =
            Manifest::for_snapshot(&snapshot(), "1.2.3", None, None, Some(index)).unwrap();
        assert_eq!(manifest.format_version, MANIFEST_FORMAT_VERSION);
    }

    #[test]
    fn a_backup_name_sorts_by_time_and_is_safe_on_every_filesystem() {
        let name = suggested_filename();
        assert!(name.starts_with("mindstream-backup-"));
        assert!(name.ends_with(".zip"));
        assert!(!name.contains(':'));
    }
}
