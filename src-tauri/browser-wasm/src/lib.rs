//! Dedicated-worker binding for the SQLite compatibility proof.
#![cfg(target_arch = "wasm32")]

mod receipts;

use mindstream_storage_core::error::AppError;
use mindstream_storage_core::{migrations, proof, vault_api};
use rusqlite::Connection;
use serde::Serialize;
use sqlite_wasm_vfs::sahpool::{install, OpfsSAHPoolCfg, OpfsSAHPoolUtil};
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
