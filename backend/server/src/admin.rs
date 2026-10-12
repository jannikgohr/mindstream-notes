//! Account administration from the command line.
//!
//! The server holds no plaintext and no passwords, so there is little an
//! administrator can do to an account beyond seeing that it exists, how much
//! it stores, and switching it off.

use crate::auth::username_key;
use crate::events::{self, Event};
use crate::limits::{self, Entitlements, Usage};
use crate::links;
use crate::security;
use crate::AppState;

#[derive(Debug, sqlx::FromRow)]
pub struct AccountSummary {
    pub username: String,
    pub email: String,
    pub disabled: bool,
    /// Whether signing in takes a code from an authenticator.
    pub second_factor: bool,
    pub sessions: i64,
    /// Ciphertext bytes in the collections this account owns.
    pub bytes_used: i64,
}

pub async fn list_accounts(state: &AppState) -> Result<Vec<AccountSummary>, sqlx::Error> {
    sqlx::query_as(
        "SELECT a.username, a.email, a.disabled,
                EXISTS (SELECT 1 FROM second_factors f
                        WHERE f.account_id = a.id AND f.confirmed_at IS NOT NULL) AS second_factor,
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
/// owns, blobs included. Returns whether it existed.
pub async fn delete_account(state: &AppState, username: &str) -> Result<bool, sqlx::Error> {
    let mut tx = state.pool.begin().await?;
    let id: Option<i64> = sqlx::query_scalar("SELECT id FROM accounts WHERE username_key = $1")
        .bind(username_key(username))
        .fetch_optional(&mut *tx)
        .await?;
    let Some(id) = id else {
        return Ok(false);
    };
    remove_account(state, &mut tx, id).await?.commit(tx).await?;
    Ok(true)
}

/// The blobs an account's deletion leaves without rows. Their removal waits
/// for the commit, so a deletion that fails takes no attachment with it.
pub(crate) struct OrphanedBlobs<'a> {
    state: &'a AppState,
    collections: Vec<String>,
}

impl OrphanedBlobs<'_> {
    pub(crate) async fn commit(
        self,
        tx: sqlx::Transaction<'_, sqlx::Postgres>,
    ) -> Result<(), sqlx::Error> {
        tx.commit().await?;
        for uid in &self.collections {
            // Left behind, a blob costs disk space and nothing else.
            if let Err(err) = self.state.blobs.remove_collection(uid).await {
                tracing::warn!("could not remove the blobs of collection {uid}: {err}");
            }
        }
        Ok(())
    }
}

/// Delete an account's rows inside the caller's transaction, telling the
/// open sockets first. Commit through what this returns.
pub(crate) async fn remove_account<'a>(
    state: &'a AppState,
    conn: &mut sqlx::PgConnection,
    account_id: i64,
) -> Result<OrphanedBlobs<'a>, sqlx::Error> {
    let collections: Vec<String> =
        sqlx::query_scalar("SELECT uid FROM collections WHERE owner_id = $1")
            .bind(account_id)
            .fetch_all(&mut *conn)
            .await?;
    events::publish_account_closing(conn, account_id).await?;
    sqlx::query("DELETE FROM accounts WHERE id = $1")
        .bind(account_id)
        .execute(conn)
        .await?;
    Ok(OrphanedBlobs { state, collections })
}

/// Take the second factor off an account whose owner has lost the
/// authenticator and the backup codes. Returns whether the account exists.
///
/// The password still stands between anyone and the account. Whoever asks
/// for this should be shown to be the owner by some other means first.
pub async fn reset_second_factor(state: &AppState, username: &str) -> Result<bool, sqlx::Error> {
    let Some(id) = account_id(state, username).await? else {
        return Ok(false);
    };
    let mut tx = state.pool.begin().await?;
    security::remove_second_factor(&mut tx, id).await?;
    tx.commit().await?;
    Ok(true)
}

