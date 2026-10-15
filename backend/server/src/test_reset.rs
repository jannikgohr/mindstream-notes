//! Wipe an account and recreate it with known keys.
//!
//! The client library's integration tests start every case this way. The
//! route exists only when the server is started with `--test-reset`.

use axum::extract::State;
use axum::http::StatusCode;

use crate::admin;
use crate::auth::{insert_account, username_key, validate_signup};
use crate::error::ApiResult;
use crate::wire::{Msgpack, Signup};
use crate::AppState;

pub async fn reset(
    State(state): State<AppState>,
    Msgpack(body): Msgpack<Signup>,
) -> ApiResult<StatusCode> {
    validate_signup(&body)?;
    let mut tx = state.pool.begin().await?;
    // Cascades to the account's sessions, memberships, invitations and the
    // collections it owns.
    let existing: Option<i64> =
        sqlx::query_scalar("SELECT id FROM accounts WHERE username_key = $1")
            .bind(username_key(&body.user.username))
            .fetch_optional(&mut *tx)
            .await?;
    let orphaned = match existing {
        Some(id) => Some(admin::remove_account(&state, &mut tx, id).await?),
        None => None,
    };
    insert_account(&mut tx, &body).await?;
    match orphaned {
        Some(orphaned) => orphaned.commit(tx).await?,
        None => tx.commit().await?,
    }
    Ok(StatusCode::NO_CONTENT)
}
