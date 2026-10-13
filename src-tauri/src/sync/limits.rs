//! What the user is told when the server takes nothing new for a space.
//!
//! A sync server can give an account limits: how much it stores, how large
//! one item may be, or that its plan has lapsed and nothing new is stored at
//! all. A collection counts against its owner, whoever writes into it, so
//! the limit a push runs into in a shared folder is the owner's and not the
//! writer's.
//!
//! The server refuses the push and says which limit it was. That is not a
//! sync that failed: everything was pulled, the other spaces were pushed,
//! and the rows that could not go up stay dirty and go with the first sync
//! that has room. What is left to do is to say so, and whose limit it is,
//! because the person typing may not be the one who can do something about
//! it.

use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use crate::db::Db;

/// A space the server took nothing new for, and the limit that stopped it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LimitReached {
    /// The server's word for the limit: `storage_full`, `item_too_large` or
    /// `plan_lapsed`. The UI has a sentence for each and one for any other.
    pub reason: String,
    /// The shared folder's root. `None` for the vault.
    pub folder_id: Option<String>,
    /// The shared folder's name as this device has it.
    pub folder_name: Option<String>,
    /// Whose plan the limit belongs to, when it is someone else's. `None`
    /// when it is this account's: the vault, or a folder it shared.
    pub owner: Option<String>,
}

impl LimitReached {
    /// The vault, which is always this account's own.
    pub(super) fn in_vault(reason: &str) -> Self {
        Self {
            reason: reason.to_string(),
            folder_id: None,
            folder_name: None,
            owner: None,
        }
    }

    /// A shared folder, named and attributed from its local root. A root
    /// that cannot be read still gives a notice, without the name.
    pub(super) fn in_folder(db: &Db, root_folder_id: &str, reason: &str) -> Self {
        let (folder_name, owner) = match folder_and_owner(db, root_folder_id) {
            Ok(found) => found,
            Err(err) => {
                log::warn!("[sync] could not read shared folder {root_folder_id}: {err}");
                (None, None)
            }
        };
        Self {
            reason: reason.to_string(),
            folder_id: Some(root_folder_id.to_string()),
            folder_name,
            owner,
        }
    }
}

/// The folder's name, and its owner when that is not this account.
fn folder_and_owner(
    db: &Db,
    root_folder_id: &str,
) -> crate::error::AppResult<(Option<String>, Option<String>)> {
    db.with_conn(|conn| {
        let row = conn
            .query_row(
                "SELECT name, shared_owner, COALESCE(shared_by_me, 0)
                   FROM collections WHERE id = ?1",
                params![root_folder_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, bool>(2)?,
                    ))
                },
            )
            .optional()?;
        Ok(match row {
            Some((name, owner, by_me)) => (Some(name), owner.filter(|_| !by_me)),
            None => (None, None),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory_for_tests;

    fn folder(db: &Db, id: &str, name: &str, owner: Option<&str>, by_me: bool) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO collections(id, parent_collection_id, name, position,
                                         created, modified, dirty, share_scope_id,
                                         shared_owner, shared_by_me)
                 VALUES (?1, NULL, ?2, 0, 't', 't', 0, 'scope_1', ?3, ?4)",
                params![id, name, owner, by_me],
            )?;
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn the_vault_is_this_accounts_own() {
        assert_eq!(
            LimitReached::in_vault("storage_full"),
            LimitReached {
                reason: "storage_full".into(),
                folder_id: None,
                folder_name: None,
                owner: None,
            }
        );
    }

    #[test]
    fn a_folder_someone_else_shared_names_them() {
        let db = open_memory_for_tests();
        folder(&db, "root", "Trip plans", Some("ada"), false);
        assert_eq!(
            LimitReached::in_folder(&db, "root", "storage_full"),
            LimitReached {
                reason: "storage_full".into(),
                folder_id: Some("root".into()),
                folder_name: Some("Trip plans".into()),
                owner: Some("ada".into()),
            }
        );
    }

    #[test]
    fn a_folder_this_account_shared_is_its_own_too() {
        let db = open_memory_for_tests();
        // The owner's devices carry their own name as the owner.
        folder(&db, "root", "Trip plans", Some("me"), true);
        let limit = LimitReached::in_folder(&db, "root", "plan_lapsed");
        assert_eq!(limit.folder_name.as_deref(), Some("Trip plans"));
        assert_eq!(limit.owner, None);
    }

    #[test]
    fn a_folder_that_is_gone_still_gives_a_notice() {
        let db = open_memory_for_tests();
        let limit = LimitReached::in_folder(&db, "missing", "item_too_large");
        assert_eq!(limit.reason, "item_too_large");
        assert_eq!(limit.folder_id.as_deref(), Some("missing"));
        assert_eq!(limit.folder_name, None);
        assert_eq!(limit.owner, None);
    }

    #[test]
    fn the_window_gets_the_fields_under_these_names() {
        let json = serde_json::to_value(LimitReached::in_vault("storage_full")).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "reason": "storage_full",
                "folder_id": null,
                "folder_name": null,
                "owner": null,
            })
        );
    }
}
