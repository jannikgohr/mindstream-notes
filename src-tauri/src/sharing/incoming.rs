//! Assembling incoming invitations into manifest-backed bundles.
//!
//! The pure grouping logic ([`assemble_incoming_share_bundles`] and
//! [`bundle_incoming_share_invitations`]) is deliberately free of any
//! Etebase calls so it can be unit-tested directly.

use super::*;

pub(super) fn restore_required(app: &AppHandle) -> AppResult<Account> {
    crate::auth::try_restore(app)
        .map_err(|e| AppError::InvalidArg(format!("restore session: {e}")))?
        .ok_or_else(|| AppError::InvalidArg("not signed in".into()))
}

pub(super) fn list_all_incoming(
    manager: &etebase::managers::CollectionInvitationManager,
) -> AppResult<Vec<CollectionInvitation>> {
    let mut out = Vec::new();
    let mut iterator: Option<String> = None;
    loop {
        let options = FetchOptions::new().limit(100).iterator(iterator.as_deref());
        let page = manager
            .list_incoming(Some(&options))
            .map_err(|e| AppError::InvalidArg(format!("list incoming invitations: {e}")))?;
        out.extend(page.data().iter().map(|invitation| {
            manager
                .preview(invitation)
                .map(CollectionInvitation::from)
                .unwrap_or_else(|_| CollectionInvitation::from(invitation))
        }));
        if page.done() {
            break;
        }
        let Some(next) = page.iterator().map(str::to_string) else {
            break;
        };
        iterator = Some(next);
    }
    Ok(out)
}

/// The manifests the account is already a member of — its "opened" shares —
/// read straight from the collection list. Nothing is accepted here: a manifest
/// only becomes a member collection once the user has explicitly accepted its
/// bundle, so the passive scan never mutates server state.
///
/// A decode failure for one manifest is logged and skipped rather than failing
/// the whole listing, so a single malformed share can't hide every other one.
///
/// `current_username` is the signed-in user: manifests they own are dropped so a
/// sender never sees their own outgoing shares surface as incoming bundles
/// (they're a member of the manifest collections they created). Case-insensitive
/// to match the self-invite guard in `invite_collection`.
pub(super) fn collect_opened_manifests(
    cm: &CollectionManager,
    current_username: Option<&str>,
) -> AppResult<Vec<ShareManifestPreview>> {
    let list = match cm.list(COLLECTION_TYPE_SHARE_MANIFEST, None) {
        Ok(list) => list,
        Err(e) => {
            log::warn!("[sharing] list manifest collections failed: {e}");
            return Ok(Vec::new());
        }
    };

    let mut previews = Vec::new();
    for col in list.data() {
        if col.is_deleted() {
            continue;
        }
        let uid = col.uid().to_string();
        let manifest = match decode_manifest(col) {
            Ok(manifest) => manifest,
            Err(e) => {
                log::warn!("[sharing] accepted manifest {uid} skipped: {e}");
                continue;
            }
        };
        let owned_by_me = current_username.is_some_and(|me| {
            manifest
                .owner_username
                .as_deref()
                .is_some_and(|owner| owner.eq_ignore_ascii_case(me))
        });
        if owned_by_me {
            continue;
        }
        // No pending invitation for an already-accepted manifest, so the
        // manifest collection uid stands in as the id. The bundle still surfaces
        // sender/access by falling back to a referenced part invitation (see
        // build_incoming_share_bundle).
        previews.push(ShareManifestPreview {
            invitation_id: uid.clone(),
            manifest_collection_uid: uid,
            manifest,
        });
    }
    Ok(previews)
}

