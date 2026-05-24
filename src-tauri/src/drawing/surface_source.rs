//! Cross-platform surface abstraction for the wgpu renderer.
//!
//! [`SurfaceSource`] is the trait the render pipeline (lives in
//! `crate::drawing::pipeline`) takes when it needs to build a
//! `wgpu::Surface`. Each platform's input layer provides its own
//! impl — Android wraps `ANativeWindow*` (see
//! `crate::drawing::platform::android::AndroidWindow`), a future
//! desktop layer will wrap winit's `Window`, and iOS will wrap a
//! `UIView`. The pipeline itself only sees the trait, so adding a
//! new platform is "ship a `SurfaceSource` impl" rather than "touch
//! every wgpu setup call site".
//!
//! Bounds:
//!   - `HasWindowHandle` + `HasDisplayHandle` are what wgpu's
//!     `SurfaceTargetUnsafe::RawHandle` needs to identify the
//!     native surface.
//!   - `Send` because the JNI / OS event thread builds the source
//!     and ships it across an mpsc channel to the render thread,
//!     which then owns it for the surface's lifetime.
//!   - No `Sync` — only the render thread accesses it after the
//!     channel hop, so there's no need.
//!
//! Host-buildable on purpose: the trait is pure types + lifetimes,
//! no platform-specific deps. Concrete impls (which DO have
//! platform deps) live behind `cfg(target_os = ...)` in the
//! `platform/` submodules.

use raw_window_handle::{HasDisplayHandle, HasWindowHandle};

/// Marker trait collecting the bounds wgpu + the channel hop need.
/// Blanket-impl'd, so any type that already satisfies the four
/// bounds is automatically a `SurfaceSource` — concrete impls
/// (`AndroidWindow`, future winit / UIKit wrappers) don't write
/// `impl SurfaceSource for X` directly.
pub trait SurfaceSource: HasWindowHandle + HasDisplayHandle + Send {}

impl<T> SurfaceSource for T where T: HasWindowHandle + HasDisplayHandle + Send {}
