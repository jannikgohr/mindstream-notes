//! Per-platform drawing bridge implementations.
//!
//! Android is a live-ink control bridge only: Kotlin owns the transient
//! front-buffer stroke and forwards canonical input to the WebView
//! canvas.

#[cfg(target_os = "android")]
pub mod android;
