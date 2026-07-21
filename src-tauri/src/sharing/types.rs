//! Wire types for the sharing layer: access levels, invitations, the
//! share manifest and the incoming-bundle shapes the UI consumes.

use super::*;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ShareAccessLevel {
    ReadOnly,
    ReadWrite,
    Admin,
}

impl From<CollectionAccessLevel> for ShareAccessLevel {
    fn from(value: CollectionAccessLevel) -> Self {
        match value {
            CollectionAccessLevel::ReadOnly => Self::ReadOnly,
            CollectionAccessLevel::ReadWrite => Self::ReadWrite,
            CollectionAccessLevel::Admin => Self::Admin,
        }
    }
}

impl From<ShareAccessLevel> for CollectionAccessLevel {
    fn from(value: ShareAccessLevel) -> Self {
        match value {
            ShareAccessLevel::ReadOnly => Self::ReadOnly,
            ShareAccessLevel::ReadWrite => Self::ReadWrite,
            ShareAccessLevel::Admin => Self::Admin,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CollectionInvitation {
    pub id: String,
    pub username: String,
    pub sender_username: Option<String>,
    pub collection_uid: String,
    pub access_level: ShareAccessLevel,
    pub collection_type: Option<String>,
}

impl From<&SignedInvitation> for CollectionInvitation {
    fn from(invitation: &SignedInvitation) -> Self {
        Self {
            id: invitation.uid().to_string(),
            username: invitation.username().to_string(),
            sender_username: invitation.sender_username().map(str::to_string),
            collection_uid: invitation.collection().to_string(),
            access_level: invitation.access_level().into(),
            collection_type: None,
        }
    }
}

impl From<InvitationPreview> for CollectionInvitation {
    fn from(preview: InvitationPreview) -> Self {
        Self {
            id: preview.uid().to_string(),
            username: preview.username().to_string(),
            sender_username: preview.sender_username().map(str::to_string),
            collection_uid: preview.collection_uid().to_string(),
            access_level: preview.access_level().into(),
            collection_type: Some(preview.collection_type().to_string()),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct InviteCollectionInput {
    pub collection_id: String,
    pub username: String,
    pub access_level: ShareAccessLevel,
}

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
#[derive(Debug, Clone, Deserialize)]
pub struct E2eIncompleteBundleInput {
    pub username: String,
    pub name: String,
    pub access_level: ShareAccessLevel,
}

#[cfg(feature = "e2e-data-dir")]
#[derive(Debug, Clone, Serialize)]
pub struct E2eIncompleteBundleResult {
    pub manifest_collection_uid: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CollectionMember {
    pub username: String,
    pub access_level: ShareAccessLevel,
}

#[derive(Debug, Clone, Serialize)]
pub struct CollectionShareState {
    pub collection_id: String,
    pub share_id: Option<String>,
    pub shared_role: Option<ShareAccessLevel>,
    pub shared_owner: Option<String>,
    pub shared_by_me: bool,
    pub members: Vec<CollectionMember>,
    pub outgoing_invitations: Vec<CollectionInvitation>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ShareScopePart {
    Folders,
    Notes,
    Assets,
}

impl ShareScopePart {
    pub(super) fn collection_type(self) -> &'static str {
        match self {
            ShareScopePart::Folders => COLLECTION_TYPE_SHARE_FOLDERS,
            ShareScopePart::Notes => COLLECTION_TYPE_SHARE_NOTES,
            ShareScopePart::Assets => COLLECTION_TYPE_SHARE_ASSETS,
        }
    }

    pub(super) fn label(self) -> &'static str {
        match self {
            ShareScopePart::Folders => "folders",
            ShareScopePart::Notes => "notes",
            ShareScopePart::Assets => "assets",
        }
    }
}

/// The three part collections every complete share scope must carry. `assets` is
/// permanently required so embedded images/PDFs/canvas assets never sync as
/// broken; a manifest missing any of these can never finish syncing for a
/// recipient (see the incomplete-bundle guards below).
pub(super) const REQUIRED_SHARE_PARTS: [ShareScopePart; 3] = [
    ShareScopePart::Folders,
    ShareScopePart::Notes,
    ShareScopePart::Assets,
];

/// Required parts a manifest does not reference at all. Empty ⇒ structurally
/// complete. Pure so both the invite-time assertion and the tests can call it;
/// matches the missing-ref logic in `build_incoming_share_bundle`.
pub(super) fn manifest_missing_required_parts(manifest: &ShareManifest) -> Vec<ShareScopePart> {
    REQUIRED_SHARE_PARTS
        .into_iter()
        .filter(|part| !manifest.collections.iter().any(|c| c.part == *part))
        .collect()
}

/// Required parts a recipient can't satisfy: either the manifest doesn't
/// reference the part, or it does but the referenced collection uid isn't in
/// `satisfiable_uids` (no pending invitation for it and not already a member).
/// Empty ⇒ the bundle is safe to accept. Pure → unit-testable without a server.
pub(super) fn unsatisfiable_required_parts(
    manifest: &ShareManifest,
    satisfiable_uids: &HashSet<&str>,
) -> Vec<ShareScopePart> {
    REQUIRED_SHARE_PARTS
        .into_iter()
        .filter(
            |part| match manifest.collections.iter().find(|c| c.part == *part) {
                None => true,
                Some(collection) => !satisfiable_uids.contains(collection.collection_uid.as_str()),
            },
        )
        .collect()
}

pub(super) fn format_parts(parts: &[ShareScopePart]) -> String {
    parts
        .iter()
        .map(|part| part.label())
        .collect::<Vec<_>>()
        .join(", ")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShareManifest {
    pub schema: u32,
    pub share_scope_id: String,
    pub name: String,
    pub root_folder_id: String,
    #[serde(default)]
    pub owner_username: Option<String>,
    /// Rotated when a member is removed. Used to derive live-collab room ids
    /// and passwords for all note items in this share scope.
    #[serde(default = "default_collab_epoch")]
    pub collab_epoch: u64,
    #[serde(default, with = "serde_bytes")]
    pub collab_salt: Vec<u8>,
    #[serde(default)]
    pub collections: Vec<ShareManifestCollectionRef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ShareScopeCollabInfo {
    pub notes_collection_uid: String,
    pub assets_collection_uid: String,
    pub collab_epoch: u64,
    pub collab_salt: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShareManifestCollectionRef {
    pub part: ShareScopePart,
    pub collection_uid: String,
    #[serde(default = "default_manifest_collection_required")]
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShareManifestPreview {
    pub invitation_id: String,
    pub manifest_collection_uid: String,
    pub manifest: ShareManifest,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct IncomingShareInvitations {
    pub bundles: Vec<IncomingShareBundle>,
    pub unbundled_invitations: Vec<CollectionInvitation>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct IncomingShareBundle {
    pub manifest_invitation_id: String,
    pub manifest_collection_uid: String,
    /// `true` while the manifest invitation is still pending — the scan hasn't
    /// accepted it (that only happens on explicit `accept_share_bundle`), so its
    /// content is unread and `name`/`share_scope_id`/`root_folder_id`/`parts`
    /// are unknown. The share can still be accepted or declined by uid.
    pub pending: bool,
    pub share_scope_id: Option<String>,
    pub name: Option<String>,
    pub root_folder_id: Option<String>,
    pub owner_username: Option<String>,
    pub sender_username: Option<String>,
    pub access_level: Option<ShareAccessLevel>,
    pub complete: bool,
    pub parts: Vec<IncomingShareBundlePart>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct IncomingShareBundlePart {
    pub part: ShareScopePart,
    pub collection_uid: Option<String>,
    pub expected_collection_type: String,
    pub required: bool,
    pub invitation: Option<CollectionInvitation>,
}

pub(super) fn default_manifest_collection_required() -> bool {
    true
}

pub(super) fn default_collab_epoch() -> u64 {
    1
}

pub(super) fn fresh_collab_salt() -> Vec<u8> {
    randombytes(SHARE_COLLAB_SALT_BYTES)
}

/// True for any of the four share-scope collection types (manifest + parts).
/// These are internal to a bundle and never surface as standalone invites.
pub(super) fn is_share_scope_collection_type(collection_type: Option<&str>) -> bool {
    matches!(
        collection_type,
        Some(
            COLLECTION_TYPE_SHARE_MANIFEST
                | COLLECTION_TYPE_SHARE_FOLDERS
                | COLLECTION_TYPE_SHARE_NOTES
                | COLLECTION_TYPE_SHARE_ASSETS
        )
    )
}
