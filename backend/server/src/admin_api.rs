//! The interface another program uses to set what accounts are entitled to.
//!
//! Billing lives outside this server: a separate program takes payments and
//! then tells the server here what each account's plan allows. This is the
//! whole of what it can do. It cannot read or change anything an account
//! stores.
//!
//! The routes exist only when an admin token is configured, and every
//! request has to carry it.

use axum::extract::{FromRequestParts, Path, State};
use axum::http::request::Parts;
use axum::http::{header, StatusCode};
use axum::Json;
use subtle::ConstantTimeEq;

use crate::admin;
use crate::error::{ApiError, ApiResult};
use crate::limits::{Entitlements, Usage};
use crate::AppState;

pub struct AdminToken;

impl FromRequestParts<AppState> for AdminToken {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> ApiResult<Self> {
        let refused = || ApiError::unauthorized("authentication_failed", "Invalid admin token.");
        let expected = state.config.admin_token().ok_or_else(refused)?;
        let given = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .ok_or_else(refused)?;
        if bool::from(given.as_bytes().ct_eq(expected.as_bytes())) {
            Ok(Self)
        } else {
            Err(refused())
        }
    }
}

fn no_such_account() -> ApiError {
    ApiError::not_found("Account")
}

pub async fn account(
    State(state): State<AppState>,
    _admin: AdminToken,
    Path(username): Path<String>,
) -> ApiResult<Json<Usage>> {
    admin::usage(&state, &username)
        .await?
        .map(Json)
        .ok_or_else(no_such_account)
}

pub async fn set_entitlements(
    State(state): State<AppState>,
    _admin: AdminToken,
    Path(username): Path<String>,
    Json(entitlements): Json<Entitlements>,
) -> ApiResult<StatusCode> {
    if admin::set_entitlements(&state, &username, Some(&entitlements)).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(no_such_account())
    }
}

/// Lift every limit from the account.
pub async fn clear_entitlements(
    State(state): State<AppState>,
    _admin: AdminToken,
    Path(username): Path<String>,
) -> ApiResult<StatusCode> {
    if admin::set_entitlements(&state, &username, None).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(no_such_account())
    }
}
