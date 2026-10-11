//! Unscoped browser content belongs to the first selected legacy vault. Import
//! and receipt commit together; browser source bytes are never deleted here.
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult, CommandResult};
use crate::storage_locks::RootLock;

const MAX_BYTES: usize = 32 * 1024 * 1024;
const OWNER_FILE: &str = "legacy-content-owner.json";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Owner {
    version: u32,
    vault_id: String,
    directory: std::path::PathBuf,
}

fn invalid() -> AppError {
    AppError::InvalidArg(
        "legacy browser content cannot be migrated; original bytes retained".into(),
    )
}

fn decode_owner(raw: &[u8]) -> AppResult<Owner> {
    if raw.len() > 16384 {
        return Err(invalid());
    }
    let owner: Owner = serde_json::from_slice(raw).map_err(|_| invalid())?;
    if owner.version != 1
        || owner.vault_id.is_empty()
        || owner.vault_id.len() > 128
        || !owner.directory.is_absolute()
    {
        return Err(invalid());
    }
    Ok(owner)
}

/// Run during startup before any frontend can import shared content. An owner's
/// later deletion does not reassign its browser data to a different vault.
pub fn initialize_owner(root: &Path, vault_id: &str, vault: &Path) -> AppResult<()> {
    let _lock = RootLock::acquire(root)?;
    let path = root.join(OWNER_FILE);
    crate::root_documents::recover(
        &path,
        |b| decode_owner(b).map(|_| ()),
        |b| decode_owner(b).map(|_| ()),
    )?;
    if !path.try_exists()? {
        let owner = Owner {
            version: 1,
            vault_id: vault_id.into(),
            directory: fs::canonicalize(vault)?,
        };
        let raw = serde_json::to_vec(&owner).map_err(|_| invalid())?;
        crate::root_documents::write(&path, &raw, |b| decode_owner(b).map(|_| ()))?;
    }
    Ok(())
}

pub(crate) fn is_owner(root: &Path, vault_id: &str, vault: &Path) -> AppResult<bool> {
    let _lock = RootLock::acquire(root)?;
    let owner = decode_owner(&fs::read(root.join(OWNER_FILE))?)?;
    Ok(owner.vault_id == vault_id && owner.directory == fs::canonicalize(vault)?)
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Signatures,
    Favourites,
}

fn parse(raw: &str) -> AppResult<Value> {
    if raw.len() > MAX_BYTES {
        return Err(invalid());
    }
    serde_json::from_str(raw).map_err(|_| invalid())
}

fn signatures(
    array_raw: Option<&str>,
    single_raw: Option<&str>,
) -> AppResult<BTreeMap<String, String>> {
    let mut entries = Vec::new();
    if let Some(raw) = array_raw {
        let value = parse(raw)?;
        let values = value.as_array().ok_or_else(invalid)?;
        if values.len() > 4096 {
            return Err(invalid());
        }
        entries.extend(values.iter().cloned());
    }
    if let Some(raw) = single_raw {
        entries.push(parse(raw)?);
    }
    let mut records = BTreeMap::new();
    for value in entries {
        let object = value.as_object().ok_or_else(invalid)?;
        if !["width", "height"]
            .iter()
            .all(|k| value[*k].as_f64().is_some_and(|v| v.is_finite() && v > 0.0))
            || !value["strokes"]
                .as_array()
                .is_some_and(|strokes| !strokes.is_empty())
        {
            return Err(invalid());
        }
        let mut geometry = object.clone();
        geometry.remove("id");
        let data = serde_json::to_string(&geometry).map_err(|_| invalid())?;
        let id = match value["id"].as_str().filter(|id| !id.is_empty()) {
            Some(id) if id.len() <= 512 => id.to_owned(),
            Some(_) => return Err(invalid()),
            None => format!("legacy-{:x}", Sha256::digest(data.as_bytes())),
        };
        if records.get(&id).is_some_and(|previous| previous != &data) {
            return Err(invalid());
        }
        records.insert(id, data);
    }
    Ok(records)
}

