//! Per-platform drawing bridge implementations.
//!
//! Android is now a live-ink control bridge only: Kotlin owns the
//! transient front-buffer stroke and forwards canonical input to the
//! WebView canvas.
//!
//! Desktop still has the legacy native-render event bridge while the
//! JS-canvas replacement is being validated.

#[cfg(target_os = "android")]
pub mod android;

#[cfg(desktop)]
pub mod desktop;
