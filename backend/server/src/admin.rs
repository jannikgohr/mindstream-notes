//! Account administration from the command line.
//!
//! The server holds no plaintext and no passwords, so there is little an
//! administrator can do to an account beyond seeing that it exists, how much
//! it stores, and switching it off.

use crate::auth::username_key;
use crate::events::{self, Event};
use crate::AppState;

#[derive(Debug, sqlx::FromRow)]
pub struct AccountSummary {
    pub username: String,
    pub email: String,
    pub disabled: bool,
    pub sessions: i64,
    /// Ciphertext bytes in the collections this account owns.
    pub bytes_used: i64,
}

pub async fn list_accounts(state: &AppState) -> Result<Vec<AccountSummary>, sqlx::Error> {
    sqlx::query_as(
        "SELECT a.username, a.email, a.disabled,
                (SELECT count(*) FROM sessions s WHERE s.account_id = a.id) AS sessions,
                COALESCE((SELECT sum(c.bytes_used) FROM collections c WHERE c.owner_id = a.id), 0)::bigint
                    AS bytes_used
         FROM accounts a ORDER BY a.username_key",
    )
    .fetch_all(&state.pool)
    .await
}

/// Switch an account off or back on. Returns whether it exists.
///
/// Switching it off also ends its sessions, so the change takes effect on
/// the next request, not at the next login.
pub async fn set_disabled(
    state: &AppState,
    username: &str,
    disabled: bool,
) -> Result<bool, sqlx::Error> {
    let mut tx = state.pool.begin().await?;
    let id: Option<i64> = sqlx::query_scalar(
        "UPDATE accounts SET disabled = $2 WHERE username_key = $1 RETURNING id",
    )
    .bind(username_key(username))
    .bind(disabled)
    .fetch_optional(&mut *tx)
    .await?;
    if let (Some(id), true) = (id, disabled) {
        sqlx::query("DELETE FROM sessions WHERE account_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        // The server process hears this and closes the account's sockets.
        events::publish(&mut tx, &Event::AccountClosed { account: id }).await?;
    }
    tx.commit().await?;
    Ok(id.is_some())
}

/// Delete an account, its sessions and memberships, and every collection it
/// owns. Returns whether it existed.
///
/// The blobs of the deleted collections stay on disk until they are swept.
pub async fn delete_account(state: &AppState, username: &str) -> Result<bool, sqlx::Error> {
    let mut tx = state.pool.begin().await?;
    let id: Option<i64> = sqlx::query_scalar("SELECT id FROM accounts WHERE username_key = $1")
        .bind(username_key(username))
        .fetch_optional(&mut *tx)
        .await?;
    let Some(id) = id else {
        return Ok(false);
    };
    events::publish_account_closing(&mut tx, id).await?;
    sqlx::query("DELETE FROM accounts WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(true)
}
