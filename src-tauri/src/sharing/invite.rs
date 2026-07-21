//! `invite_collection` — turning a local folder into a share scope and
//! inviting a recipient onto it — plus the e2e-only invite fixtures.

use super::*;

#[tauri::command]
pub async fn invite_collection(
    app: AppHandle,
    input: InviteCollectionInput,
) -> Result<CollectionShareState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let InviteCollectionInput {
            collection_id,
            username,
            access_level,
        } = input;

        // Validate the target folder locally first — cheap, and avoids creating
        // remote collections for a bogus or un-shareable id.
        let db = app.state::<Db>();
        let folder = db.with_conn(|conn| crate::collections::get(conn, &collection_id))?;
        if collection_id == crate::collections::TRASH_ID {
            return Err(AppError::InvalidArg(
                "the trash collection cannot be shared".into(),
            ));
        }

        let account = restore_required(&app)?;
        let owner_username = crate::auth::read_session_info(&app)?.map(|info| info.username);

        // Block self-invite before touching the network — Etebase would let you
        // invite yourself, producing a bundle you can't meaningfully accept.
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

        // Read the folder's existing scope tag separately (it isn't on the
        // public Collection struct) so a re-share reuses that scope.
        let existing_scope_id: Option<String> = db.with_conn(|conn| {
            Ok(conn
                .query_row(
                    "SELECT share_scope_id FROM collections WHERE id = ?1",
                    params![collection_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten())
        })?;

        let inv_manager = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?;
        let cm = account
            .collection_manager()
            .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;

        // Resolve the recipient's public key up front so an unknown username
        // fails before any collections are created.
        let profile = inv_manager
            .fetch_user_profile(recipient)
            .map_err(|e| profile_lookup_error(recipient, e))?;
        let pubkey = profile.pubkey().to_vec();

        // Reuse the folder's scope if it already has one so re-sharing adds a
        // member rather than spawning a duplicate scope; otherwise create it.
        let (scope, created) = resolve_or_create_scope(
            &cm,
            &folder,
            existing_scope_id.as_deref(),
            owner_username.as_deref(),
        )?;

        // Never invite into a structurally incomplete scope — that's exactly how
        // a recipient ends up with an unsyncable, un-leavable folder.
        validate_scope_complete(&scope)?;

        // Refuse a duplicate: the recipient already has a pending invite to, or
        // membership in, this scope.
        if recipient_already_on_scope(&inv_manager, &cm, &scope, recipient)? {
            return Err(AppError::InvalidArg(format!(
                "{recipient} has already been invited to this folder"
            )));
        }

        // Invite the recipient: part collections at the requested level, the
        // manifest read-only (recipients read it, they don't edit it).
        let level: CollectionAccessLevel = access_level.into();
        invite_to_collection(
            &inv_manager,
            &scope.manifest,
            recipient,
            &pubkey,
            CollectionAccessLevel::ReadOnly,
        )?;
        invite_to_collection(&inv_manager, &scope.folders, recipient, &pubkey, level)?;
        invite_to_collection(&inv_manager, &scope.notes, recipient, &pubkey, level)?;
        invite_to_collection(&inv_manager, &scope.assets, recipient, &pubkey, level)?;

        // Route the shared subtree into the scope's collections: stamp every
        // folder/note/asset under the root with the scope id and detach it from
        // the vault-wide collections (tombstone the old vault item, clear the
        // uid, mark dirty) so the next sync re-homes it. Run on every invite so
        // content added since the first share is picked up when someone new is
        // added. On the very first share also record the shared-by-me root.
        let folders_uid = scope.folders.uid().to_string();
        let scope_id = scope.share_scope_id.clone();
        db.with_conn(|conn| {
            rehome_folder_subtree(conn, &collection_id, Some(&scope_id))?;
            if created {
                record_outgoing_share(
                    conn,
                    &collection_id,
                    &scope_id,
                    &folders_uid,
                    access_level,
                    owner_username.as_deref(),
                )?;
            }
            Ok::<(), AppError>(())
        })?;

        db.with_conn(|conn| local_share_state(conn, &collection_id))
    })
    .await
    .map_err(|e| format!("invite collection task: {e}"))?
    .map_err(Into::into)
}

