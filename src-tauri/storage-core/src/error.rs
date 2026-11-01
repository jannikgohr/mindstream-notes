use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{message}")]
    Refused {
        reason: &'static str,
        message: String,
    },
    #[error("not found: {0}")]
    NotFound(String),
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("invalid argument: {0}")]
    InvalidArg(String),
}

pub type AppResult<T> = Result<T, AppError>;
