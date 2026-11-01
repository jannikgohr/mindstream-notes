//! Dedicated-worker binding for the SQLite compatibility proof.
#![cfg(target_arch = "wasm32")]

use mindstream_storage_core::{migrations, proof};
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
        let cfg = OpfsSAHPoolCfg {
            directory: ".mindstream-sqlite-proof".into(),
            vfs_name: "mindstream-proof".into(),
            ..Default::default()
        };
        let pool = install::<sqlite_wasm_rs::WasmOsCallback>(&cfg, true)
            .await
            .map_err(error)?;
        let opened = (|| {
            let mut conn = Connection::open("proof.sqlite3")?;
            // SAH pools do not coordinate shared-memory WAL. Use durable
            // rollback journals, with all access serialized by one worker.
            conn.pragma_update(None, "journal_mode", "DELETE")?;
            conn.pragma_update(None, "synchronous", "FULL")?;
            migrations::run(&mut conn)?;
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
    fn connection(&mut self) -> Result<&mut Connection, JsValue> {
        self.conn
            .as_mut()
            .ok_or_else(|| error("Database is closed"))
    }
}
