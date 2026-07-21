//! Share-scope plumbing: resolving or creating the four collections that
//! make up a scope, validating them, and building/rotating the manifest.

use super::*;

/// The four collections that make up one share scope.
pub(super) struct ScopeCollections {
    pub(super) manifest: Collection,
    pub(super) folders: Collection,
    pub(super) notes: Collection,
    pub(super) assets: Collection,
    pub(super) share_scope_id: String,
}

/// Reuse the folder's existing scope (so re-sharing adds a member) or create a
/// fresh one. The `bool` is `true` when a new scope was created.
pub(super) fn resolve_or_create_scope(
    cm: &CollectionManager,
    folder: &crate::collections::Collection,
    existing_scope_id: Option<&str>,
    owner_username: Option<&str>,
) -> AppResult<(ScopeCollections, bool)> {
    if let Some(scope_id) = existing_scope_id {
        if let Some(scope) = find_existing_scope(cm, scope_id)? {
            return Ok((scope, false));
        }
        log::warn!(
            "[sharing] folder {} tagged scope {scope_id} but its manifest is gone; creating a fresh scope",
            folder.id
        );
    }
    Ok((create_new_scope(cm, folder, owner_username)?, true))
}

/// Find the scope whose manifest carries `share_scope_id` and fetch its four
/// collections. Returns `None` if no manifest matches (e.g. deleted server-side).
pub(super) fn find_existing_scope(
    cm: &CollectionManager,
    share_scope_id: &str,
) -> AppResult<Option<ScopeCollections>> {
    let list = cm
        .list(COLLECTION_TYPE_SHARE_MANIFEST, None)
        .map_err(|e| AppError::InvalidArg(format!("list manifest collections: {e}")))?;
    for col in list.data() {
        if col.is_deleted() {
            continue;
        }
        let manifest = match decode_manifest(col) {
            Ok(manifest) => manifest,
            Err(_) => continue,
        };
        if manifest.share_scope_id != share_scope_id {
            continue;
        }
        let folders = fetch_scope_part(cm, &manifest, ShareScopePart::Folders)?;
        let notes = fetch_scope_part(cm, &manifest, ShareScopePart::Notes)?;
        let assets = fetch_scope_part(cm, &manifest, ShareScopePart::Assets)?;
        return Ok(Some(ScopeCollections {
            manifest: col.clone(),
            folders,
            notes,
            assets,
            share_scope_id: manifest.share_scope_id,
        }));
    }
    Ok(None)
}

/// Lightweight resolver for live-collab room derivation. It only needs the
/// scope notes collection plus the manifest's rotating collab material.
/// Pick the one manifest that owns a scope, or refuse.
///
/// Split out from [`share_scope_collab_info`] so the policy is testable
/// without a live `CollectionManager`.
pub(super) fn select_scope_manifest(
    share_scope_id: &str,
    matches: Vec<(String, ShareManifest)>,
) -> AppResult<Option<ShareManifest>> {
    if matches.len() > 1 {
        let uids: Vec<&str> = matches.iter().map(|(uid, _)| uid.as_str()).collect();
        log::error!(
            "[sharing] {} manifests claim scope {share_scope_id} ({}) — refusing to resolve it",
            matches.len(),
            uids.join(", ")
        );
        return Err(AppError::InvalidArg(format!(
            "more than one share manifest claims scope {share_scope_id}; refusing to pick one"
        )));
    }
    Ok(matches.into_iter().next().map(|(_, manifest)| manifest))
}

pub(crate) fn share_scope_collab_info(
    cm: &CollectionManager,
    share_scope_id: &str,
) -> AppResult<Option<ShareScopeCollabInfo>> {
    let list = cm
        .list(COLLECTION_TYPE_SHARE_MANIFEST, None)
        .map_err(|e| AppError::InvalidArg(format!("list manifest collections: {e}")))?;

    // Collect every match rather than taking the first. A scope id is a uuid
    // an outsider can't guess, but every *member* of a scope knows theirs —
    // and anyone can create a collection and share it with you. So a member
    // can offer a second manifest claiming the same scope, carrying their own
    // collab salt and part-collection uids. Taking whichever the server
    // happened to list first would let them choose the room key.
    //
    // There is exactly one manifest per scope in normal operation, so treat a
    // second one as an attack (or corruption) and refuse to resolve the scope
    // at all. Failing closed costs live collab for that folder; guessing
    // costs the room.
    let mut matches = Vec::new();
    for col in list.data() {
        if col.is_deleted() {
            continue;
        }
        let manifest = match decode_manifest(col) {
            Ok(manifest) => manifest,
            Err(_) => continue,
        };
        if manifest.share_scope_id != share_scope_id {
            continue;
        }
        matches.push((col.uid().to_string(), manifest));
    }

    let Some(manifest) = select_scope_manifest(share_scope_id, matches)? else {
        return Ok(None);
    };
    let notes_collection_uid = manifest_part_uid(&manifest, ShareScopePart::Notes)
        .ok_or_else(|| AppError::InvalidArg("manifest missing notes collection".into()))?
        .to_string();
    let assets_collection_uid = manifest_part_uid(&manifest, ShareScopePart::Assets)
        .ok_or_else(|| AppError::InvalidArg("manifest missing assets collection".into()))?
        .to_string();
    Ok(Some(ShareScopeCollabInfo {
        notes_collection_uid,
        assets_collection_uid,
        collab_epoch: manifest.collab_epoch,
        collab_salt: manifest.collab_salt,
    }))
}

