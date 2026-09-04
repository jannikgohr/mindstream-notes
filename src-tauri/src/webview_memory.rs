//! Hand memory back to Windows while the app is out of sight.
//!
//! The app is built to live in the tray: closing the window hides it
//! rather than quitting (see the `CloseRequested` handler in `lib.rs`),
//! and `start in tray` is a supported launch mode. A hidden window still
//! carries the whole WebView2 tree — measured at ~103 MB of private
//! working set minimised, against a ~67 MB floor for the same binary
//! showing a blank page — because Chromium's own backgrounding only
//! trims what it considers safe for a tab it might have to repaint at
//! any moment.
//!
//! WebView2 exposes the switch for exactly this case:
//! `ICoreWebView2_19::SetMemoryUsageTargetLevel`. `LOW` tells it the
//! host does not need snappy repaints right now, so it may release
//! caches and decommit what it can; `NORMAL` restores the usual
//! behaviour. Microsoft's guidance is to set `LOW` when the webview is
//! hidden and `NORMAL` before showing it again, which is what
//! [`sync_to_visibility`] does.
//!
//! Everything here is Windows-only and best-effort. The interface
//! arrived in WebView2 runtime 1.0.1722.45; on anything older the cast
//! fails and we simply leave the level alone.

use std::sync::atomic::{AtomicU8, Ordering};

use tauri::{Manager, Runtime, WebviewWindow};

#[cfg(target_os = "windows")]
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
};
#[cfg(target_os = "windows")]
use windows_core::Interface;

/// Label of the window this applies to. Popout note windows are
/// short-lived and always visible while they exist, so they are left
/// alone.
const MAIN: &str = "main";

/// Last level handed to WebView2: 0 = unknown, 1 = normal, 2 = low.
///
/// `Resized` fires on every frame of a drag-resize, so without this the
/// main thread would take a COM round trip per frame to re-assert a
/// level it is already at. One process, one main window, so a plain
/// atomic is the whole story.
static APPLIED: AtomicU8 = AtomicU8::new(0);

/// Is the window currently out of sight — hidden to the tray, or
/// minimised to the taskbar?
///
/// Split out from the FFI so the policy is readable (and so a query
/// that fails is treated as "visible", never as an excuse to throttle a
/// window the user is looking at).
fn is_out_of_sight<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    let visible = window.is_visible().unwrap_or(true);
    let minimized = window.is_minimized().unwrap_or(false);
    !visible || minimized
}

/// Point the webview's memory target at whatever the window's current
/// visibility calls for.
///
/// Safe to call as often as you like — repeat calls for a level already
/// applied return without touching the webview, so callers do not have
/// to track edges themselves.
pub fn sync_to_visibility<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    let low = is_out_of_sight(&window);
    let want = if low { 2 } else { 1 };
    if APPLIED.swap(want, Ordering::Relaxed) == want {
        return;
    }
    apply(&window, low);
}

#[cfg(target_os = "windows")]
fn apply<R: Runtime>(window: &WebviewWindow<R>, low: bool) {
    let level = if low {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
    } else {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
    };

    // `with_webview` hops to the main thread, so this returns before the
    // level is actually set. Nothing depends on the ordering: the only
    // observable effect is how eagerly WebView2 releases caches.
    let result = window.with_webview(move |platform| {
        // SAFETY: `controller()` hands back a live COM pointer owned by
        // wry for the lifetime of the webview, and this closure runs on
        // the thread that owns it. Every call is checked; a runtime too
        // old to implement ICoreWebView2_19 fails the cast and we do
        // nothing.
        unsafe {
            let controller = platform.controller();
            let Ok(core) = controller.CoreWebView2() else {
                return;
            };
            let Ok(v19) = core.cast::<ICoreWebView2_19>() else {
                log::debug!("[webview-memory] runtime predates ICoreWebView2_19; skipping");
                return;
            };
            if let Err(err) = v19.SetMemoryUsageTargetLevel(level) {
                log::debug!("[webview-memory] set target level: {err}");
            }
        }
    });

    if let Err(err) = result {
        log::debug!("[webview-memory] with_webview: {err}");
    }
}

/// Non-Windows platforms have no equivalent knob; WKWebView and
/// WebKitGTK manage this themselves.
#[cfg(not(target_os = "windows"))]
fn apply<R: Runtime>(_window: &WebviewWindow<R>, _low: bool) {}
