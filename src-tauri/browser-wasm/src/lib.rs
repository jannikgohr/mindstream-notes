//! Dedicated-worker binding for the SQLite compatibility proof.
#![cfg(target_arch = "wasm32")]

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
        Self::open_database(true).await
    }

    pub async fn open_vault() -> Result<BrowserDatabase, JsValue> {
        Self::open_database(false).await
    }

    pub fn invoke(&mut self, request: JsValue) -> Result<JsValue, JsValue> {
        let request = serde_wasm_bindgen::from_value::<vault_api::VaultRequest>(request)
            .map_err(|e| command_error(AppError::InvalidArg(e.to_string())))?;
        let response = vault_api::dispatch(self.connection()?, request).map_err(command_error)?;
        response
            .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
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
    async fn open_database(is_proof: bool) -> Result<BrowserDatabase, JsValue> {
        let cfg = OpfsSAHPoolCfg {
            directory: if is_proof {
                ".mindstream-sqlite-proof"
            } else {
                ".mindstream-browser-vault"
            }
            .into(),
            vfs_name: if is_proof {
                "mindstream-proof"
            } else {
                "mindstream-vault"
            }
            .into(),
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
            let fresh: bool = conn.query_row(
                "SELECT user_version = 0 FROM pragma_user_version",
                [],
                |r| r.get(0),
            )?;
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
