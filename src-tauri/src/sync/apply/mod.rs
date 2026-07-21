//! Applying pulled remote items to local SQLite.
//!
//! One submodule per kind, each deciding how a remote payload meets the
//! local row: CRDT merge for notes and their tags, last-write-wins
//! metadata for folders, plain overwrite for assets and signatures. The
//! `*_payload` variants take a decoded payload rather than an etebase
//! `Item` so the merge rules can be unit-tested without a live account.

use super::*;

mod assets;
mod folders;
mod notes;
mod signatures;

pub(in crate::sync) use assets::*;
pub(in crate::sync) use folders::*;
pub(in crate::sync) use notes::*;
pub(in crate::sync) use signatures::*;

/// The etebase item type tag, or `None` for an item with no metadata type.
pub(in crate::sync) fn item_type(item: &Item) -> Option<String> {
    item.meta()
        .ok()
        .and_then(|meta| meta.item_type().map(str::to_string))
}
