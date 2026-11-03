//! Storage code shared by the Tauri app and the browser SQLite proof.
pub mod asset_hash;
pub mod assets;
pub mod backup;
pub mod collections;
pub mod content_stats;
pub mod demo_notes;
pub mod error;
pub mod history;
pub mod import;
pub mod migrations;
pub mod notes;
pub mod pdf_text;
#[cfg(any(test, feature = "storage-proof"))]
pub mod proof;
pub mod search;
pub mod serde_helpers;
pub mod sharing;
pub mod signatures;
pub mod tags_crdt;
pub mod tombstones;
pub mod trash;
pub mod tree_batch;
pub mod vault_api;
pub mod yrs_doc;
