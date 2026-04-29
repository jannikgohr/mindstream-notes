//! App-wide error type. Tauri commands return `Result<T, String>` because
//! the IPC boundary serialises errors as strings; we keep a richer enum
//! in-process and `Display` it at the boundary.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("invalid argument: {0}")]
    InvalidArg(String),

    #[error("tauri error: {0}")]
    Tauri(#[from] tauri::Error),
}

impl From<AppError> for String {
    fn from(e: AppError) -> Self {
        e.to_string()
    }
}

pub type AppResult<T> = std::result::Result<T, AppError>;
