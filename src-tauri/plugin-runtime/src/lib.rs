//! Sandboxed plugin execution for Mindstream Notes.
//!
//! A plugin's code is untrusted. This crate holds what decides what that code
//! can reach, separate from the app so it builds without Tauri:
//!
//! - [`host`]: the capabilities a call can use, each checked against the
//!   permissions the user granted. Every runtime goes through these, so the
//!   checks exist once.
//! - [`limits`]: memory and time bounds, and the budget that credits native
//!   tool time back to the script without extending the call forever.
//! - [`cancel`]: stopping a running call from outside it.
//! - [`paths`] and [`process`]: containment for storage paths, and running a
//!   declared native tool directly, never through a shell.
//! - [`wasm`]: the WebAssembly component runtime, with compiled-component
//!   caching, memory caps, deadlines and cancellation.
//!
//! None of it performs a note write. A plugin returns data and declarative
//! effects, and the app acts on them.

pub mod cancel;
pub mod dates;
pub mod error;
pub mod host;
pub mod limits;
pub mod markdown;
pub mod paths;
pub mod process;
pub mod wasm;

pub use error::{HostError, HostResult};
