//! Dedicated-worker binding for the SQLite compatibility proof.
#![cfg(target_arch = "wasm32")]

mod receipts;

use mindstream_storage_core::error::AppError;
use mindstream_storage_core::{asset_hash, backup, migrations, proof, vault_api};
use rusqlite::Connection;
use serde::Serialize;
use sqlite_wasm_vfs::sahpool::{install, OpfsSAHPoolCfg, OpfsSAHPoolUtil};
use std::collections::{BTreeMap, BTreeSet};
use wasm_bindgen::prelude::*;

#[derive(Serialize)]
struct StorageError {
    code: &'static str,
    message: String,
}

fn error(message: impl std::fmt::Display) -> JsValue {
    serde_wasm_bindgen::to_value(&StorageError {
        code: "database",
        message: message.to_string(),
    })
    .unwrap_or_else(|_| JsValue::from_str("Could not encode storage error"))
}

/// Where a backup's snapshot lives while it is prepared. It takes a pool file
/// of its own, separate from the vault.
const BACKUP_SNAPSHOT: &str = "/backup-snapshot.sqlite3";

/// The snapshot is read into Wasm memory whole, and a failed allocation aborts
/// the worker, so a larger vault gets a clear refusal instead.
const MAX_BACKUP_BYTES: i64 = 1 << 30;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserBackup {
    manifest: String,
    filename: String,
    counts: backup::Counts,
    account_present: bool,
}

#[wasm_bindgen]
pub struct BrowserDatabase {
    conn: Option<Connection>,
    pool: OpfsSAHPoolUtil,
}

#[wasm_bindgen]
impl BrowserDatabase {
    /// The worker must hold the origin's pool lock before calling this.
    pub async fn open() -> Result<BrowserDatabase, JsValue> {
        Self::open_database(true, None).await
    }

    pub async fn open_vault() -> Result<BrowserDatabase, JsValue> {
        Self::open_database(false, None).await
    }

    pub async fn open_test_vault(id: String) -> Result<BrowserDatabase, JsValue> {
        if id.is_empty()
            || id.len() > 48
            || !id.as_bytes()[0].is_ascii_lowercase() && !id.as_bytes()[0].is_ascii_digit()
            || !id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err(command_error(AppError::InvalidArg(
                "Invalid browser test vault identifier".into(),
            )));
        }
        Self::open_database(false, Some(&id)).await
    }

    pub fn invoke(
        &mut self,
        request: JsValue,
        recovery_token: Option<String>,
    ) -> Result<JsValue, JsValue> {
        let request = serde_wasm_bindgen::from_value::<vault_api::VaultRequest>(request)
            .map_err(|e| command_error(AppError::InvalidArg(e.to_string())))?;
        let note_id = match &request {
            vault_api::VaultRequest::SaveNote { input } => Some(input.id.as_str()),
            vault_api::VaultRequest::DrawingSaveInkState { note_id, .. } => Some(note_id.as_str()),
            _ => None,
        };
        let write = match recovery_token.as_deref() {
            Some(token) if !token.is_empty() && token.len() <= 128 => Some((
                note_id.ok_or_else(|| {
                    command_error(AppError::InvalidArg(
                        "This operation cannot have a save receipt".into(),
                    ))
                })?,
                token,
            )),
            Some(_) => {
                return Err(command_error(AppError::InvalidArg(
                    "Invalid save receipt".into(),
                )))
            }
            None => None,
        };
        let conn = self.connection()?;
        receipts::context(conn, write).map_err(error)?;
        let response = vault_api::dispatch(conn, request);
        receipts::context(conn, None).map_err(error)?;
        let response = response.map_err(command_error)?;
        response
            .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
            .map_err(error)
    }

    pub fn receipt(&mut self, note_id: &str) -> Result<Option<String>, JsValue> {
        receipts::read(self.connection()?, note_id).map_err(error)
    }

    /// Proof-only interrupted-write probe. The worker must be terminated after
    /// this returns, so cache-spilled uncommitted pages require hot-journal undo.
    pub fn prepare_interrupted_write(&mut self) -> Result<(), JsValue> {
        let conn = self.connection()?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS crash_probe (id INTEGER PRIMARY KEY, payload BLOB);
            DELETE FROM crash_probe;
            BEGIN;
            WITH RECURSIVE seq(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM seq WHERE id < 300)
            INSERT INTO crash_probe SELECT id, zeroblob(3000) FROM seq;
            COMMIT;
            PRAGMA cache_size = 10;
            BEGIN IMMEDIATE;
            UPDATE crash_probe SET payload = randomblob(3000);",
        )
        .map_err(error)
    }

    pub fn check_interrupted_write(&mut self) -> Result<u32, JsValue> {
        self.connection()?
            .query_row(
                "SELECT COUNT(*) FROM crash_probe WHERE payload = zeroblob(3000)",
                [],
                |r| r.get(0),
            )
            .map_err(error)
    }

    pub fn verify(&mut self) -> Result<JsValue, JsValue> {
        let report = proof::verify(self.connection()?).map_err(error)?;
        serde_wasm_bindgen::to_value(&report).map_err(error)
    }

    pub fn write(&mut self, body: &str) -> Result<(), JsValue> {
        proof::write_marker(self.connection()?, body).map_err(error)
    }

    pub fn read(&mut self) -> Result<Option<String>, JsValue> {
        proof::read_marker(self.connection()?).map_err(error)
    }

    /// A snapshot and manifest in the native backup format. A snapshot left
    /// by an interrupted backup is replaced, and nothing stays behind.
    pub fn backup(&mut self) -> Result<JsValue, JsValue> {
        let _ = self.pool.delete_db(BACKUP_SNAPSHOT);
        let result = self.write_backup();
        let _ = self.pool.delete_db(BACKUP_SNAPSHOT);
        result
    }

    pub fn close(&mut self) -> Result<(), JsValue> {
        if let Some(conn) = self.conn.take() {
            if let Err((conn, err)) = conn.close() {
                self.conn = Some(conn);
                return Err(error(err));
            }
        }
        self.pool.pause_vfs().map_err(error)
    }
}