/// Assemble the incoming-share view from the raw invitations and the manifests
/// the account has already opened (accepted, so readable in full).
///
///   * opened manifests → rich bundles (name, parts) via
///     `bundle_incoming_share_invitations`, minus any whose parts are all
///     accepted already (nothing left to do — stops fully-accepted shares from
///     lingering as notifications).
///   * pending manifest invitations (a `share_manifest` invite we haven't
///     accepted, so not among the opened manifests) → lightweight preview
///     bundles the user can accept or decline without content being read.
pub fn assemble_incoming_share_bundles(
    invitations: Vec<CollectionInvitation>,
    opened: Vec<ShareManifestPreview>,
) -> IncomingShareInvitations {
    let opened_uids: HashSet<&str> = opened
        .iter()
        .map(|preview| preview.manifest_collection_uid.as_str())
        .collect();

    let pending_bundles: Vec<IncomingShareBundle> = invitations
        .iter()
        .filter(|invitation| {
            invitation.collection_type.as_deref() == Some(COLLECTION_TYPE_SHARE_MANIFEST)
                && !opened_uids.contains(invitation.collection_uid.as_str())
        })
        .map(pending_bundle_from_invitation)
        .collect();

    let mut result = bundle_incoming_share_invitations(invitations, opened);
    result
        .bundles
        .retain(|bundle| bundle.parts.iter().any(|part| part.invitation.is_some()));
    result.bundles.extend(pending_bundles);
    result
}

/// A manifest is stored as the manifest collection's own JSON content (not as
/// items inside it), so decoding is content-bytes → serde_json.
pub(super) fn decode_manifest(col: &Collection) -> AppResult<ShareManifest> {
    let raw = col
        .content()
        .map_err(|e| AppError::InvalidArg(format!("manifest content: {e}")))?;
    serde_json::from_slice(&raw)
        .map_err(|e| AppError::InvalidArg(format!("decode manifest json: {e}")))
}

pub fn bundle_incoming_share_invitations(
    invitations: Vec<CollectionInvitation>,
    manifests: Vec<ShareManifestPreview>,
) -> IncomingShareInvitations {
    let invitation_by_id: HashMap<&str, &CollectionInvitation> = invitations
        .iter()
        .map(|invitation| (invitation.id.as_str(), invitation))
        .collect();
    let invitation_by_collection_uid: HashMap<&str, &CollectionInvitation> = invitations
        .iter()
        .map(|invitation| (invitation.collection_uid.as_str(), invitation))
        .collect();

    let manifest_invitation_ids: HashSet<String> = manifests
        .iter()
        .map(|preview| preview.invitation_id.clone())
        .collect();
    let referenced_collection_uids: HashSet<String> = manifests
        .iter()
        .flat_map(|preview| {
            preview
                .manifest
                .collections
                .iter()
                .map(|collection| collection.collection_uid.clone())
        })
        .collect();

    let bundles = manifests
        .into_iter()
        .map(|preview| {
            let manifest_invitation = invitation_by_id.get(preview.invitation_id.as_str());
            build_incoming_share_bundle(
                preview,
                manifest_invitation.copied(),
                &invitation_by_collection_uid,
            )
        })
        .collect();

    let unbundled_invitations = invitations
        .iter()
        .filter(|invitation| !manifest_invitation_ids.contains(invitation.id.as_str()))
        .filter(|invitation| {
            !referenced_collection_uids.contains(invitation.collection_uid.as_str())
        })
        // Share-scope collection types are internal plumbing and only make sense
        // inside a bundle. Drop them from the lone-invite list so the parts of an
        // unopened manifest (whose content we haven't read, so they aren't in
        // `referenced_collection_uids`) don't surface as standalone invites.
        .filter(|invitation| !is_share_scope_collection_type(invitation.collection_type.as_deref()))
        .cloned()
        .collect();

    IncomingShareInvitations {
        bundles,
        unbundled_invitations,
    }
}

