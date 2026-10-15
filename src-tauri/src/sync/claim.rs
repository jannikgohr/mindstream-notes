//! Which space a local row belongs to, and when another may take it over.
//!
//! A pulled item says which local row it is by the id in its payload. Ids
//! travel with rows from space to space, which is what lets a note keep its
//! history and its open editors when its folder is shared. It also means
//! that whoever can write to one space can send an item that carries the id
//! of a row in another: a member of a shared folder, naming one of your own
//! notes. Applied by id alone, that item would overwrite the note and move
//! it into their folder.
//!
//! So an item may write a row that is in its own space, or one that is on
//! its way out of another. The second case is a row moving between spaces
//! as a second device sees it: the old home deletes the row's item, and the
//! new home has an item with the same id. The row may be claimed once the
//! old home has said it is gone, and not before.

use super::*;

/// Whether an item pulled from the space `scope` may write the row `id` of
/// `table`.
///
/// * There is no such row: yes, it is new here.
/// * The row is in that same space: yes. What two items of one space do
///   with one id is that space's business, as it always was.
/// * The row is in another space, has no item there any more and was let go
///   by that space (`released`, see [`apply_remote_delete`]): yes.
/// * Anything else: no. The row has an item in another space, or was put in
///   another space on this device and is waiting to be uploaded there.
///
/// `table` is always a crate-internal literal, never user input.
pub(super) fn may_claim(
    conn: &Connection,
    table: &str,
    id: &str,
    scope: Option<&str>,
) -> AppResult<bool> {
    let home: Option<(Option<String>, Option<String>, bool)> = conn
        .query_row(
            &format!("SELECT share_scope_id, etebase_uid, released FROM {table} WHERE id = ?1"),
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0)),
        )
        .optional()?;
    Ok(match home {
        None => true,
        Some((home_scope, _, _)) if home_scope.as_deref() == scope => true,
        Some((_, None, true)) => true,
        Some(_) => false,
    })
}

/// What became of a pulled item.
pub(super) enum Pulled<T> {
    /// It was applied, or there was nothing to apply.
    Done(T),
    /// The row it names has its home in another space. The pull keeps the
    /// item and tries again once every space has been pulled, by when a row
    /// that is moving will have been let go.
    Refused,
}

/// Apply a server-side deletion of the item `etebase_uid` of the space
/// `scope` to `table`.
///
/// Edit-wins-over-delete: a row with unpushed local edits (`dirty = 1`) is
/// never destroyed by a remote tombstone. Instead we *detach* it — drop the
/// server identity (`etebase_uid`/`etebase_etag`) but keep the row and its
/// dirty flag — so the next push re-homes it. This makes re-home
/// non-destructive: when a shared folder's items are tombstoned out of the
/// vault and recreated in a scope, a device holding offline edits detaches its
/// vault copy here, then the scope pull reclaims that same row by stable `id`
/// and CRDT-merges the edits in (see `apply_note_payload`). It also turns a
/// genuine delete-vs-offline-edit conflict into a resurrection of the edited
/// copy rather than a silent loss. A clean row is a real delete and is removed.
///
/// A detached row is marked `released`. That is the old home saying the row
/// is gone from it, which is what lets another space claim it, see
/// [`may_claim`]. The mark is taken off by whatever gives the row an item
/// again or a space to go to.
///
/// Only a row of the space the deletion came from is touched. An item's uid
/// means nothing outside its own collection.
///
/// `table` is always a crate-internal literal ("notes"/"collections"/
/// "assets"), never user input, so the format! is injection-safe.
pub(super) fn apply_remote_delete(
    conn: &Connection,
    table: &str,
    etebase_uid: &str,
    scope: Option<&str>,
) -> AppResult<()> {
    let detached = conn.execute(
        &format!(
            "UPDATE {table} SET etebase_uid = NULL, etebase_etag = NULL, released = 1
             WHERE etebase_uid = ?1 AND share_scope_id IS ?2 AND dirty = 1"
        ),
        params![etebase_uid, scope],
    )?;
    if detached == 0 {
        conn.execute(
            &format!("DELETE FROM {table} WHERE etebase_uid = ?1 AND share_scope_id IS ?2"),
            params![etebase_uid, scope],
        )?;
    }
    Ok(())
}
