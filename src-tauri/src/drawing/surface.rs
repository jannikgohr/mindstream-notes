//! Cross-platform surface source for wgpu.
//!
//! Today this file only contains the Android `AndroidWindow` wrapper
//! around `ANativeWindow*`. The seam is in place for the next
//! refactor pass (R3 in the roadmap) where this becomes a
//! `SurfaceSource` trait with one impl per platform (Android,
//! desktop via winit/wry, iOS via UIKit). The render pipeline
//! already only touches surface sources through the `raw-window-handle`
//! traits so the trait extraction is mechanical when we need it.

use std::ptr::NonNull;

use raw_window_handle::{
    AndroidDisplayHandle, AndroidNdkWindowHandle, DisplayHandle, HandleError, HasDisplayHandle,
    HasWindowHandle, RawDisplayHandle, RawWindowHandle, WindowHandle,
};

/// Owns an `ANativeWindow*` and implements the raw-handle traits
/// wgpu needs to build a Surface. Drop releases the window
/// reference, balancing the `ANativeWindow_acquire` (or the
/// equivalent `ANativeWindow_fromSurface` call on the JNI side)
/// that produced the pointer in the first place.
pub struct AndroidWindow {
    inner: NonNull<ndk_sys::ANativeWindow>,
}

// SAFETY: The pointer is `Send` once we own the reference — wgpu
// shuttles the surface across threads internally even though we
// only touch it from the render thread.
unsafe impl Send for AndroidWindow {}
unsafe impl Sync for AndroidWindow {}

impl AndroidWindow {
    /// Wrap an `ANativeWindow*` that the caller has already acquired
    /// (typically via `ANativeWindow_fromSurface`, which increments
    /// the reference count). `Drop` balances the acquire by calling
    /// `ANativeWindow_release`.
    pub fn new(inner: NonNull<ndk_sys::ANativeWindow>) -> Self {
        Self { inner }
    }
}

impl HasWindowHandle for AndroidWindow {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let raw = RawWindowHandle::AndroidNdk(AndroidNdkWindowHandle::new(self.inner.cast()));
        // SAFETY: `self.inner` is a valid ANativeWindow* held alive
        // by this struct (released only in `Drop`), so the borrow is
        // valid for as long as `&self` is.
        Ok(unsafe { WindowHandle::borrow_raw(raw) })
    }
}

impl HasDisplayHandle for AndroidWindow {
    fn display_handle(&self) -> Result<DisplayHandle<'_>, HandleError> {
        let raw = RawDisplayHandle::Android(AndroidDisplayHandle::new());
        // SAFETY: Android's display handle is unit / has no associated
        // resource, so any lifetime is sound.
        Ok(unsafe { DisplayHandle::borrow_raw(raw) })
    }
}

impl Drop for AndroidWindow {
    fn drop(&mut self) {
        // SAFETY: `inner` was obtained via `ANativeWindow_fromSurface`
        // which acquires a reference; releasing exactly once balances
        // that acquire.
        unsafe { ndk_sys::ANativeWindow_release(self.inner.as_ptr()) };
    }
}
