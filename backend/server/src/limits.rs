//! What an account's plan allows.
//!
//! A collection's limits are those of its owner, who pays for what is stored
//! in it whoever wrote it. An account without an entitlements row has no
//! limits, which is every account on a server nobody has set limits on.
//!
//! The server can only limit what it can count: bytes, collections, members
//! and the size of one item. It cannot tell a note from an attachment.
//!
//! Limits are soft at the edges. Two writes arriving together can both pass a
//! check that only one of them should have, and the account ends up a little
//! over. Nothing is ever deleted to bring it back under.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use sqlx::PgConnection;

use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult};
use crate::AppState;

/// Refusals for being over a limit share one status, which no other refusal
/// has. The client library keeps the code of an answer with that status,
/// on its Etebase calls too, and the app has a sentence for each.
fn refuse(code: &'static str, detail: String) -> ApiError {
    ApiError::new(StatusCode::PAYMENT_REQUIRED, code, detail)
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase", default)]
pub struct Entitlements {
    pub plan: String,
    /// Ciphertext bytes across every collection the account owns.
    pub storage_limit_bytes: Option<i64>,
    /// Collections the account may own.
    pub max_spaces: Option<i32>,
    /// Members one of its collections may have, the owner included.
    pub max_members_per_space: Option<i32>,
    /// Content of a single item.
    pub max_item_bytes: Option<i64>,
    /// A lapsed plan: nothing new is accepted, nothing is removed.
    pub read_only: bool,
}

const COLUMNS: &str =
    "plan, storage_limit_bytes, max_spaces, max_members_per_space, max_item_bytes, read_only";

/// The collections an account owns, less the deleted ones. A deleted
/// collection holds nothing and can never be written to again.
const SPACES: &str = "SELECT count(*) FROM collections c
     WHERE c.owner_id = $1 AND NOT EXISTS (
         SELECT 1 FROM items i JOIN revisions r ON r.item_id = i.id AND r.uid = i.revision_uid
         WHERE i.collection_id = c.id AND i.is_main AND r.deleted
     )";

pub async fn entitlements(
    conn: &mut PgConnection,
    account_id: i64,
) -> Result<Option<Entitlements>, sqlx::Error> {
    sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM entitlements WHERE account_id = $1"
    ))
    .bind(account_id)
    .fetch_optional(conn)
    .await
}

pub async fn storage_used(conn: &mut PgConnection, account_id: i64) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT COALESCE(sum(bytes_used), 0)::bigint FROM collections WHERE owner_id = $1",
    )
    .bind(account_id)
    .fetch_one(conn)
    .await
}

/// What a write into one collection has to respect.
#[derive(Debug)]
pub struct WriteLimits {
    owner: String,
    read_only: bool,
    storage_left: Option<i64>,
    max_item_bytes: Option<i64>,
}

/// The limits on writing into a collection owned by `owner_id`, or `None`
/// when there are none to check.
pub async fn for_writes(conn: &mut PgConnection, owner_id: i64) -> ApiResult<Option<WriteLimits>> {
    let Some(plan) = entitlements(conn, owner_id).await? else {
        return Ok(None);
    };
    let storage_left = match plan.storage_limit_bytes {
        Some(limit) => Some(limit - storage_used(conn, owner_id).await?),
        None => None,
    };
    let owner: String = sqlx::query_scalar("SELECT username FROM accounts WHERE id = $1")
        .bind(owner_id)
        .fetch_one(conn)
        .await?;
    Ok(Some(WriteLimits {
        owner,
        read_only: plan.read_only,
        storage_left,
        max_item_bytes: plan.max_item_bytes,
    }))
}

impl WriteLimits {
    /// Decide whether a write may go ahead. `new_bytes` is what it would add
    /// to storage and `largest_item` the content size of its biggest item.
    ///
    /// Deletions are always let through. They are how a full account gets
    /// back under its limit, and how a lapsed one is tidied before leaving.
    pub fn check(&self, new_bytes: i64, largest_item: i64, deletions_only: bool) -> ApiResult<()> {
        if deletions_only {
            return Ok(());
        }
        if self.read_only {
            return Err(refuse(
                "plan_lapsed",
                format!(
                    "The plan of {} has lapsed, so nothing new can be stored here.",
                    self.owner
                ),
            ));
        }
        if self.max_item_bytes.is_some_and(|max| largest_item > max) {
            return Err(refuse(
                "item_too_large",
                format!("This is larger than the plan of {} allows.", self.owner),
            ));
        }
        if self.storage_left.is_some_and(|left| new_bytes > left) {
            return Err(refuse(
                "storage_full",
                format!("The storage of {} is full.", self.owner),
            ));
        }
        Ok(())
    }
}