fn import(
    conn: &mut Connection,
    kind: Kind,
    array_raw: Option<&str>,
    single_raw: Option<&str>,
) -> AppResult<Vec<String>> {
    let migration_id = match kind {
        Kind::Signatures => "browser-signatures-v1",
        Kind::Favourites => "browser-favourites-v1",
    };
    let tx = conn.transaction()?;
    let complete: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM local_migrations WHERE id = ?1)",
        [migration_id],
        |row| row.get(0),
    )?;
    if complete {
        return Ok(Vec::new());
    }
    // Absence is not a receipt: an isolated worker may obtain its legacy source
    // from the retained export later. Only an actual source can complete import.
    if array_raw.is_none() && single_raw.is_none() {
        return Ok(Vec::new());
    }
    let now = chrono::Utc::now().to_rfc3339();
    let mut changed = Vec::new();
    match kind {
        Kind::Signatures => {
            for (id, data) in signatures(array_raw, single_raw)? {
                tx.execute("INSERT INTO signatures(id, data, created, modified, dirty) VALUES (?1, ?2, ?3, ?3, 1) ON CONFLICT(id) DO NOTHING", params![id, data, now])?;
            }
        }
        Kind::Favourites => {
            if single_raw.is_some() {
                return Err(invalid());
            }
            let value = parse(array_raw.ok_or_else(invalid)?)?;
            let ids = value.as_array().ok_or_else(invalid)?;
            if ids.len() > 4096 {
                return Err(invalid());
            }
            for id in ids {
                let id = id
                    .as_str()
                    .filter(|id| !id.is_empty() && id.len() <= 512)
                    .ok_or_else(invalid)?;
                let needs_update: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM notes WHERE id = ?1 AND favourite = 0)",
                    [id],
                    |row| row.get(0),
                )?;
                if needs_update {
                    crate::sharing::ensure_note_writable(&tx, id)?;
                    tx.execute(
                        "UPDATE notes SET favourite = 1, dirty = 1, modified = ?2 WHERE id = ?1",
                        params![id, now],
                    )?;
                    changed.push(id.to_owned());
                }
            }
        }
    }
    let mut digest = Sha256::new();
    for raw in [array_raw, single_raw] {
        digest.update((raw.map_or(0, str::len) as u64).to_be_bytes());
        digest.update(raw.unwrap_or_default().as_bytes());
    }
    tx.execute(
        "INSERT INTO local_migrations(id, completed, source_hash) VALUES (?1, ?2, ?3)",
        params![migration_id, now, format!("{:x}", digest.finalize())],
    )?;
    tx.commit()?;
    Ok(changed)
}

