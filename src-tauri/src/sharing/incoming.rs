//! The receiving side of a share: listing the invitations that wait for an
//! answer, and giving one.
//!
//! Listing reads and nothing else. An invitation carries the collection's
//! key for its recipient, and the server sends the collection's own item
//! along, so the folder's name can be shown without accepting anything.

use super::*;

pub(super) fn restore_required(app: &AppHandle) -> AppResult<Account> {
    crate::auth::try_restore(app)
        .map_err(|e| AppError::InvalidArg(format!("restore session: {e}")))?
        .ok_or_else(|| AppError::InvalidArg("not signed in".into()))
}

/// What the UI is told about an invitation, or `None` when the invitation
/// is not to a shared folder. Nothing else this app makes is ever shared, so
/// an invitation to another kind of collection comes from another program
/// and is not ours to show or answer.
pub(super) fn incoming_share(preview: &InvitationPreview) -> Option<IncomingShare> {
    (preview.collection_type() == COLLECTION_TYPE_SHARED).then(|| IncomingShare {
        invitation_id: preview.uid().to_string(),
        collection_uid: preview.collection_uid().to_string(),
        name: preview
            .collection_name()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string),
        sender_username: preview.sender_username().map(str::to_string),
        access_level: preview.access_level().into(),
    })
}

/// Every invitation waiting for this account, with what could be read of it.
/// One that cannot be opened is left out: without its content there is
/// neither a type to recognise it by nor a key to accept it with.
fn incoming_previews(
    manager: &CollectionInvitationManager,
) -> AppResult<Vec<(SignedInvitation, InvitationPreview)>> {
    Ok(all_pages("incoming invitations", |options| {
        manager.list_incoming(Some(options))
    })?
    .into_iter()
    .filter_map(|invitation| match manager.preview(&invitation) {
        Ok(preview) => Some((invitation, preview)),
        Err(e) => {
            log::warn!(
                "[sharing] invitation {} cannot be read: {e}",
                invitation.uid()
            );
            None
        }
    })
    .collect())
}

/// The invitation to a shared folder with this id, if it is still waiting.
fn find_incoming_share(
    manager: &CollectionInvitationManager,
    invitation_id: &str,
) -> AppResult<Option<SignedInvitation>> {
    Ok(incoming_previews(manager)?
        .into_iter()
        .find(|(invitation, preview)| {
            invitation.uid() == invitation_id && incoming_share(preview).is_some()
        })
        .map(|(invitation, _)| invitation))
}

/// The invitations to shared folders that wait for an answer.
#[tauri::command]
pub async fn list_incoming_shares(app: AppHandle) -> CommandResult<Vec<IncomingShare>> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = restore_required(&app)?;
        let manager = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?;
        Ok::<_, AppError>(
            incoming_previews(&manager)?
                .iter()
                .filter_map(|(_, preview)| incoming_share(preview))
                .collect(),
        )
    })
    .await
    .map_err(|e| format!("list incoming shares task: {e}"))?
    .map_err(Into::into)
}

/// Accept an invitation to a shared folder. That is the whole of joining:
/// the next sync finds the collection among this account's and pulls the
/// folder in, with the sender's own ids for its folders and notes.
#[tauri::command]
pub async fn accept_share(app: AppHandle, invitation_id: String) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = restore_required(&app)?;
        let manager = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?;
        let invitation = find_incoming_share(&manager, &invitation_id)?
            .ok_or_else(|| AppError::NotFound(format!("invitation {invitation_id}")))?;
        manager
            .accept(&invitation)
            .map_err(|e| AppError::InvalidArg(format!("accept invitation: {e}")))?;
        Ok::<(), AppError>(())
    })
    .await
    .map_err(|e| format!("accept share task: {e}"))?
    .map_err(Into::into)
}

/// Turn an invitation to a shared folder down. One that is already gone,
/// because the sender withdrew it or another device answered, is as turned
/// down as it can be.
#[tauri::command]
pub async fn decline_share(app: AppHandle, invitation_id: String) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = restore_required(&app)?;
        let manager = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?;
        if let Some(invitation) = find_incoming_share(&manager, &invitation_id)? {
            manager
                .reject(&invitation)
                .map_err(|e| AppError::InvalidArg(format!("decline invitation: {e}")))?;
        }
        Ok::<(), AppError>(())
    })
    .await
    .map_err(|e| format!("decline share task: {e}"))?
    .map_err(Into::into)
}
