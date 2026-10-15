//! The one error type every handler returns.
//!
//! The client decides what an error means from its status first and its
//! `code` second, and the app matches on a few of the codes by name
//! (`bad_stoken`, for one), so the codes below are part of the wire format.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

use crate::wire::msgpack_response;

#[derive(Debug, Serialize)]
pub struct FieldError {
    pub field: String,
    pub code: &'static str,
    pub detail: String,
}

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub detail: String,
    pub errors: Option<Vec<FieldError>>,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            status,
            code,
            detail: detail.into(),
            errors: None,
        }
    }

    pub fn bad_request(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", detail)
    }

    pub fn unauthorized(code: &'static str, detail: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, code, detail)
    }

    pub fn forbidden(code: &'static str, detail: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, code, detail)
    }

    /// Also what a non-member gets, so a collection's existence is not
    /// revealed to people outside it.
    pub fn not_found(what: &str) -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            "does_not_exist",
            format!("{what} matching query does not exist."),
        )
    }

    pub fn conflict(code: &'static str, detail: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, detail)
    }

    pub fn no_write_access() -> Self {
        Self::forbidden(
            "no_write_access",
            "You need write access to write to this collection",
        )
    }

    pub fn admin_required() -> Self {
        Self::forbidden(
            "admin_access_required",
            "Only collection admins can perform this operation.",
        )
    }

    pub fn owner_required() -> Self {
        Self::forbidden(
            "owner_required",
            "Only the collection's owner can delete it.",
        )
    }

    pub fn collection_deleted() -> Self {
        Self::forbidden(
            "collection_deleted",
            "The collection was deleted, and nothing more can be written to it.",
        )
    }

    /// A failure that is the server's fault. The cause goes to the log, never
    /// to the client.
    pub fn internal(cause: impl std::fmt::Display) -> Self {
        tracing::error!("internal error: {cause}");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "server_error",
            "Internal server error",
        )
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(err: sqlx::Error) -> Self {
        Self::internal(err)
    }
}

impl From<std::io::Error> for ApiError {
    fn from(err: std::io::Error) -> Self {
        Self::internal(err)
    }
}

#[derive(Serialize)]
struct Body<'a> {
    code: &'a str,
    detail: &'a str,
    errors: &'a Option<Vec<FieldError>>,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        msgpack_response(
            self.status,
            &Body {
                code: self.code,
                detail: &self.detail,
                errors: &self.errors,
            },
        )
    }
}