impl BrowserDatabase {
    async fn open_database(
        is_proof: bool,
        test_id: Option<&str>,
    ) -> Result<BrowserDatabase, JsValue> {
        let cfg = OpfsSAHPoolCfg {
            directory: if let Some(id) = test_id {
                format!(".mindstream-browser-test-{id}")
            } else if is_proof {
                ".mindstream-sqlite-proof".into()
            } else {
                ".mindstream-browser-vault".into()
            },
            vfs_name: if let Some(id) = test_id {
                format!("mindstream-test-{id}")
            } else if is_proof {
                "mindstream-proof".into()
            } else {
                "mindstream-vault".into()
            },
            ..Default::default()
        };
        let pool = install::<sqlite_wasm_rs::WasmOsCallback>(&cfg, true)
            .await
            .map_err(error)?;
        let opened = (|| {
            let mut conn = Connection::open(if is_proof {
                "proof.sqlite3"
            } else {
                "notes.sqlite3"
            })?;
            let before: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
            let fresh = before == 0;
            // SAH pools do not coordinate shared-memory WAL. Use durable
            // rollback journals, with all access serialized by one worker.
            conn.pragma_update(None, "journal_mode", "DELETE")?;
            conn.pragma_update(None, "synchronous", "FULL")?;
            migrations::run(&mut conn)?;
            if fresh && !is_proof {
                let tx = conn.transaction()?;
                migrations::seed(&tx)?;
                tx.commit()?;
            }
            if !is_proof {
                receipts::install(&conn)?;
                let after: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
                // Migration content rewrites predate this connection's TEMP
                // trigger. They must not retain a previous editor's receipt.
                if before != after {
                    conn.execute("DELETE FROM browser_write_receipts", [])?;
                }
            }
            Ok::<_, mindstream_storage_core::error::AppError>(conn)
        })();
        match opened {
            Ok(conn) => Ok(Self {
                conn: Some(conn),
                pool,
            }),
            Err(err) => {
                let _ = pool.pause_vfs();
                Err(error(err))
            }
        }
    }

    fn write_backup(&mut self) -> Result<JsValue, JsValue> {
        let conn = self.connection()?;
        let bytes: i64 = conn
            .query_row(
                "SELECT (page_count - freelist_count) * page_size
                 FROM pragma_page_count, pragma_freelist_count, pragma_page_size",
                [],
                |row| row.get(0),
            )
            .map_err(error)?;
        if bytes > MAX_BACKUP_BYTES {
            return Err(command_error(AppError::InvalidArg(
                "This vault is too large to back up in a browser. Use Export vault instead.".into(),
            )));
        }
        conn.execute(&format!("VACUUM INTO '{BACKUP_SNAPSHOT}'"), [])
            .map_err(error)?;

        let mut snapshot = Connection::open(BACKUP_SNAPSHOT).map_err(error)?;
        snapshot
            .execute("DROP TABLE IF EXISTS browser_write_receipts", [])
            .map_err(error)?;
        backup::leave_device_secrets_out(&snapshot).map_err(command_error)?;
        // A browser ships no plugins, so none of them count as built in here.
        backup::sanitize_snapshot(&mut snapshot, &BTreeSet::new(), &BTreeMap::new())
            .map_err(command_error)?;
        let mut manifest =
            backup::Manifest::for_snapshot(&snapshot, env!("CARGO_PKG_VERSION"), None, None, None)
                .map_err(command_error)?;
        snapshot.close().map_err(|(_, err)| error(err))?;

        let database = self.pool.export_db(BACKUP_SNAPSHOT).map_err(error)?;
        manifest.data_db_sha256 = Some(asset_hash::content_hash(&database));
        let report = BrowserBackup {
            manifest: serde_json::to_string_pretty(&manifest).map_err(error)?,
            filename: backup::suggested_filename(),
            counts: manifest.contents.counts,
            account_present: manifest.account_present_at_export,
        }
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(error)?;
        js_sys::Reflect::set(
            &report,
            &JsValue::from_str("database"),
            &js_sys::Uint8Array::from(database.as_slice()),
        )?;
        Ok(report)
    }

    fn connection(&mut self) -> Result<&mut Connection, JsValue> {
        self.conn
            .as_mut()
            .ok_or_else(|| error("Database is closed"))
    }
}

fn command_error(error: AppError) -> JsValue {
    let code = match &error {
        AppError::Db(_) => "database",
        AppError::Io(_) => "io",
        AppError::NotFound(_) => "notFound",
        AppError::InvalidArg(_) => "invalidArgument",
        AppError::Refused { .. } => "refused",
    };
    let mut payload = serde_json::json!({"code": code, "message": error.to_string()});
    if let AppError::Refused { reason, .. } = error {
        payload["reason"] = reason.into();
    }
    payload
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .unwrap_or_else(|_| JsValue::from_str("Cannot encode storage error"))
}