/// Assert the resolved scope is structurally complete before anyone is invited:
/// the manifest must reference all three required part collections. A fresh scope
/// from `create_new_scope` always is, but a *reused* legacy scope
/// (`existing_scope_id` from a pre-`assets` share) might not be — inviting into
/// it would strand the recipient with an unsyncable folder. Fail loudly instead.
pub(super) fn validate_scope_complete(scope: &ScopeCollections) -> AppResult<()> {
    let manifest = decode_manifest(&scope.manifest)?;
    let missing = manifest_missing_required_parts(&manifest);
    debug_assert!(
        missing.is_empty(),
        "share scope {} manifest missing required parts: {missing:?}",
        scope.share_scope_id
    );
    if !missing.is_empty() {
        return Err(AppError::InvalidArg(format!(
            "this shared folder's data is incomplete (missing {}); it can't be shared until that's repaired",
            format_parts(&missing)
        )));
    }
    Ok(())
}

pub(super) fn fetch_scope_part(
    cm: &CollectionManager,
    manifest: &ShareManifest,
    part: ShareScopePart,
) -> AppResult<Collection> {
    let uid = manifest_part_uid(manifest, part)
        .ok_or_else(|| AppError::InvalidArg(format!("manifest missing {part:?} collection")))?;
    cm.fetch(uid, None)
        .map_err(|e| AppError::InvalidArg(format!("fetch {part:?} collection: {e}")))
}

pub(super) fn manifest_part_uid(manifest: &ShareManifest, part: ShareScopePart) -> Option<&str> {
    manifest
        .collections
        .iter()
        .find(|collection| collection.part == part)
        .map(|collection| collection.collection_uid.as_str())
}

/// Create + upload the three part collections and the manifest collection that
/// ties them together.
pub(super) fn create_new_scope(
    cm: &CollectionManager,
    folder: &crate::collections::Collection,
    owner_username: Option<&str>,
) -> AppResult<ScopeCollections> {
    let share_scope_id = format!("scope_{}", uuid::Uuid::new_v4());
    let folders = create_share_collection(
        cm,
        COLLECTION_TYPE_SHARE_FOLDERS,
        &format!("{} — folders", folder.name),
        &[],
    )?;
    let notes = create_share_collection(
        cm,
        COLLECTION_TYPE_SHARE_NOTES,
        &format!("{} — notes", folder.name),
        &[],
    )?;
    let assets = create_share_collection(
        cm,
        COLLECTION_TYPE_SHARE_ASSETS,
        &format!("{} — assets", folder.name),
        &[],
    )?;
    let manifest = build_share_manifest(
        &share_scope_id,
        &folder.name,
        &folder.id,
        owner_username,
        folders.uid(),
        notes.uid(),
        assets.uid(),
    );
    let manifest_json = serde_json::to_vec(&manifest)
        .map_err(|e| AppError::InvalidArg(format!("encode manifest: {e}")))?;
    let manifest_col = create_share_collection(
        cm,
        COLLECTION_TYPE_SHARE_MANIFEST,
        &format!("{} — share", folder.name),
        &manifest_json,
    )?;
    Ok(ScopeCollections {
        manifest: manifest_col,
        folders,
        notes,
        assets,
        share_scope_id,
    })
}

/// True if `username` already has a pending invite to, or is a member of, this
/// scope — checked against the scope's collections so it never blocks an invite
/// to the same user for a *different* folder.
pub(super) fn recipient_already_on_scope(
    inv_manager: &CollectionInvitationManager,
    cm: &CollectionManager,
    scope: &ScopeCollections,
    username: &str,
) -> AppResult<bool> {
    let scope_uids = [
        scope.manifest.uid(),
        scope.folders.uid(),
        scope.notes.uid(),
        scope.assets.uid(),
    ];

    let mut iterator: Option<String> = None;
    loop {
        let options = FetchOptions::new().limit(100).iterator(iterator.as_deref());
        let page = inv_manager
            .list_outgoing(Some(&options))
            .map_err(|e| AppError::InvalidArg(format!("list outgoing invitations: {e}")))?;
        for invitation in page.data() {
            if invitation.username() == username && scope_uids.contains(&invitation.collection()) {
                return Ok(true);
            }
        }
        if page.done() {
            break;
        }
        match page.iterator().map(str::to_string) {
            Some(next) => iterator = Some(next),
            None => break,
        }
    }

    // Already-accepted members share the same three part collections; the
    // folders collection is enough to detect them.
    let member_manager = cm
        .member_manager(&scope.folders)
        .map_err(|e| AppError::InvalidArg(format!("member_manager: {e}")))?;
    let mut iterator: Option<String> = None;
    loop {
        let options = FetchOptions::new().limit(100).iterator(iterator.as_deref());
        let page = member_manager
            .list(Some(&options))
            .map_err(|e| AppError::InvalidArg(format!("list members: {e}")))?;
        for member in page.data() {
            if member.username() == username {
                return Ok(true);
            }
        }
        if page.done() {
            break;
        }
        match page.iterator().map(str::to_string) {
            Some(next) => iterator = Some(next),
            None => break,
        }
    }

    Ok(false)
}