#[tauri::command]
pub async fn migrate_legacy_content(
    app: AppHandle,
    kind: Kind,
    array_raw: Option<String>,
    single_raw: Option<String>,
) -> CommandResult<Vec<String>> {
    let root = crate::paths::app_data_root(&app)?;
    let active = app.state::<crate::paths::ActiveProfile>();
    let vault_id = active.id.clone();
    let vault = active.dir.clone();
    let job = app.state::<crate::vault_jobs::Jobs>().enter()?;
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let _job = job;
        if !is_owner(&root, &vault_id, &vault)? {
            return Ok(Vec::new());
        }
        let source = app.try_state::<crate::browser_migration::Source>();
        let (array_raw, single_raw) = if let Some(source) = source.as_ref() {
            match kind {
                Kind::Signatures => (
                    source.raw("mindstream.pdf.signatures.v1"),
                    source.raw("mindstream.pdf.signature.v1"),
                ),
                Kind::Favourites => (source.raw("notes-app:mobile:favourites"), None),
            }
        } else {
            (array_raw.as_deref(), single_raw.as_deref())
        };
        app.state::<crate::db::Db>()
            .with_conn_mut(|conn| import(conn, kind, array_raw, single_raw))
    })
    .await
    .map_err(|_| invalid())??)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(id: &str) -> Value {
        serde_json::json!({"id": id, "width": 100, "height": 30, "strokes": [{"points": [{"x": 1, "y": 2}]}]})
    }
    fn source(ids: &[&str]) -> String {
        serde_json::to_string(&ids.iter().map(|id| record(id)).collect::<Vec<_>>()).unwrap()
    }
    fn receipts(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM local_migrations", [], |row| {
            row.get(0)
        })
        .unwrap()
    }

    #[test]
    fn imports_both_signature_shapes_preserves_existing_edits_and_deletions() {
        let db = crate::db::open_memory_for_tests();
        db.with_conn_mut(|conn| {
            crate::signatures::upsert(
                conn,
                crate::signatures::SaveSignature {
                    id: "existing".into(),
                    data: "user edit".into(),
                },
            )?;
            let array = source(&["existing", "new"]);
            let single = record("single").to_string();
            import(conn, Kind::Signatures, Some(&array), Some(&single))?;
            assert_eq!(crate::signatures::load(conn, "existing")?.data, "user edit");
            assert_eq!(crate::signatures::list(conn)?.len(), 3);
            assert_eq!(receipts(conn), 1);
            crate::signatures::delete(conn, "new")?;
            import(
                conn,
                Kind::Signatures,
                Some("bad stale source"),
                Some(&single),
            )?;
            assert!(crate::signatures::load(conn, "new").is_err());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn database_failure_rolls_back_all_rows_and_receipt_then_retry_succeeds() {
        let db = crate::db::open_memory_for_tests();
        db.with_conn_mut(|conn| {
            conn.execute_batch("CREATE TRIGGER reject_second BEFORE INSERT ON signatures WHEN NEW.id = 'b' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;")?;
            let raw = source(&["a", "b"]);
            assert!(import(conn, Kind::Signatures, Some(&raw), None).is_err());
            assert!(crate::signatures::list(conn)?.is_empty());
            assert_eq!(receipts(conn), 0);
            conn.execute_batch("DROP TRIGGER reject_second")?;
            import(conn, Kind::Signatures, Some(&raw), None)?;
            assert_eq!(crate::signatures::list(conn)?.len(), 2);
            assert_eq!(receipts(conn), 1);
            Ok(())
        }).unwrap();
    }

    #[test]
    fn malformed_or_conflicting_content_never_records_completion() {
        let db = crate::db::open_memory_for_tests();
        db.with_conn_mut(|conn| {
            for raw in ["broken", "{}", r#"[{"width":1,"height":1,"strokes":[]}]"#] {
                assert!(import(conn, Kind::Signatures, Some(raw), None).is_err());
            }
            let mut different = record("same");
            different["width"] = 200.into();
            let raw = serde_json::json!([record("same"), different]).to_string();
            assert!(import(conn, Kind::Signatures, Some(&raw), None).is_err());
            assert!(crate::signatures::list(conn)?.is_empty());
            assert_eq!(receipts(conn), 0);
            import(conn, Kind::Signatures, None, None)?;
            assert_eq!(receipts(conn), 0);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn idless_signatures_have_stable_content_ids() {
        let mut entry = record("ignored");
        entry.as_object_mut().unwrap().remove("id");
        let array = serde_json::json!([entry]).to_string();
        let a = signatures(Some(&array), None).unwrap();
        let b = signatures(None, Some(&entry.to_string())).unwrap();
        assert_eq!(a, b);
        assert!(a.keys().next().unwrap().starts_with("legacy-"));
    }

    #[test]
    fn favourites_commit_together_with_receipt_and_do_not_override_later_unfavourite() {
        let db = crate::db::open_memory_for_tests();
        db.with_conn_mut(|conn| {
            conn.execute("INSERT INTO notes(id,title,created,modified,dirty) VALUES ('note','N','before','before',0)", [])?;
            assert!(import(conn, Kind::Favourites, Some(r#"["note",42]"#), None).is_err());
            let favourite: bool = conn.query_row("SELECT favourite FROM notes WHERE id = 'note'", [], |r| r.get(0))?;
            assert!(!favourite);
            assert_eq!(receipts(conn), 0);
            let changed = import(conn, Kind::Favourites, Some(r#"["note","missing","note"]"#), None)?;
            assert_eq!(changed, ["note"]);
            let state: (bool, bool, String) = conn.query_row("SELECT favourite,dirty,modified FROM notes WHERE id = 'note'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            assert!(state.0 && state.1);
            assert_ne!(state.2, "before");
            conn.execute("UPDATE notes SET favourite = 0 WHERE id = 'note'", [])?;
            assert!(import(conn, Kind::Favourites, Some(r#"["note"]"#), None)?.is_empty());
            let favourite: bool = conn.query_row("SELECT favourite FROM notes WHERE id = 'note'", [], |r| r.get(0))?;
            assert!(!favourite);
            Ok(())
        }).unwrap();
    }

    #[test]
    fn root_owner_is_pinned_to_both_id_and_physical_directory() {
        let root = std::env::temp_dir().join(format!("ms-content-{}", uuid::Uuid::new_v4()));
        let a = root.join("a");
        let b = root.join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        initialize_owner(&root, "a", &a).unwrap();
        let bytes = fs::read(root.join(OWNER_FILE)).unwrap();
        initialize_owner(&root, "b", &b).unwrap();
        assert_eq!(fs::read(root.join(OWNER_FILE)).unwrap(), bytes);
        assert!(is_owner(&root, "a", &a).unwrap());
        assert!(!is_owner(&root, "a", &b).unwrap());
        assert!(!is_owner(&root, "b", &a).unwrap());
        fs::remove_dir_all(&a).unwrap();
        initialize_owner(&root, "b", &b).unwrap();
        assert!(!is_owner(&root, "b", &b).unwrap());
        fs::write(root.join(OWNER_FILE), b"corrupt owner").unwrap();
        assert!(initialize_owner(&root, "b", &b).is_err());
        assert_eq!(fs::read(root.join(OWNER_FILE)).unwrap(), b"corrupt owner");
        fs::remove_dir_all(&root).unwrap();
    }
}
