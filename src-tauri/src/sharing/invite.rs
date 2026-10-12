//! `invite_collection`: turning a local folder into a shared one and
//! inviting someone to it.

use super::*;

#[tauri::command]
pub async fn invite_collection(
    app: AppHandle,
    input: InviteCollectionInput,
) -> CommandResult<CollectionShareState> {
    tauri::async_runtime::spawn_blocking(move || {
        let InviteCollectionInput {
            collection_id,
            username,
            access_level,
        } = input;

        // Look at the folder first. It costs nothing, and a bogus id must
        // not leave a collection behind on the server.
        let db = app.state::<Db>();
        let folder = db.with_conn(|conn| crate::collections::get(conn, &collection_id))?;
        if collection_id == crate::collections::TRASH_ID {
            return Err(AppError::InvalidArg(
                "the trash collection cannot be shared".into(),
            ));
        }

        let account = restore_required(&app)?;
        let owner_username = crate::auth::read_session_info(&app)?.map(|info| info.username);

        let recipient = username.trim();
        if recipient.is_empty() {
            return Err(AppError::InvalidArg(
                "a recipient username is required".into(),
            ));
        }
        if owner_username
            .as_deref()
            .is_some_and(|me| me.eq_ignore_ascii_case(recipient))
        {
            return Err(AppError::InvalidArg(
                "you can't share a folder with yourself".into(),
            ));
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

        // A folder that is shared already gets one more member. Only a
        // folder that is not gets a collection.
        let (collection, created) = resolve_or_create_space(
            &cm,
            &folder,
            existing_scope.as_deref(),
            owner_username.as_deref(),
        )?;

        if recipient_already_on_space(&invitations, &cm, &collection, recipient)? {
            return Err(AppError::InvalidArg(format!(
                "{recipient} has already been invited to this folder"
            )));
        }

        invitations
            .invite(
                &collection,
                recipient,
                profile.pubkey(),
                access_level.into(),
            )
            .map_err(|e| AppError::InvalidArg(format!("invite {recipient}: {e}")))?;

        // Move the folder into its collection: stamp every folder, note and
        // attachment under it with the scope and detach it from where it
        // was, so the next sync creates it there. A folder that was shared
        // already is in its collection, and what was added to it since
        // inherited the scope as it was added, so there is nothing to move
        // and moving it anyway would delete and recreate every item for
        // every member.
        let scope = collection.uid().to_string();
        db.with_conn(|conn| {
            if created || subtree_outside_scope(conn, &collection_id, &scope)? {
                rehome_folder_subtree(conn, &collection_id, Some(&scope))?;
            }
            if created {
                record_outgoing_share(conn, &collection_id, &scope, owner_username.as_deref())?;
            }
            Ok::<(), AppError>(())
        })?;

        db.with_conn(|conn| local_share_state(conn, &collection_id))
    })
    .await
    .map_err(|e| format!("invite collection task: {e}"))?
    .map_err(Into::into)
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
