//! The receiving side of a share: listing the invitations that wait for an
//! answer, and giving one.
//!
//! Listing reads and nothing else. An invitation carries the collection's
//! key for its recipient, and the server sends the collection's own item
//! along, so the folder's name can be shown without accepting anything.

use super::*;
use crate::error::CommandError;

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
        sender_key: None,
    })
}

/// The server this device is signed in to. Keys are remembered per server.
pub(super) fn session_server(app: &AppHandle) -> AppResult<String> {
    crate::auth::read_session_info(app)?
        .map(|info| info.server_url)
        .ok_or_else(|| AppError::InvalidArg("not signed in".into()))
}

/// The key an invitation came from, held against the one remembered for its
/// sender. `None` for an invitation that names no sender: there is nobody
/// to remember a key for.
fn sender_key(
    conn: &Connection,
    server_url: &str,
    invitation: &SignedInvitation,
) -> AppResult<Option<UserKey>> {
    invitation
        .sender_username()
        .map(|sender| user_key(conn, server_url, sender, invitation.sender_pubkey()))
        .transpose()
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
    let job = app.state::<crate::vault_jobs::Jobs>().enter()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _job = job;
        let account = restore_required(&app)?;
        let server = session_server(&app)?;
        let manager = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?;
        let db = app.state::<Db>();
        let mut shares = Vec::new();
        for (invitation, preview) in incoming_previews(&manager)? {
            let Some(mut share) = incoming_share(&preview) else {
                continue;
            };
            share.sender_key = db.with_conn(|conn| sender_key(conn, &server, &invitation))?;
            shares.push(share);
        }
        Ok::<_, AppError>(shares)
    })
    .await
    .map_err(|e| format!("list incoming shares task: {e}"))?
    .map_err(Into::into)
}

/// Accept an invitation to a shared folder. That is the whole of joining:
/// the next sync finds the collection among this account's and pulls the
/// folder in, with the sender's own ids for its folders and notes.
///
/// An invitation is as good as the key it came from. One from a key that is
/// not the one remembered for its sender is refused unless
/// `trust_changed_key` says the user has seen that and wants to go on.
#[tauri::command]
pub async fn accept_share(
    app: AppHandle,
    invitation_id: String,
    trust_changed_key: Option<bool>,
) -> CommandResult<()> {
    let job = app.state::<crate::vault_jobs::Jobs>().enter()?;
    tauri::async_runtime::spawn_blocking(move || -> CommandResult<()> {
        let _job = job;
        let account = restore_required(&app)?;
        let server = session_server(&app)?;
        let manager = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?;
        let invitation = find_incoming_share(&manager, &invitation_id)?
            .ok_or_else(|| AppError::NotFound(format!("invitation {invitation_id}")))?;

        let db = app.state::<Db>();
        let sender = invitation.sender_username().map(str::to_string);
        if let Some(sender) = sender.as_deref() {
            check_key(
                &db,
                &server,
                sender,
                invitation.sender_pubkey(),
                trust_changed_key.unwrap_or(false),
            )?;
        }

        manager
            .accept(&invitation)
            .map_err(|e| AppError::from_server("accept invitation", e))?;

        // Accepting is relying on the key, so this is when it is kept.
        if let Some(sender) = sender.as_deref() {
            db.with_conn(|conn| remember_key(conn, &server, sender, invitation.sender_pubkey()))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| CommandError::task(format!("accept share task: {e}")))?
}

/// Turn an invitation to a shared folder down. One that is already gone,
/// because the sender withdrew it or another device answered, is as turned
/// down as it can be.
#[tauri::command]
pub async fn decline_share(app: AppHandle, invitation_id: String) -> CommandResult<()> {
    let job = app.state::<crate::vault_jobs::Jobs>().enter()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _job = job;
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
