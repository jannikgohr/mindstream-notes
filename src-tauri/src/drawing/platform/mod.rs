//! Per-platform `SurfaceSource` + input bridge implementations.
//!
//! Each submodule is cfg-gated to its target OS and owns:
//!   - the platform's `SurfaceSource` concrete type (the
//!     raw-window-handle wrapper), and
//!   - the platform's input bridge (JNI exports on Android, winit
//!     event-loop integration on desktop, UIKit delegate on iOS).
//!
//! Cross-platform code (`crate::drawing::render` /
//! `crate::drawing::pipeline`) only sees `Box<dyn SurfaceSource>` +
//! `crate::drawing::input::Sample`; the per-platform glue is
//! responsible for constructing those.
//!
//! Today only `android` exists. When the desktop port (E1) and iOS
//! port (E2) land, they slot in here as `desktop.rs` / `ios.rs` with
//! matching cfg gates — `mod.rs` and the cross-platform consumers
//! stay untouched.

#[cfg(target_os = "android")]
pub mod android;
