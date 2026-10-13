//! Sharing a folder.
//!
//! A shared folder is one collection on the server, of type
//! `mindstream.shared`. Its folders, notes and attachments are items in that
//! collection, told apart by the type in their metadata exactly as they are
//! in the vault. The collection's own metadata carries the folder's name,
//! which is what someone invited is shown before they answer. Its own
//! content is a small manifest: which folder is the root, who shared it,
//! and the material live sessions mix into their keys.
//!
//! So sharing is one invitation and one membership, and there is no state
//! in which someone holds part of a shared folder. An invite link is the
//! same invitation, addressed to whoever holds the link (see `links`).
//!
//! Locally a row belongs to a shared folder when its `share_scope_id` is
//! that collection's uid. Sharing a folder re-homes its subtree: every
//! folder, note and attachment under the root is stamped with the uid and
//! detached from the vault (see `rehome_folder_subtree`), and `sync::scopes`
//! then pushes and pulls each shared collection with that routing. Items
//! created in or moved into a shared folder later inherit the scope at that
//! moment (the `collection_scope` lookups in `collections`, `notes` and
//! `assets`).

use std::collections::HashSet;

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

/// The type of the one collection a shared folder is.
pub const COLLECTION_TYPE_SHARED: &str = "mindstream.shared";
pub const SHARE_MANIFEST_SCHEMA: u32 = 3;
pub const SHARE_COLLAB_SALT_BYTES: usize = 32;

mod incoming;
mod invite;
mod links;
mod local_state;
mod members;
mod permissions;
mod revoke;
mod space;
mod types;

pub use incoming::*;
pub use invite::*;
pub use links::*;
pub(crate) use local_state::*;
pub use members::*;
pub(crate) use permissions::*;
pub use revoke::*;
pub(crate) use space::*;
pub use types::*;

#[cfg(test)]
mod tests;
