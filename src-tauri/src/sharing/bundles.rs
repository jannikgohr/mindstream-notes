//! Commands for the incoming side of a share: listing invitations and
//! manifest-backed bundles, then accepting or declining one.

use super::*;

#[tauri::command]
pub async fn list_collection_invitations(
    app: AppHandle,
) -> Result<Vec<CollectionInvitation>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = restore_required(&app)?;
        let manager = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?;
        list_all_incoming(&manager).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("list collection invitations task: {e}"))?
}

/// List incoming share invitations grouped into manifest-backed bundles.
///
/// Read-only: unlike an accept, this never mutates server state. Pending
/// `mindstream.share_manifest` invitations are surfaced from their non-mutating
/// `preview` (sender + access, but no name/parts — that lives in the manifest
/// content, which requires membership). A share the user has already accepted
/// is a member collection, so its manifest is read straight from the collection
/// list with full detail. The metadata-only manifest is only accepted when the
/// user explicitly accepts the bundle (see `accept_share_bundle`).
#[tauri::command]
pub async fn list_incoming_share_bundles(
    app: AppHandle,
) -> Result<IncomingShareInvitations, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = restore_required(&app)?;
        let inv_manager = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?;
        let cm = account
            .collection_manager()
            .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;
        let me = crate::auth::read_session_info(&app)?.map(|info| info.username);
        let invitations = list_all_incoming(&inv_manager)?;
        let opened = collect_opened_manifests(&cm, me.as_deref())?;
        Ok::<_, AppError>(assemble_incoming_share_bundles(invitations, opened))
    })
    .await
    .map_err(|e| format!("list incoming share bundles task: {e}"))?
    .map_err(Into::into)
}

/// Accept a whole share bundle: accept the metadata-only manifest invitation (if
/// it's still pending — this is the consented moment its content is first read),
/// then accept every referenced folders/notes/assets invitation still pending.
///
/// The parts are re-derived server-side from the manifest content rather than
/// trusting client-passed invitation ids, so a stale UI can't accept invitations
/// the manifest doesn't actually reference. Etebase has no cross-collection
/// transaction, so this is best-effort ordered: a failure on one part surfaces as
/// an error, but parts accepted before it stay accepted (re-running the accept is
/// idempotent — the manifest and already-accepted parts are skipped).
#[tauri::command]
pub async fn accept_share_bundle(
    app: AppHandle,
    manifest_collection_uid: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = restore_required(&app)?;
        let inv_manager = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?;
        let cm = account
            .collection_manager()
            .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;

        // Accept the manifest invitation first if it hasn't been accepted yet —
        // reading its content below requires membership. Idempotent: once
        // accepted it's gone from the incoming list and we skip straight to the
        // fetch.
        let incoming = list_all_incoming(&inv_manager)?;
        if let Some(pending_manifest) = incoming.iter().find(|invitation| {
            invitation.collection_uid == manifest_collection_uid
                && invitation.collection_type.as_deref() == Some(COLLECTION_TYPE_SHARE_MANIFEST)
        }) {
            if let Some(signed) = find_incoming_invitation(&inv_manager, &pending_manifest.id)? {
                inv_manager.accept(&signed).map_err(|e| {
                    AppError::InvalidArg(format!("accept manifest invitation: {e}"))
                })?;
            }
        }

        // Read the manifest content (now a member) and accept the parts it lists.
        let col = cm
            .fetch(&manifest_collection_uid, None)
            .map_err(|e| AppError::InvalidArg(format!("fetch manifest collection: {e}")))?;
        if col.is_deleted() {
            return Err(AppError::NotFound(format!(
                "share bundle {manifest_collection_uid}"
            )));
        }
        let manifest = decode_manifest(&col)?;

        // Re-list: the manifest invitation just accepted is gone, and this gives
        // fresh ids for the still-pending part invitations.
        let incoming = list_all_incoming(&inv_manager)?;
        let invitation_by_collection: HashMap<&str, &CollectionInvitation> = incoming
            .iter()
            .map(|invitation| (invitation.collection_uid.as_str(), invitation))
            .collect();

        // Refuse an incomplete bundle *before* accepting any part. A required
        // part is satisfiable only if the manifest references it AND either a
        // pending invitation exists for it or we're already a member of that
        // collection (idempotent re-accept). Accepting a bundle with an
        // unsatisfiable required part is what strands a recipient with an
        // unsyncable, un-leavable folder — so we stop here and the bundle stays
        // declinable.
        let mut member_part_uids: Vec<String> = Vec::new();
        for collection_ref in &manifest.collections {
            let uid = collection_ref.collection_uid.as_str();
            if invitation_by_collection.contains_key(uid) {
                continue;
            }
            // No pending invitation — is it a collection we can already reach
            // (accepted in a prior partial run)? A successful fetch means yes.
            if cm
                .fetch(uid, None)
                .map(|fetched| !fetched.is_deleted())
                .unwrap_or(false)
            {
                member_part_uids.push(collection_ref.collection_uid.clone());
            }
        }
        let mut satisfiable_uids: HashSet<&str> =
            invitation_by_collection.keys().copied().collect();
        for uid in &member_part_uids {
            satisfiable_uids.insert(uid.as_str());
        }
        let missing = unsatisfiable_required_parts(&manifest, &satisfiable_uids);
        if !missing.is_empty() {
            return Err(AppError::InvalidArg(format!(
                "This shared folder is incomplete (missing {}); ask the owner to share it again.",
                format_parts(&missing)
            )));
        }

        for collection_ref in &manifest.collections {
            let Some(part_invitation) =
                invitation_by_collection.get(collection_ref.collection_uid.as_str())
            else {
                // Already accepted (gone from the incoming list) — nothing to do.
                continue;
            };
            let Some(signed) = find_incoming_invitation(&inv_manager, &part_invitation.id)? else {
                continue;
            };
            inv_manager.accept(&signed).map_err(|e| {
                AppError::InvalidArg(format!("accept {:?} invitation: {e}", collection_ref.part))
            })?;
        }

        // No local placeholder: the scoped sync pulls the real shared subtree
        // (the sender's own folder/note ids, stamped with this scope) into the
        // tree on the next sync, and the orphan-reparent pass lands the shared
        // root at the tree root. Creating a placeholder here would collide with
        // that real root once it arrives.

        Ok::<(), AppError>(())
    })
    .await
    .map_err(|e| format!("accept share bundle task: {e}"))?
    .map_err(Into::into)
}

