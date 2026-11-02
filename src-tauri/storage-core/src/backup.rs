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

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

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
