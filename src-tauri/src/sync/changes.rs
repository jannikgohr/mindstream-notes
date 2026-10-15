//! What changed on the server since the last sync, asked in one request.
//!
//! The collection list takes a cursor. It answers with the collections that
//! changed after it and the ones the account lost access to. A collection
//! counts as changed when an item in it did, or who may do what in it. So
//! one request says which spaces a sync has to visit, and a sync that finds
//! none, and has nothing of its own to send, is done.
//!
//! The cursor moves only once everything the answer named has been applied,
//! see [`super::run`]. It is dropped whenever the database is opened, so
//! the first sync of every run asks without one. That sync visits every
//! space and removes the shared folders the full list no longer has, which
//! bounds what a missed change could cost to one restart.

use super::*;
use crate::sharing::COLLECTION_TYPE_SHARED;

/// Where the account's cursor is kept in `sync_state`.
pub(super) const KIND_ACCOUNT: &str = "account";

/// How many collections to ask for at a time.
const PAGE: usize = 100;

/// The answer to "what changed since the cursor".
pub(super) struct Changes {
    /// The question went without a cursor, so `vault` and `shared` are every
    /// collection the account has, changed or not.
    pub(super) full: bool,
    pub(super) vault: Vec<Collection>,
    pub(super) shared: Vec<Collection>,
    /// The collections the account stopped being a member of. The server
    /// only says so against a cursor, so this is empty when `full`.
    pub(super) removed: Vec<String>,
    /// The cursor to keep once all of the above has been applied.
    pub(super) stoken: Option<String>,
}

/// Ask the server what changed since the last sync that applied everything.
///
/// This is the first request of a sync. If it does not reach the server the
/// sync has done nothing yet, and the caller is told so apart from every
/// other failure.
pub(super) fn account_changes(db: &Db, cm: &CollectionManager) -> Result<Changes, RunError> {
    let since = load_stoken(db, KIND_ACCOUNT)?;
    match list_changes(cm, since.as_deref()) {
        // A cursor the server does not know: the account moved to another
        // server, or this one was set up again. Ask for everything.
        Err(RunError::Failed(err)) if since.is_some() && is_bad_stoken_error(&err) => {
            log::warn!(
                "[sync] the server does not know the account's cursor, starting over ({err})"
            );
            save_stoken(db, KIND_ACCOUNT, None)?;
            list_changes(cm, None)
        }
        other => other,
    }
}

fn list_changes(cm: &CollectionManager, since: Option<&str>) -> Result<Changes, RunError> {
    let mut changes = Changes {
        full: since.is_none(),
        vault: Vec::new(),
        shared: Vec::new(),
        removed: Vec::new(),
        stoken: None,
    };
    let mut cursor = since.map(str::to_string);
    loop {
        let (done, next) = {
            let options = FetchOptions::new().limit(PAGE).stoken(cursor.as_deref());
            let page = cm
                .list_multi(
                    [COLLECTION_TYPE_VAULT, COLLECTION_TYPE_SHARED],
                    Some(&options),
                )
                .map_err(|e| match e {
                    EtebaseError::Connection(detail) => RunError::Unreachable(detail),
                    e => RunError::Failed(AppError::InvalidArg(format!("list collections: {e}"))),
                })?;
            for collection in page.data() {
                match collection.collection_type().as_deref() {
                    Ok(COLLECTION_TYPE_VAULT) => changes.vault.push(collection.clone()),
                    Ok(COLLECTION_TYPE_SHARED) => changes.shared.push(collection.clone()),
                    // Asked for by type, so this is a server that answers
                    // with more than it was asked for. Not ours to sync.
                    Ok(other) => log::debug!("[sync] skipping a collection of type {other}"),
                    Err(e) => log::warn!(
                        "[sync] cannot read the type of collection {}: {e}",
                        collection.uid()
                    ),
                }
            }
            if let Some(removed) = page.removed_memberships() {
                changes
                    .removed
                    .extend(removed.iter().map(|gone| gone.uid().to_string()));
            }
            (page.done(), page.stoken().map(str::to_string))
        };
        match (done, next) {
            (true, next) => {
                // Nothing changed and nothing to move the cursor to: it
                // stays where it was.
                changes.stoken = next.or(cursor);
                return Ok(changes);
            }
            (false, Some(next)) => cursor = Some(next),
            // Not done and nowhere to go on from. Whoever acts on a partial
            // answer would take what is missing from it for unchanged.
            (false, None) => {
                return Err(RunError::Failed(AppError::InvalidArg(
                    "list collections: the server ended the list without finishing it".into(),
                )))
            }
        }
    }
}

/// Whether any space still waits for a row to be let go, see
/// [`super::settle_held`]. Its cursor did not move, so the account's must
/// not either, or the next sync would not come back to it.
pub(super) fn holds_remain(db: &Db) -> AppResult<bool> {
    db.with_conn(|c| {
        Ok(c.query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_state WHERE kind LIKE 'held:%')",
            [],
            |r| r.get(0),
        )?)
    })
}

/// Drop the account's cursor, so the next sync asks about everything.
pub(crate) fn forget_account_cursor(conn: &Connection) -> AppResult<()> {
    conn.execute(
        "DELETE FROM sync_state WHERE kind = ?1",
        params![KIND_ACCOUNT],
    )?;
    Ok(())
}

/// Which spaces a sync visits, worked out from what the server said changed
/// and what this device has waiting to be sent.
///
/// A space is visited when the server changed it or the device has work for
/// it. Everything else is left alone, which is what makes an idle sync one
/// request.
pub(super) fn scopes_to_fetch(changed: &[&str], with_local_work: &[String]) -> Vec<String> {
    with_local_work
        .iter()
        .filter(|scope| !changed.contains(&scope.as_str()))
        .cloned()
        .collect()
}

/// Whether the vault is visited this sync.
///
/// `settled` is false until the device has a vault collection it trusts,
/// see `ensure_collection`. Until then every sync looks.
pub(super) fn visits_vault(full: bool, settled: bool, changed: bool, local_work: bool) -> bool {
    full || !settled || changed || local_work
}
