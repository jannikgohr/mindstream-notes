//! Membership commands: who is on a shared folder, changing what they may
//! do, and removing them. Each is one request against the folder's one
//! collection, so a change either happened or did not.

use super::*;

#[derive(Debug, Clone, Deserialize)]
pub struct SetMemberAccessInput {
    pub collection_id: String,
    pub username: String,
    pub access_level: ShareAccessLevel,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RemoveMemberInput {
    pub collection_id: String,
    pub username: String,
}

/// The collection a folder is shared through, for a command that changes
/// something about it. A folder that is not shared, or whose collection is
/// gone, is an error the user is told about.
fn space_to_manage(
    db: &Db,
    cm: &CollectionManager,
    collection_id: &str,
) -> AppResult<(String, Collection)> {
    let Some(scope) = db.with_conn(|conn| collection_scope(conn, collection_id))? else {
        return Err(AppError::InvalidArg("this folder isn't shared".into()));
    };
    match open_space(cm, &scope)? {
        Some(collection) => Ok((scope, collection)),
        None => Err(AppError::InvalidArg(
            "this shared folder is no longer available".into(),
        )),
    }
}

/// Everyone with access to a shared folder and at what level. Empty when
/// the folder is not shared or its collection is gone.
#[tauri::command]
pub async fn list_collection_members(
    app: AppHandle,
    collection_id: String,
) -> CommandResult<Vec<CollectionMember>> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = restore_required(&app)?;
        let db = app.state::<Db>();
        let Some(scope) = db.with_conn(|conn| collection_scope(conn, &collection_id))? else {
            return Ok(Vec::new());
        };
        let cm = account
            .collection_manager()
            .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;
        match open_space(&cm, &scope)? {
            Some(collection) => list_members(&cm, &collection),
            None => Ok(Vec::new()),
        }
    })
    .await
    .map_err(|e| format!("list collection members task: {e}"))?
    .map_err(Into::into)
}

/// Change what a member may do in a folder the current user shares. The
/// member's next sync reads the new level off the collection, and someone
/// made read-only has their unsent edits to the folder discarded there. In a
/// live session the server applies the new level at once: it goes on showing
/// them the note and drops what they send.
#[tauri::command]
pub async fn set_collection_member_access(
    app: AppHandle,
    input: SetMemberAccessInput,
) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let SetMemberAccessInput {
            collection_id,
            username,
            access_level,
        } = input;
        let account = restore_required(&app)?;
        let db = app.state::<Db>();
        let cm = account
            .collection_manager()
            .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;
        let (_, collection) = space_to_manage(&db, &cm, &collection_id)?;
        cm.member_manager(&collection)
            .map_err(|e| AppError::InvalidArg(format!("member_manager: {e}")))?
            .modify_access_level(&username, access_level.into())
            .map_err(|e| AppError::InvalidArg(format!("change access for {username}: {e}")))?;
        Ok::<(), AppError>(())
    })
    .await
    .map_err(|e| format!("set collection member access task: {e}"))?
    .map_err(Into::into)
}

/// Remove one member from a folder the current user shares. The server
/// closes their live sessions and stops answering them at once, and their
/// device drops its copy on its next sync (see `reconcile_revoked_shares`).
/// Everyone else keeps their access.
///
/// No key is changed. What keeps a removed member out is the server
/// refusing them, the room and the collection alike. They keep what they
/// had already synced, and the keys to it, as with any shared document.
#[tauri::command]
pub async fn remove_collection_member(
    app: AppHandle,
    input: RemoveMemberInput,
) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let RemoveMemberInput {
            collection_id,
            username,
        } = input;
        let account = restore_required(&app)?;
        let db = app.state::<Db>();
        let cm = account
            .collection_manager()
            .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;
        let (_, collection) = space_to_manage(&db, &cm, &collection_id)?;
        cm.member_manager(&collection)
            .map_err(|e| AppError::InvalidArg(format!("member_manager: {e}")))?
            .remove(&username)
            .map_err(|e| AppError::InvalidArg(format!("remove {username}: {e}")))?;
        Ok::<(), AppError>(())
    })
    .await
    .map_err(|e| format!("remove collection member task: {e}"))?
    .map_err(Into::into)
}

#[tauri::command]
pub fn get_collection_share_state(
    db: tauri::State<'_, Db>,
    collection_id: String,
) -> CommandResult<CollectionShareState> {
    db.with_conn(|conn| local_share_state(conn, &collection_id))
        .map_err(Into::into)
}
