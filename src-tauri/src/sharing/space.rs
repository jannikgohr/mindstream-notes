//! The shared collection itself: creating it, finding it again, reading and
//! rewriting its manifest, and the server calls made against it.
//!
//! A shared folder's scope id is the uid of its collection, so finding the
//! collection of a scope is one fetch by uid. Nothing is looked up through
//! a list of manifests, and nobody can put a second collection in front of
//! a scope by claiming its id.

use super::*;

/// Whether the server's answer to a fetch means the collection is not there
/// for this account, as opposed to the fetch not having worked. Leaving and
/// purging are decided on this, so anything that might be an outage must
/// not count.
pub(crate) fn fetch_says_gone(error: &etebase::error::Error) -> bool {
    matches!(
        error,
        etebase::error::Error::NotFound(_) | etebase::error::Error::PermissionDenied(_)
    )
}

/// Fetch the collection behind a scope. `None` means the server answered
/// and the answer was no: this account is not a member any more, or the
/// folder was unshared. Not having been able to ask is an error.
pub(crate) fn open_space(cm: &CollectionManager, scope: &str) -> AppResult<Option<Collection>> {
    match cm.fetch(scope, None) {
        Ok(collection) if collection.is_deleted() => Ok(None),
        Ok(collection) => Ok(Some(collection)),
        Err(e) if fetch_says_gone(&e) => Ok(None),
        Err(e) => Err(AppError::InvalidArg(format!(
            "fetch shared folder {scope}: {e}"
        ))),
    }
}

/// The collection of the scope a folder is in, or a fresh one. The `bool`
/// says whether it was created here.
pub(super) fn resolve_or_create_space(
    cm: &CollectionManager,
    folder: &crate::collections::Collection,
    existing_scope: Option<&str>,
    owner_username: Option<&str>,
) -> AppResult<(Collection, bool)> {
    if let Some(scope) = existing_scope {
        match open_space(cm, scope)? {
            Some(collection) => return Ok((collection, false)),
            None => log::warn!(
                "[sharing] folder {} is tagged with shared folder {scope}, which is gone; sharing it afresh",
                folder.id
            ),
        }
    }
    Ok((create_space(cm, folder, owner_username)?, true))
}

/// Create and upload the collection for a folder about to be shared.
pub(super) fn create_space(
    cm: &CollectionManager,
    folder: &crate::collections::Collection,
    owner_username: Option<&str>,
) -> AppResult<Collection> {
    let manifest = build_share_manifest(&folder.id, owner_username);
    let collection = cm
        .create(
            COLLECTION_TYPE_SHARED,
            &space_meta(&folder.name),
            &encode_manifest(&manifest)?,
        )
        .map_err(|e| AppError::InvalidArg(format!("create shared folder: {e}")))?;
    cm.upload(&collection, None)
        .map_err(|e| AppError::from_server("upload shared folder", e))?;
    Ok(collection)
}

fn space_meta(name: &str) -> ItemMetadata {
    let mut meta = ItemMetadata::new();
    meta.set_name(Some(name))
        .set_mtime(Some(Utc::now().timestamp_millis()));
    meta
}

/// The name a shared collection goes by, which is what an invitation shows.
pub(crate) fn space_name(collection: &Collection) -> Option<String> {
    collection
        .meta()
        .ok()
        .and_then(|meta| meta.name().map(str::to_string))
}

/// Rename a shared collection after its root folder. Only an admin can, and
/// only a rename that changes something is sent.
pub(crate) fn rename_space(
    cm: &CollectionManager,
    collection: &Collection,
    name: &str,
) -> AppResult<()> {
    if space_name(collection).as_deref() == Some(name) {
        return Ok(());
    }
    let mut renamed = collection.clone();
    renamed
        .set_meta(&space_meta(name))
        .map_err(|e| AppError::InvalidArg(format!("rename shared folder: {e}")))?;
    cm.upload(&renamed, None)
        .map_err(|e| AppError::InvalidArg(format!("upload shared folder name: {e}")))
}

pub(super) fn build_share_manifest(
    root_folder_id: &str,
    owner_username: Option<&str>,
) -> ShareManifest {
    ShareManifest {
        schema: SHARE_MANIFEST_SCHEMA,
        root_folder_id: root_folder_id.to_string(),
        owner_username: owner_username.map(str::to_string),
    }
}

fn encode_manifest(manifest: &ShareManifest) -> AppResult<Vec<u8>> {
    serde_json::to_vec(manifest).map_err(|e| AppError::InvalidArg(format!("encode manifest: {e}")))
}

/// The manifest is the collection's own content.
pub(crate) fn decode_manifest(collection: &Collection) -> AppResult<ShareManifest> {
    let raw = collection
        .content()
        .map_err(|e| AppError::InvalidArg(format!("manifest content: {e}")))?;
    serde_json::from_slice(&raw)
        .map_err(|e| AppError::InvalidArg(format!("decode manifest json: {e}")))
}

/// Every page of a list that is walked with an iterator.
pub(super) fn all_pages<T: Clone>(
    what: &str,
    mut page: impl FnMut(&FetchOptions) -> etebase::error::Result<etebase::IteratorListResponse<T>>,
) -> AppResult<Vec<T>> {
    let mut out = Vec::new();
    let mut iterator: Option<String> = None;
    loop {
        let options = FetchOptions::new().limit(100).iterator(iterator.as_deref());
        let response =
            page(&options).map_err(|e| AppError::InvalidArg(format!("list {what}: {e}")))?;
        out.extend(response.data().iter().cloned());
        if response.done() {
            return Ok(out);
        }
        match response.iterator().map(str::to_string) {
            Some(next) => iterator = Some(next),
            None => return Ok(out),
        }
    }
}

/// The members of a shared collection.
pub(super) fn list_members(
    cm: &CollectionManager,
    collection: &Collection,
) -> AppResult<Vec<CollectionMember>> {
    let members = cm
        .member_manager(collection)
        .map_err(|e| AppError::InvalidArg(format!("member_manager: {e}")))?;
    Ok(all_pages("members", |options| members.list(Some(options)))?
        .iter()
        .map(|member| CollectionMember {
            username: member.username().to_string(),
            access_level: member.access_level().into(),
        })
        .collect())
}

/// Whether `username` already belongs to the shared folder or has an
/// invitation to it waiting. Asked of this one collection, so it never
/// stands in the way of inviting the same person to another folder.
pub(super) fn recipient_already_on_space(
    invitations: &CollectionInvitationManager,
    cm: &CollectionManager,
    collection: &Collection,
    username: &str,
) -> AppResult<bool> {
    let invited = all_pages("outgoing invitations", |options| {
        invitations.list_outgoing(Some(options))
    })?
    .iter()
    .any(|invitation| {
        invitation.collection() == collection.uid()
            && invitation.username().eq_ignore_ascii_case(username)
    });
    if invited {
        return Ok(true);
    }
    Ok(list_members(cm, collection)?
        .iter()
        .any(|member| member.username.eq_ignore_ascii_case(username)))
}

/// Turn the server's answer to a profile lookup into something a person can
/// act on.
pub(super) fn profile_lookup_error(username: &str, err: &etebase::error::Error) -> AppError {
    if matches!(err, etebase::error::Error::NotFound(_)) {
        AppError::InvalidArg(format!(
            "No user named “{username}” was found. Check the spelling."
        ))
    } else {
        AppError::InvalidArg(format!("fetch recipient profile: {err}"))
    }
}
