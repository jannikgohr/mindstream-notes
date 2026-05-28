//! Shared ink-note core used by Android native rendering and the
//! desktop web-egui adapter.
//!
//! This crate deliberately excludes platform surfaces, Tauri commands,
//! Android JNI, native render threads, and persistence workers. Those
//! stay in the adapter crates/modules.

pub mod input;
pub mod page;
pub mod strokes_doc;
pub mod ui;