pub(super) fn build_incoming_share_bundle(
    preview: ShareManifestPreview,
    manifest_invitation: Option<&CollectionInvitation>,
    invitation_by_collection_uid: &HashMap<&str, &CollectionInvitation>,
) -> IncomingShareBundle {
    let manifest = preview.manifest;
    let refs_by_part: HashMap<ShareScopePart, &ShareManifestCollectionRef> = manifest
        .collections
        .iter()
        .map(|collection| (collection.part, collection))
        .collect();
    let mut complete = true;
    let mut warnings = Vec::new();
    let mut parts = Vec::new();

    for part in [
        ShareScopePart::Folders,
        ShareScopePart::Notes,
        ShareScopePart::Assets,
    ] {
        let expected_collection_type = part.collection_type().to_string();
        let collection_ref = refs_by_part.get(&part).copied();
        if collection_ref.is_none() {
            complete = false;
            warnings.push(format!("manifest is missing required {part:?} collection"));
        }

        let invitation = collection_ref
            .and_then(|collection| {
                invitation_by_collection_uid.get(collection.collection_uid.as_str())
            })
            .copied()
            .cloned();

        if collection_ref.is_some() && invitation.is_none() {
            complete = false;
            warnings.push(format!(
                "missing invitation for required {part:?} collection"
            ));
        }

        if let Some(invitation) = invitation.as_ref() {
            if let Some(collection_type) = invitation.collection_type.as_deref() {
                if collection_type != expected_collection_type {
                    complete = false;
                    warnings.push(format!(
                        "{part:?} invitation has collection type {collection_type}"
                    ));
                }
            } else {
                warnings.push(format!("{part:?} invitation collection type is unknown"));
            }
        }

        parts.push(IncomingShareBundlePart {
            part,
            collection_uid: collection_ref.map(|collection| collection.collection_uid.clone()),
            expected_collection_type,
            required: collection_ref
                .map(|collection| collection.required)
                .unwrap_or(true),
            invitation,
        });
    }

    // The manifest invitation carries sender/access, but once it's been
    // auto-accepted it's gone from the incoming list — fall back to a
    // referenced part invitation, which shares the same sender and (by our
    // share-creation policy) the same access level.
    let fallback_invitation = parts.iter().find_map(|part| part.invitation.as_ref());
    let sender_username = manifest_invitation
        .and_then(|invitation| invitation.sender_username.clone())
        .or_else(|| fallback_invitation.and_then(|invitation| invitation.sender_username.clone()));
    let access_level = manifest_invitation
        .map(|invitation| invitation.access_level)
        .or_else(|| fallback_invitation.map(|invitation| invitation.access_level));

    IncomingShareBundle {
        manifest_invitation_id: preview.invitation_id,
        manifest_collection_uid: preview.manifest_collection_uid,
        pending: false,
        share_scope_id: Some(manifest.share_scope_id),
        name: Some(manifest.name),
        root_folder_id: Some(manifest.root_folder_id),
        owner_username: manifest.owner_username,
        sender_username,
        access_level,
        complete,
        parts,
        warnings,
    }
}

/// Build a lightweight bundle for a manifest invitation the scan has *not*
/// accepted. Preview metadata (sender, access, manifest collection uid) is all
/// we have without membership, so the name and parts stay unknown until the
/// user explicitly accepts. `complete` is `true` so the UI can offer accept —
/// accepting reads the manifest content and pulls in whatever parts it lists.
pub(super) fn pending_bundle_from_invitation(
    invitation: &CollectionInvitation,
) -> IncomingShareBundle {
    IncomingShareBundle {
        manifest_invitation_id: invitation.id.clone(),
        manifest_collection_uid: invitation.collection_uid.clone(),
        pending: true,
        share_scope_id: None,
        name: None,
        root_folder_id: None,
        owner_username: None,
        sender_username: invitation.sender_username.clone(),
        access_level: Some(invitation.access_level),
        complete: true,
        parts: Vec::new(),
        warnings: Vec::new(),
    }
}

pub(super) fn find_incoming_invitation(
    manager: &etebase::managers::CollectionInvitationManager,
    id: &str,
) -> AppResult<Option<SignedInvitation>> {
    let mut iterator: Option<String> = None;
    loop {
        let options = FetchOptions::new().limit(100).iterator(iterator.as_deref());
        let page = manager
            .list_incoming(Some(&options))
            .map_err(|e| AppError::InvalidArg(format!("list incoming invitations: {e}")))?;
        if let Some(invitation) = page.data().iter().find(|invitation| invitation.uid() == id) {
            return Ok(Some(invitation.clone()));
        }
        if page.done() {
            return Ok(None);
        }
        let Some(next) = page.iterator().map(str::to_string) else {
            return Ok(None);
        };
        iterator = Some(next);
    }
}
