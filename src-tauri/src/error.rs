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

    /// The sync server took nothing because a limit of the plan that pays
    /// for the space was reached. `reason` is the server's word for which
    /// limit, and reaches the UI as it is.
    #[error("{message}")]
    OverLimit { reason: String, message: String },
}

impl AppError {
    /// A call to the sync server that failed. `doing` names the attempt.
    ///
    /// A write that went over a limit keeps the server's word for the
    /// limit, because the app says something different for each. Any other
    /// failure is prose for the log.
    pub fn from_server(doing: impl fmt::Display, err: etebase::error::Error) -> Self {
        match etebase::refusal::limit(&err) {
            Some(reason) => Self::OverLimit {
                reason: reason.to_string(),
                message: format!("{doing}: {err}"),
            },
            None => Self::InvalidArg(format!("{doing}: {err}")),
        }
    }

    /// The limit that was reached, when that is what this error is.
    pub fn limit(&self) -> Option<&str> {
        match self {
            Self::OverLimit { reason, .. } => Some(reason),
            _ => None,
        }
    }
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
    /// The sync server said no, or could not be asked. `reason` says which.
    Refused,
    Unknown,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: CommandErrorCode,
    pub message: String,
    /// One of a fixed set of words the UI can act on and translate, where
    /// `message` is English prose for the log. Only [`Self::refused`] sets
    /// it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl CommandError {
    pub fn new(code: CommandErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            reason: None,
        }
    }

    pub fn refused(reason: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: CommandErrorCode::Refused,
            message: message.into(),
            reason: Some(reason.into()),
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
            AppError::OverLimit { reason, message } => {
                return Self::refused(reason.clone(), message.clone());
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use etebase::error::Error as ServerError;

    fn over(code: &str) -> ServerError {
        ServerError::Refused {
            status: 402,
            code: code.to_string(),
            detail: "The storage of ada is full.".to_string(),
        }
    }

    #[test]
    fn a_write_over_a_limit_keeps_the_servers_word_up_to_the_ui() {
        let err = AppError::from_server("push notes", over("storage_full"));
        assert_eq!(err.limit(), Some("storage_full"));
        assert_eq!(err.to_string(), "push notes: The storage of ada is full.");

        let command = CommandError::from(err);
        assert_eq!(command.code, CommandErrorCode::Refused);
        assert_eq!(command.reason.as_deref(), Some("storage_full"));
        assert_eq!(command.message, "push notes: The storage of ada is full.");
    }

    #[test]
    fn any_other_server_failure_is_prose() {
        let err = AppError::from_server("push notes", ServerError::Conflict("stale".into()));
        assert_eq!(err.limit(), None);
        assert!(matches!(err, AppError::InvalidArg(_)));

        // A refusal that is not for a limit is not passed off as one.
        let refused = ServerError::Refused {
            status: 403,
            code: "storage_full".to_string(),
            detail: "no".to_string(),
        };
        assert_eq!(AppError::from_server("push notes", refused).limit(), None);

        let command = CommandError::from(AppError::NotFound("x".into()));
        assert_eq!(command.reason, None);
    }
}
