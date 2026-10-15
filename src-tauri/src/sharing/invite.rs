//! `invite_collection`: turning a local folder into a shared one and
//! inviting someone to it.

use super::*;
use crate::error::CommandError;

#[tauri::command]
pub async fn invite_collection(
    app: AppHandle,
    input: InviteCollectionInput,
) -> CommandResult<CollectionShareState> {
    tauri::async_runtime::spawn_blocking(move || -> CommandResult<CollectionShareState> {
        let InviteCollectionInput {
            collection_id,
            username,
            access_level,
            trust_changed_key,
        } = input;

        // Look at the folder first. It costs nothing, and a bogus id must
        // not leave a collection behind on the server.
        let db = app.state::<Db>();
        let folder = db.with_conn(|conn| crate::collections::get(conn, &collection_id))?;
        if collection_id == crate::collections::TRASH_ID {
            return Err(
                AppError::InvalidArg("the trash collection cannot be shared".into()).into(),
            );
        }

        let account = restore_required(&app)?;
        let server = session_server(&app)?;
        let owner_username = crate::auth::read_session_info(&app)?.map(|info| info.username);

        let recipient = username.trim();
        if recipient.is_empty() {
            return Err(AppError::InvalidArg("a recipient username is required".into()).into());
        }
        if owner_username
            .as_deref()
            .is_some_and(|me| me.eq_ignore_ascii_case(recipient))
        {
            return Err(
                AppError::InvalidArg("you can't share a folder with yourself".into()).into(),
            );
        }

        let existing_scope = db.with_conn(|conn| collection_scope(conn, &collection_id))?;

        let invitations = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?;
        let cm = account
            .collection_manager()
            .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;

        // The recipient's key before anything else, so that an unknown name
        // fails with nothing created.
        let profile = invitations
            .fetch_user_profile(recipient)
            .map_err(|e| profile_lookup_error(recipient, &e))?;

        // The folder's key is about to be sealed to this key. If it is not
        // the one remembered for the recipient, nothing is made or sent
        // until the user has looked at it.
        check_key(&db, &server, recipient, profile.pubkey(), trust_changed_key)?;

        // A folder that is shared already gets one more member. Only a
        // folder that is not gets a collection.
        let (collection, created) = resolve_or_create_space(
            &cm,
            &folder,
            existing_scope.as_deref(),
            owner_username.as_deref(),
        )?;

        // Recorded before the invitation is sent. If sending fails, the
        // folder is shared with nobody yet and the next try finds its
        // collection. Recording afterwards would leave a collection nothing
        // points to, and make another on every try.
        db.with_conn(|conn| {
            move_into_space(
                conn,
                &collection_id,
                collection.uid(),
                created,
                owner_username.as_deref(),
            )
        })?;

        if recipient_already_on_space(&invitations, &cm, &collection, recipient)? {
            return Err(AppError::InvalidArg(format!(
                "{recipient} has already been invited to this folder"
            ))
            .into());
        }

        invitations
            .invite(
                &collection,
                recipient,
                profile.pubkey(),
                access_level.into(),
            )
            .map_err(|e| AppError::from_server(format_args!("invite {recipient}"), e))?;

        // The folder's key now depends on this key, so this is when it is
        // kept.
        db.with_conn(|conn| remember_key(conn, &server, recipient, profile.pubkey()))?;

        Ok(db.with_conn(|conn| local_share_state(conn, &collection_id))?)
    })
    .await
    .map_err(|e| CommandError::task(format!("invite collection task: {e}")))?
}

/// Test-only: invite someone to a collection that is not a shared folder,
/// the way another program on the same server could. The suite uses it to
/// check that such an invitation is never shown as a share.
#[cfg(feature = "e2e-data-dir")]
#[derive(Debug, Clone, Deserialize)]
pub struct E2eStandaloneInviteInput {
    pub username: String,
    pub collection_type: String,
    pub name: String,
    pub access_level: ShareAccessLevel,
}

#[cfg(feature = "e2e-data-dir")]
#[derive(Debug, Clone, Serialize)]
pub struct E2eStandaloneInviteResult {
    pub collection_uid: String,
}

#[cfg(feature = "e2e-data-dir")]
#[tauri::command]
pub async fn e2e_create_standalone_collection_invite(
    app: AppHandle,
    input: E2eStandaloneInviteInput,
) -> CommandResult<E2eStandaloneInviteResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let recipient = input.username.trim();
        let collection_type = input.collection_type.trim();
        if recipient.is_empty() || collection_type.is_empty() {
            return Err(AppError::InvalidArg(
                "a recipient and a collection type are required".into(),
            ));
        }
        if collection_type == COLLECTION_TYPE_SHARED {
            return Err(AppError::InvalidArg(
                "this is for collections that are not shared folders".into(),
            ));
        }

        let account = restore_required(&app)?;
        let invitations = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?;
        let cm = account
            .collection_manager()
            .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;
        let profile = invitations
            .fetch_user_profile(recipient)
            .map_err(|e| profile_lookup_error(recipient, &e))?;

        let mut meta = ItemMetadata::new();
        meta.set_name(Some(&input.name));
        let collection = cm
            .create(collection_type, &meta, &[])
            .map_err(|e| AppError::InvalidArg(format!("create {collection_type}: {e}")))?;
        cm.upload(&collection, None)
            .map_err(|e| AppError::InvalidArg(format!("upload {collection_type}: {e}")))?;
        invitations
            .invite(
                &collection,
                recipient,
                profile.pubkey(),
                input.access_level.into(),
            )
            .map_err(|e| AppError::InvalidArg(format!("invite {recipient}: {e}")))?;

        Ok::<_, AppError>(E2eStandaloneInviteResult {
            collection_uid: collection.uid().to_string(),
        })
    })
    .await
    .map_err(|e| format!("create standalone invite task: {e}"))?
    .map_err(Into::into)
}
