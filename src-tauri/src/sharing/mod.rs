//! Collection sharing command layer.
//!
//! Etebase shares remote Collections. A shared folder scope is one manifest
//! collection (`mindstream.share_manifest`, whose content is the manifest JSON)
//! plus three required part collections — `mindstream.folders`,
//! `mindstream.notes`, `mindstream.assets`. Incoming invitations are grouped
//! into manifest-backed bundles (list/accept/decline); `invite_collection`
//! creates the scope collections + manifest and invites the recipient.
//!
//! Sharing a folder re-homes its subtree into the scope's collections: every
//! folder/note/asset under the root is stamped with `share_scope_id` and
//! detached from the vault-wide collections (see `rehome_folder_subtree`), and
//! `sync::scopes` then pushes/pulls each scope's dedicated collections so a
//! recipient receives the real content. Items created or moved into a shared
//! folder *after* the share exists inherit the scope at create/move time
//! (`collection_scope` lookups in `collections`/`notes`/`assets`), so they no
//! longer wait for the next `invite_collection` to be re-homed.

use std::collections::{HashMap, HashSet};

use chrono::Utc;
use etebase::managers::{CollectionInvitationManager, CollectionManager};
use etebase::utils::randombytes;
use etebase::{
    Account, Collection, CollectionAccessLevel, FetchOptions, InvitationPreview, ItemMetadata,
    SignedInvitation,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::db::Db;
use crate::error::{AppError, AppResult, CommandResult};

pub const COLLECTION_TYPE_SHARE_MANIFEST: &str = "mindstream.share_manifest";
pub const COLLECTION_TYPE_SHARE_FOLDERS: &str = "mindstream.folders";
pub const COLLECTION_TYPE_SHARE_NOTES: &str = "mindstream.notes";
pub const COLLECTION_TYPE_SHARE_ASSETS: &str = "mindstream.assets";
pub const SHARE_MANIFEST_SCHEMA: u32 = 2;
pub const SHARE_COLLAB_SALT_BYTES: usize = 32;

mod bundles;
mod incoming;
mod invite;
mod local_state;
mod members;
mod revoke;
mod scope;
mod types;

pub use bundles::*;
pub use incoming::*;
pub use invite::*;
pub(crate) use local_state::*;
pub use members::*;
pub use revoke::*;
pub(crate) use scope::*;
pub use types::*;

#[cfg(test)]
mod tests;
