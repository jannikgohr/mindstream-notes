//! Membership commands: who is on a scope, changing their access level,
//! removing them, and the accept/reject of a bare collection invitation.

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

/// The local `share_scope_id` tag for a folder, or `None` when it isn't shared.
pub(super) fn local_share_scope_id(db: &Db, collection_id: &str) -> AppResult<Option<String>> {
    db.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT share_scope_id FROM collections WHERE id = ?1",
                params![collection_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    })
}

/// List everyone with access to a shared folder and at what level. Reads the
/// membership of the scope's `folders` collection (which carries the content
/// access level; the manifest is always read-only). Empty when the folder isn't
/// shared or the scope can't be resolved.
#[tauri::command]
pub async fn list_collection_members(
    app: AppHandle,
    collection_id: String,
) -> CommandResult<Vec<CollectionMember>> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = restore_required(&app)?;
        let db = app.state::<Db>();
        let Some(scope_id) = local_share_scope_id(&db, &collection_id)? else {
            return Ok(Vec::new());
        };
        let cm = account
            .collection_manager()
            .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;
        let Some(scope) = find_existing_scope(&cm, &scope_id)? else {
            return Ok(Vec::new());
        };
        let member_manager = cm
            .member_manager(&scope.folders)
            .map_err(|e| AppError::InvalidArg(format!("member_manager: {e}")))?;
        let mut members = Vec::new();
        let mut iterator: Option<String> = None;
        loop {
            let options = FetchOptions::new().limit(100).iterator(iterator.as_deref());
            let page = member_manager
                .list(Some(&options))
                .map_err(|e| AppError::InvalidArg(format!("list members: {e}")))?;
            for member in page.data() {
                members.push(CollectionMember {
                    username: member.username().to_string(),
                    access_level: member.access_level().into(),
                });
            }
            if page.done() {
                break;
            }
            match page.iterator().map(str::to_string) {
                Some(next) => iterator = Some(next),
                None => break,
            }
        }
        Ok::<Vec<CollectionMember>, AppError>(members)
    })
    .await
    .map_err(|e| format!("list collection members task: {e}"))?
    .map_err(Into::into)
}

/// Change a member's access level on a folder the current user shares. The three
/// part collections (folders/notes/assets) carry the content level; the manifest
/// stays read-only. The recipient's next sync re-projects their `shared_role`
/// from the folders collection automatically (a read-only downgrade also triggers
/// the read-only-scope edit discard).
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
        let Some(scope_id) = local_share_scope_id(&db, &collection_id)? else {
            return Err(AppError::InvalidArg("this folder isn't shared".into()));
        };
        let cm = account
            .collection_manager()
            .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;
        let Some(scope) = find_existing_scope(&cm, &scope_id)? else {
            return Err(AppError::InvalidArg(
                "this shared folder is no longer available".into(),
            ));
        };
        let rotate_live_collab = access_change_requires_collab_rotation(access_level);
        let affected_note_ids = if rotate_live_collab {
            crate::collab_events::note_ids_for_share_scope(&db, &scope_id)?
        } else {
            Vec::new()
        };
        let level: CollectionAccessLevel = access_level.into();
        for col in [&scope.folders, &scope.notes, &scope.assets] {
            let member_manager = cm
                .member_manager(col)
                .map_err(|e| AppError::InvalidArg(format!("member_manager: {e}")))?;
            member_manager
                .modify_access_level(&username, level)
                .map_err(|e| AppError::InvalidArg(format!("change access for {username}: {e}")))?;
        }
        if rotate_live_collab {
            rotate_scope_collab_secret(&cm, &scope.manifest)?;
            crate::collab_events::emit_collab_credentials_changed(&app, affected_note_ids);
        }
        Ok::<(), AppError>(())
    })
    .await
    .map_err(|e| format!("set collection member access task: {e}"))?
    .map_err(Into::into)
}

pub(super) fn access_change_requires_collab_rotation(access_level: ShareAccessLevel) -> bool {
    matches!(access_level, ShareAccessLevel::ReadOnly)
}

/// Remove one member from a folder the current user shares. Removes them from all
/// four scope collections so they lose the manifest and every part; the removed
/// recipient's device purges its copy on the next sync (see
/// `reconcile_revoked_shares`). Others keep their access.
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
        let Some(scope_id) = local_share_scope_id(&db, &collection_id)? else {
            return Err(AppError::InvalidArg("this folder isn't shared".into()));
        };
        let cm = account
            .collection_manager()
            .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;
        let Some(scope) = find_existing_scope(&cm, &scope_id)? else {
            return Err(AppError::InvalidArg(
                "this shared folder is no longer available".into(),
            ));
        };
        let affected_note_ids = crate::collab_events::note_ids_for_share_scope(&db, &scope_id)?;
        for col in [&scope.manifest, &scope.folders, &scope.notes, &scope.assets] {
            let member_manager = cm.member_manager(col).map_err(|e| {
                scope_member_remove_error(&username, col.uid(), format!("member_manager: {e}"))
            })?;
            member_manager.remove(&username).map_err(|e| {
                scope_member_remove_error(&username, col.uid(), format!("remove member: {e}"))
            })?;
        }
        rotate_scope_collab_secret(&cm, &scope.manifest)?;
        crate::collab_events::emit_collab_credentials_changed(&app, affected_note_ids);
        Ok::<(), AppError>(())
    })
    .await
    .map_err(|e| format!("remove collection member task: {e}"))?
    .map_err(Into::into)
}

pub(super) fn scope_member_remove_error(
    username: &str,
    collection_uid: &str,
    err: String,
) -> AppError {
    AppError::InvalidArg(format!(
        "failed to remove {username} from shared collection {collection_uid}: {err}"
    ))
}

#[tauri::command]
pub async fn accept_collection_invitation(app: AppHandle, id: String) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = restore_required(&app)?;
        let manager = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?;
        let invitation = find_incoming_invitation(&manager, &id)?
            .ok_or_else(|| AppError::NotFound(format!("invitation {id}")))?;
        manager
            .accept(&invitation)
            .map_err(|e| AppError::InvalidArg(format!("accept invitation: {e}")))?;

        let db = app.state::<Db>();
        let role: ShareAccessLevel = invitation.access_level().into();
        let owner = invitation.sender_username();
        db.with_conn(|conn| {
            record_accepted_share(conn, invitation.collection(), role, owner, None)
        })?;
        Ok::<(), AppError>(())
    })
    .await
    .map_err(|e| format!("accept collection invitation task: {e}"))?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn reject_collection_invitation(app: AppHandle, id: String) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = restore_required(&app)?;
        let manager = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?;
        let invitation = find_incoming_invitation(&manager, &id)?
            .ok_or_else(|| AppError::NotFound(format!("invitation {id}")))?;
        manager
            .reject(&invitation)
            .map_err(|e| AppError::InvalidArg(format!("reject invitation: {e}")))?;
        Ok::<(), AppError>(())
    })
    .await
    .map_err(|e| format!("reject collection invitation task: {e}"))?
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