#[cfg(feature = "e2e-data-dir")]
#[tauri::command]
pub async fn e2e_create_standalone_collection_invite(
    app: AppHandle,
    input: E2eStandaloneInviteInput,
) -> Result<E2eStandaloneInviteResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let E2eStandaloneInviteInput {
            username,
            collection_type,
            name,
            access_level,
        } = input;

        let recipient = username.trim();
        if recipient.is_empty() {
            return Err(AppError::InvalidArg(
                "a recipient username is required".into(),
            ));
        }
        if collection_type.trim().is_empty() {
            return Err(AppError::InvalidArg("a collection type is required".into()));
        }
        if is_share_scope_collection_type(Some(collection_type.trim())) {
            return Err(AppError::InvalidArg(
                "standalone invites must not use share-scope collection types".into(),
            ));
        }

        let account = restore_required(&app)?;
        let inv_manager = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?;
        let cm = account
            .collection_manager()
            .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;
        let profile = inv_manager
            .fetch_user_profile(recipient)
            .map_err(|e| profile_lookup_error(recipient, e))?;
        let pubkey = profile.pubkey().to_vec();

        let collection = create_share_collection(&cm, &collection_type, &name, &[])?;
        invite_to_collection(
            &inv_manager,
            &collection,
            recipient,
            &pubkey,
            access_level.into(),
        )?;

        Ok::<_, AppError>(E2eStandaloneInviteResult {
            collection_uid: collection.uid().to_string(),
        })
    })
    .await
    .map_err(|e| format!("create standalone invite task: {e}"))?
    .map_err(Into::into)
}

#[cfg(feature = "e2e-data-dir")]
#[tauri::command]
pub async fn e2e_create_incomplete_share_bundle(
    app: AppHandle,
    input: E2eIncompleteBundleInput,
) -> Result<E2eIncompleteBundleResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let E2eIncompleteBundleInput {
            username,
            name,
            access_level,
        } = input;

        let recipient = username.trim();
        if recipient.is_empty() {
            return Err(AppError::InvalidArg(
                "a recipient username is required".into(),
            ));
        }

        let account = restore_required(&app)?;
        let owner_username = crate::auth::read_session_info(&app)?.map(|info| info.username);
        let inv_manager = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?;
        let cm = account
            .collection_manager()
            .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;
        let profile = inv_manager
            .fetch_user_profile(recipient)
            .map_err(|e| profile_lookup_error(recipient, e))?;
        let pubkey = profile.pubkey().to_vec();

        let folders = create_share_collection(
            &cm,
            COLLECTION_TYPE_SHARE_FOLDERS,
            &format!("{name} — folders"),
            &[],
        )?;
        let notes = create_share_collection(
            &cm,
            COLLECTION_TYPE_SHARE_NOTES,
            &format!("{name} — notes"),
            &[],
        )?;
        let assets = create_share_collection(
            &cm,
            COLLECTION_TYPE_SHARE_ASSETS,
            &format!("{name} — assets"),
            &[],
        )?;
        let share_scope_id = format!("scope_{}", uuid::Uuid::new_v4());
        let root_folder_id = format!("e2e_incomplete_root_{}", uuid::Uuid::new_v4());
        let manifest = build_share_manifest(
            &share_scope_id,
            &name,
            &root_folder_id,
            owner_username.as_deref(),
            folders.uid(),
            notes.uid(),
            assets.uid(),
        );
        let manifest_json = serde_json::to_vec(&manifest)
            .map_err(|e| AppError::InvalidArg(format!("encode manifest: {e}")))?;
        let manifest_col = create_share_collection(
            &cm,
            COLLECTION_TYPE_SHARE_MANIFEST,
            &format!("{name} — share"),
            &manifest_json,
        )?;

        let level: CollectionAccessLevel = access_level.into();
        invite_to_collection(
            &inv_manager,
            &manifest_col,
            recipient,
            &pubkey,
            CollectionAccessLevel::ReadOnly,
        )?;
        invite_to_collection(&inv_manager, &folders, recipient, &pubkey, level)?;
        invite_to_collection(&inv_manager, &notes, recipient, &pubkey, level)?;

        Ok::<_, AppError>(E2eIncompleteBundleResult {
            manifest_collection_uid: manifest_col.uid().to_string(),
        })
    })
    .await
    .map_err(|e| format!("create incomplete share bundle task: {e}"))?
    .map_err(Into::into)
}

#[cfg(feature = "e2e-data-dir")]
#[tauri::command]
pub async fn e2e_accept_share_manifest_only(
    app: AppHandle,
    manifest_collection_uid: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = restore_required(&app)?;
        let inv_manager = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?;
        let incoming = list_all_incoming(&inv_manager)?;
        let Some(pending_manifest) = incoming.iter().find(|invitation| {
            invitation.collection_uid == manifest_collection_uid
                && invitation.collection_type.as_deref() == Some(COLLECTION_TYPE_SHARE_MANIFEST)
        }) else {
            return Err(AppError::NotFound(format!(
                "manifest invitation for {manifest_collection_uid}"
            )));
        };
        let Some(signed) = find_incoming_invitation(&inv_manager, &pending_manifest.id)? else {
            return Err(AppError::NotFound(format!(
                "manifest invitation {}",
                pending_manifest.id
            )));
        };
        inv_manager
            .accept(&signed)
            .map_err(|e| AppError::InvalidArg(format!("accept manifest invitation: {e}")))?;
        Ok::<(), AppError>(())
    })
    .await
    .map_err(|e| format!("accept share manifest task: {e}"))?
    .map_err(Into::into)
}
