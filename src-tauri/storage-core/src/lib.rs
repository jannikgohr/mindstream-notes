//! Storage code shared by the Tauri app and the browser SQLite proof.
pub mod asset_hash;
pub mod error;
pub mod migrations;
pub mod notes;
#[cfg(any(test, feature = "storage-proof"))]
pub mod proof;
pub mod search;
pub mod serde_helpers;
pub mod tags_crdt;
pub mod yrs_doc;
