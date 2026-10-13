//! Wire types for the sharing layer: access levels, what the UI is told
//! about a share, and the manifest a shared collection carries.

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

/// An invitation to a shared folder that has not been answered.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct IncomingShare {
    pub invitation_id: String,
    /// The shared collection. Once accepted it is the `share_scope_id` of
    /// every row the folder holds.
    pub collection_uid: String,
    /// The folder's name. Missing when the server did not send the
    /// collection's item along, which only an older server does.
    pub name: Option<String>,
    pub sender_username: Option<String>,
    pub access_level: ShareAccessLevel,
    /// The sender's key, held against the one this device remembers for
    /// them. Missing when the invitation names no sender.
    pub sender_key: Option<UserKey>,
}

/// An invitation this account sent that has not been answered.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct OutgoingInvitation {
    pub id: String,
    pub username: String,
    pub access_level: ShareAccessLevel,
}

#[derive(Debug, Clone, Deserialize)]
pub struct InviteCollectionInput {
    pub collection_id: String,
    pub username: String,
    pub access_level: ShareAccessLevel,
    /// The user has seen that the recipient's key is not the one this
    /// device remembers, and said to share with the new one.
    #[serde(default)]
    pub trust_changed_key: bool,
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
    pub outgoing_invitations: Vec<OutgoingInvitation>,
}

/// What a shared collection says about itself, kept as the collection's own
/// content. The folder's name is not here: it is the collection's name, in
/// its metadata, where someone invited can read it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShareManifest {
    pub schema: u32,
    /// The local id of the folder at the top of what is shared. Ids travel
    /// with the rows, so it names the same folder on every device.
    pub root_folder_id: String,
    #[serde(default)]
    pub owner_username: Option<String>,
    /// Raised when a member is removed or loses the right to write. Live
    /// sessions mix it and the salt into their keys.
    #[serde(default = "default_collab_epoch")]
    pub collab_epoch: u64,
    #[serde(default, with = "serde_bytes")]
    pub collab_salt: Vec<u8>,
}

/// What a live session in a shared folder needs from the folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ShareScopeCollabInfo {
    pub collab_epoch: u64,
    pub collab_salt: Vec<u8>,
}

pub(super) fn default_collab_epoch() -> u64 {
    1
}

pub(super) fn fresh_collab_salt() -> Vec<u8> {
    randombytes(SHARE_COLLAB_SALT_BYTES)
}