/// Decline a share bundle: reject every still-pending referenced invitation and
/// leave the auto-accepted manifest collection so the transparent accept is
/// fully undone and the bundle stops reappearing on the next scan.
#[tauri::command]
pub async fn decline_share_bundle(
    app: AppHandle,
    manifest_collection_uid: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = restore_required(&app)?;
        let inv_manager = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?;
        let cm = account
            .collection_manager()
            .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;

        // Read the manifest straight from its (already-accepted) collection so
        // decline has no accept side effect. If it isn't fetchable the manifest
        // invitation may still be pending — reject that and stop.
        let col = match cm.fetch(&manifest_collection_uid, None) {
            Ok(col) if !col.is_deleted() => col,
            other => {
                if let Err(e) = other {
                    log::warn!(
                        "[sharing] fetch manifest {manifest_collection_uid} to decline: {e}"
                    );
                }
                let invitations = list_all_incoming(&inv_manager)?;
                if let Some(pending_manifest) = invitations.iter().find(|invitation| {
                    invitation.collection_uid == manifest_collection_uid
                        && invitation.collection_type.as_deref()
                            == Some(COLLECTION_TYPE_SHARE_MANIFEST)
                }) {
                    if let Some(signed) =
                        find_incoming_invitation(&inv_manager, &pending_manifest.id)?
                    {
                        inv_manager.reject(&signed).map_err(|e| {
                            AppError::InvalidArg(format!("reject manifest invitation: {e}"))
                        })?;
                    }
                }
                return Ok(());
            }
        };
        let manifest = decode_manifest(&col)?;

        let invitations = list_all_incoming(&inv_manager)?;
        let invitation_by_collection: HashMap<&str, &CollectionInvitation> = invitations
            .iter()
            .map(|invitation| (invitation.collection_uid.as_str(), invitation))
            .collect();

        for collection_ref in &manifest.collections {
            let Some(part_invitation) =
                invitation_by_collection.get(collection_ref.collection_uid.as_str())
            else {
                continue;
            };
            if let Some(signed) = find_incoming_invitation(&inv_manager, &part_invitation.id)? {
                inv_manager.reject(&signed).map_err(|e| {
                    AppError::InvalidArg(format!(
                        "reject {:?} invitation: {e}",
                        collection_ref.part
                    ))
                })?;
            }
        }

        // Leave the manifest collection last; a failure here is non-fatal (the
        // part invitations are already rejected) but is worth surfacing in logs.
        let member_manager = cm
            .member_manager(&col)
            .map_err(|e| AppError::InvalidArg(format!("member_manager: {e}")))?;
        if let Err(e) = member_manager.leave() {
            log::warn!("[sharing] leave manifest collection {manifest_collection_uid}: {e}");
        }

        Ok::<(), AppError>(())
    })
    .await
    .map_err(|e| format!("decline share bundle task: {e}"))?
    .map_err(Into::into)
}