/// Turn Etebase's opaque profile-lookup failure into an actionable message. A
/// brand-new account has no published `UserInfo` until it has signed in once.
pub(super) fn profile_lookup_error(username: &str, err: impl std::fmt::Display) -> AppError {
    let raw = err.to_string();
    if raw.contains("matching query does not exist") {
        AppError::InvalidArg(format!(
            "No user named “{username}” was found. Check the spelling — a brand-new account must sign in once before it can be invited."
        ))
    } else {
        AppError::InvalidArg(format!("fetch recipient profile: {raw}"))
    }
}

/// Create + upload one collection for a share scope. `content` is empty for the
/// part collections and the manifest JSON for the manifest collection.
pub(super) fn create_share_collection(
    cm: &CollectionManager,
    collection_type: &str,
    name: &str,
    content: &[u8],
) -> AppResult<Collection> {
    let mut meta = ItemMetadata::new();
    meta.set_name(Some(name))
        .set_mtime(Some(Utc::now().timestamp_millis()));
    let col = cm
        .create(collection_type, &meta, content)
        .map_err(|e| AppError::InvalidArg(format!("create {collection_type}: {e}")))?;
    cm.upload(&col, None)
        .map_err(|e| AppError::InvalidArg(format!("upload {collection_type}: {e}")))?;
    Ok(col)
}

pub(super) fn invite_to_collection(
    inv_manager: &CollectionInvitationManager,
    collection: &Collection,
    username: &str,
    pubkey: &[u8],
    access_level: CollectionAccessLevel,
) -> AppResult<()> {
    inv_manager
        .invite(collection, username, pubkey, access_level)
        .map_err(|e| {
            AppError::InvalidArg(format!("invite {username} to {}: {e}", collection.uid()))
        })
}

pub(super) fn rotate_scope_collab_secret(
    cm: &CollectionManager,
    manifest_col: &Collection,
) -> AppResult<ShareManifest> {
    let mut manifest = decode_manifest(manifest_col)?;
    rotate_manifest_collab_secret(&mut manifest);
    let manifest_json = serde_json::to_vec(&manifest)
        .map_err(|e| AppError::InvalidArg(format!("encode manifest: {e}")))?;
    let mut updated = manifest_col.clone();
    updated
        .set_content(&manifest_json)
        .map_err(|e| AppError::InvalidArg(format!("update manifest content: {e}")))?;
    cm.upload(&updated, None)
        .map_err(|e| AppError::InvalidArg(format!("upload rotated manifest: {e}")))?;
    Ok(manifest)
}

pub(super) fn rotate_manifest_collab_secret(manifest: &mut ShareManifest) {
    manifest.schema = SHARE_MANIFEST_SCHEMA;
    manifest.collab_epoch = manifest
        .collab_epoch
        .saturating_add(1)
        .max(default_collab_epoch());
    manifest.collab_salt = fresh_collab_salt();
}

/// Build the manifest that ties a scope's three part collections together. Pure
/// so it can be unit-tested without a server.
pub(super) fn build_share_manifest(
    share_scope_id: &str,
    name: &str,
    root_folder_id: &str,
    owner_username: Option<&str>,
    folders_uid: &str,
    notes_uid: &str,
    assets_uid: &str,
) -> ShareManifest {
    ShareManifest {
        schema: SHARE_MANIFEST_SCHEMA,
        share_scope_id: share_scope_id.to_string(),
        name: name.to_string(),
        root_folder_id: root_folder_id.to_string(),
        owner_username: owner_username.map(str::to_string),
        collab_epoch: default_collab_epoch(),
        collab_salt: fresh_collab_salt(),
        collections: vec![
            ShareManifestCollectionRef {
                part: ShareScopePart::Folders,
                collection_uid: folders_uid.to_string(),
                required: true,
            },
            ShareManifestCollectionRef {
                part: ShareScopePart::Notes,
                collection_uid: notes_uid.to_string(),
                required: true,
            },
            ShareManifestCollectionRef {
                part: ShareScopePart::Assets,
                collection_uid: assets_uid.to_string(),
                required: true,
            },
        ],
    }
}