/// Refuse when the account already owns as many collections as it may.
pub async fn check_new_space(conn: &mut PgConnection, account_id: i64) -> ApiResult<()> {
    let Some(max) = entitlements(conn, account_id)
        .await?
        .and_then(|plan| plan.max_spaces)
    else {
        return Ok(());
    };
    let owned: i64 = sqlx::query_scalar(SPACES)
        .bind(account_id)
        .fetch_one(conn)
        .await?;
    if owned >= i64::from(max) {
        return Err(refuse(
            "space_limit",
            format!("This plan allows {max} collections and they are all in use."),
        ));
    }
    Ok(())
}

/// Refuse when the collection already has as many members as its owner's
/// plan allows. `pending` also counts invitations not yet answered, for
/// refusing an invitation that could never be accepted.
pub async fn check_new_member(
    conn: &mut PgConnection,
    collection_id: i64,
    owner_id: i64,
    pending: bool,
) -> ApiResult<()> {
    let Some(max) = entitlements(conn, owner_id)
        .await?
        .and_then(|plan| plan.max_members_per_space)
    else {
        return Ok(());
    };
    let mut count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM members WHERE collection_id = $1")
            .bind(collection_id)
            .fetch_one(&mut *conn)
            .await?;
    if pending {
        count += sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM invitations WHERE collection_id = $1",
        )
        .bind(collection_id)
        .fetch_one(&mut *conn)
        .await?;
    }
    if count >= i64::from(max) {
        return Err(refuse(
            "member_limit",
            format!("The owner's plan allows {max} members here and they are all taken."),
        ));
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(flatten)]
    pub entitlements: Entitlements,
    /// False when the account has no limits at all.
    pub limited: bool,
    pub storage_used_bytes: i64,
    pub spaces: i64,
}

pub async fn usage_of(conn: &mut PgConnection, account_id: i64) -> Result<Usage, sqlx::Error> {
    let plan = entitlements(conn, account_id).await?;
    let spaces: i64 = sqlx::query_scalar(SPACES)
        .bind(account_id)
        .fetch_one(&mut *conn)
        .await?;
    Ok(Usage {
        limited: plan.is_some(),
        entitlements: plan.unwrap_or_default(),
        storage_used_bytes: storage_used(conn, account_id).await?,
        spaces,
    })
}

/// What the signed-in account uses and may use, for its settings page.
pub async fn usage(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Usage>> {
    let mut conn = state.pool.acquire().await?;
    Ok(Json(usage_of(&mut conn, user.account_id).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits(read_only: bool, storage_left: Option<i64>, max_item: Option<i64>) -> WriteLimits {
        WriteLimits {
            owner: "owner".into(),
            read_only,
            storage_left,
            max_item_bytes: max_item,
        }
    }

    fn code(result: ApiResult<()>) -> Option<&'static str> {
        result.err().map(|err| err.code)
    }

    #[test]
    fn write_is_refused_for_the_first_limit_it_breaks() {
        assert_eq!(
            code(limits(false, None, None).check(1 << 40, 1 << 40, false)),
            None
        );
        assert_eq!(
            code(limits(true, None, None).check(1, 1, false)),
            Some("plan_lapsed")
        );
        assert_eq!(
            code(limits(false, Some(100), None).check(101, 5, false)),
            Some("storage_full")
        );
        assert_eq!(
            code(limits(false, Some(100), None).check(100, 5, false)),
            None
        );
        assert_eq!(
            code(limits(false, Some(1000), Some(10)).check(11, 11, false)),
            Some("item_too_large")
        );
        // Already over, by a limit lowered after the fact.
        assert_eq!(
            code(limits(false, Some(-50), None).check(1, 1, false)),
            Some("storage_full")
        );
    }

    #[test]
    fn deletions_always_go_through() {
        assert_eq!(
            code(limits(true, Some(-50), Some(0)).check(40, 0, true)),
            None
        );
    }
}