async fn account_id(state: &AppState, username: &str) -> Result<Option<i64>, sqlx::Error> {
    sqlx::query_scalar("SELECT id FROM accounts WHERE username_key = $1")
        .bind(username_key(username))
        .fetch_optional(&state.pool)
        .await
}

/// What an account uses and may use, or `None` when there is no such account.
pub async fn usage(state: &AppState, username: &str) -> Result<Option<Usage>, sqlx::Error> {
    let Some(id) = account_id(state, username).await? else {
        return Ok(None);
    };
    let mut conn = state.pool.acquire().await?;
    Ok(Some(limits::usage_of(&mut conn, id).await?))
}

/// Set what an account is entitled to, or lift every limit with `None`.
/// Returns whether the account exists.
///
/// Lowering a limit below what the account already uses removes nothing. It
/// stops the account from adding more until it is back under.
pub async fn set_entitlements(
    state: &AppState,
    username: &str,
    entitlements: Option<&Entitlements>,
) -> Result<bool, sqlx::Error> {
    let Some(id) = account_id(state, username).await? else {
        return Ok(false);
    };
    match entitlements {
        None => {
            sqlx::query("DELETE FROM entitlements WHERE account_id = $1")
                .bind(id)
                .execute(&state.pool)
                .await?;
        }
        Some(plan) => {
            sqlx::query(
                "INSERT INTO entitlements
                     (account_id, plan, storage_limit_bytes, max_spaces, max_members_per_space,
                      max_item_bytes, read_only, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, now())
                 ON CONFLICT (account_id) DO UPDATE SET
                     plan = EXCLUDED.plan,
                     storage_limit_bytes = EXCLUDED.storage_limit_bytes,
                     max_spaces = EXCLUDED.max_spaces,
                     max_members_per_space = EXCLUDED.max_members_per_space,
                     max_item_bytes = EXCLUDED.max_item_bytes,
                     read_only = EXCLUDED.read_only,
                     updated_at = now()",
            )
            .bind(id)
            .bind(&plan.plan)
            .bind(plan.storage_limit_bytes)
            .bind(plan.max_spaces)
            .bind(plan.max_members_per_space)
            .bind(plan.max_item_bytes)
            .bind(plan.read_only)
            .execute(&state.pool)
            .await?;
        }
    }
    Ok(true)
}

#[derive(Debug, sqlx::FromRow)]
pub struct SignupCodeSummary {
    pub id: i64,
    pub note: String,
    /// The day it stops working, as YYYY-MM-DD.
    pub expires: String,
    pub expired: bool,
    pub used: bool,
    /// Who signed up with it, if that account still exists.
    pub used_by: Option<String>,
}

/// Make a code that lets one person sign up where signup is not open. The
/// code is returned this once; the server keeps only a hash of it.
pub async fn create_signup_code(
    state: &AppState,
    note: &str,
    days: i32,
) -> Result<String, sqlx::Error> {
    let code = links::new_signup_code();
    let mut conn = state.pool.acquire().await?;
    links::store_signup_code(&mut conn, &code, note, days).await?;
    Ok(code)
}

pub async fn list_signup_codes(state: &AppState) -> Result<Vec<SignupCodeSummary>, sqlx::Error> {
    sqlx::query_as(
        "SELECT s.id, s.note, to_char(s.expires_at, 'YYYY-MM-DD') AS expires,
                s.expires_at <= now() AS expired, s.used_at IS NOT NULL AS used,
                a.username AS used_by
         FROM signup_codes s LEFT JOIN accounts a ON a.id = s.used_by
         ORDER BY s.id",
    )
    .fetch_all(&state.pool)
    .await
}

/// Withdraw a code nobody has used. Returns whether there was one.
pub async fn revoke_signup_code(state: &AppState, id: i64) -> Result<bool, sqlx::Error> {
    let removed = sqlx::query("DELETE FROM signup_codes WHERE id = $1 AND used_at IS NULL")
        .bind(id)
        .execute(&state.pool)
        .await?
        .rows_affected();
    Ok(removed == 1)
}
