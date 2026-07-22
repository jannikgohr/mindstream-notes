//! App-wide error types. Internal helpers use [`AppError`]; Tauri commands
//! return [`CommandError`] so the IPC boundary receives a structured payload
//! instead of a string rejection.

use serde::Serialize;
use std::fmt;
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

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CommandErrorCode {
    Database,
    Io,
    NotFound,
    InvalidArgument,
    Tauri,
    Task,
    Unknown,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: CommandErrorCode,
    pub message: String,
}

impl CommandError {
    pub fn new(code: CommandErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn task(message: impl Into<String>) -> Self {
        Self::new(CommandErrorCode::Task, message)
    }
}

impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for CommandError {}

impl From<AppError> for CommandError {
    fn from(error: AppError) -> Self {
        let code = match &error {
            AppError::Db(_) => CommandErrorCode::Database,
            AppError::Io(_) => CommandErrorCode::Io,
            AppError::NotFound(_) => CommandErrorCode::NotFound,
            AppError::InvalidArg(_) => CommandErrorCode::InvalidArgument,
            AppError::Tauri(_) => CommandErrorCode::Tauri,
        };
        Self::new(code, error.to_string())
    }
}

impl From<AppError> for String {
    fn from(error: AppError) -> Self {
        error.to_string()
    }
}

impl From<String> for CommandError {
    fn from(message: String) -> Self {
        Self::new(CommandErrorCode::Unknown, message)
    }
}

impl From<&str> for CommandError {
    fn from(message: &str) -> Self {
        Self::new(CommandErrorCode::Unknown, message)
    }
}

impl From<tauri::Error> for CommandError {
    fn from(error: tauri::Error) -> Self {
        Self::new(CommandErrorCode::Tauri, error.to_string())
    }
}

impl From<rusqlite::Error> for CommandError {
    fn from(error: rusqlite::Error) -> Self {
        Self::new(CommandErrorCode::Database, error.to_string())
    }
}

impl From<std::io::Error> for CommandError {
    fn from(error: std::io::Error) -> Self {
        Self::new(CommandErrorCode::Io, error.to_string())
    }
}

pub type AppResult<T> = std::result::Result<T, AppError>;
pub type CommandResult<T> = std::result::Result<T, CommandError>;
