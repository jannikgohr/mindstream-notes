//! Tell the webview when the app is off screen, and let it shrink.
//!
//! The app is built to live in the tray: closing the window hides it
//! rather than quitting (see the `CloseRequested` handler in `lib.rs`),
//! and `start in tray` is a supported launch mode.
//!
//! Two separate things have to happen for that to be cheap, and the app
//! was doing neither.
//!
//! **Visibility.** `Window::hide()` and minimising both hide the OS
//! window, but neither touches `ICoreWebView2Controller::IsVisible` --
//! wry only sets that from the webview-level show/hide, which nothing
//! here calls. So Chromium never learned the page was off screen:
//! measured with the window minimised, `document.visibilityState` stayed
//! `"visible"`. Timers kept their foreground rate, the compositor kept
//! working, and every page the memory trim below had just released was
//! faulted straight back in, so a tray-parked app climbed back to its
//! full resident size within the hour. Setting `IsVisible` is what makes
//! Chromium background the page properly, and it is also what makes
//! `visibilitychange` fire, which is what `$lib/editor/suspend-flush`
//! has always been waiting for to flush pending edits.
//!
//! **Memory level.** `ICoreWebView2_19::SetMemoryUsageTargetLevel` is
//! the switch Microsoft ships for a hidden webview: `LOW` lets it
//! release caches and decommit what it can, `NORMAL` restores ordinary
//! behaviour. Deferred by [`HIDE_GRACE`], because undoing it costs page
//! faults on the way back and a ten-second minimise should not pay them.
//!
//! Everything here is Windows-only and best-effort. `IsVisible` is on
//! the controller wry hands us; the memory level arrived in WebView2
//! runtime 1.0.1722.45, and on anything older that cast fails and only
//! the level is skipped.

use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::time::Duration;

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

/// What the webview should currently be told.
///
/// Three states rather than two because hiding happens in two steps: the
/// page is told immediately (cheap, instantly reversible), the memory is
/// released later (not free to undo -- see [`HIDE_GRACE`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Posture {
    /// On screen: visible, ordinary memory behaviour.
    Onscreen = 1,
    /// Off screen, recently: page backgrounded, memory untouched.
    Offscreen = 2,
    /// Off screen long enough to be worth reclaiming.
    Parked = 3,
}

/// Last posture applied, as a [`Posture`] discriminant; 0 means "unknown,
/// nothing applied yet".
///
/// `Resized` fires on every frame of a drag-resize, so without this the
/// main thread would take a COM round trip per frame to re-assert a
/// posture it is already in. One process, one main window, so plain
/// atomics are the whole story.
static APPLIED: AtomicU8 = AtomicU8::new(0);

/// How long the window has to stay out of sight before its memory is
/// released.
///
/// Dropping to LOW is not free to undo: WebView2 decommits pages, so the
/// first interactions after the window comes back fault them in again. For
/// a window parked in the tray all afternoon that is a good trade; for a
/// minimise-and-restore ten seconds later it is a pure loss, paid exactly
/// when the user is looking. The delay keeps the win and skips the churn.
const HIDE_GRACE: Duration = Duration::from_secs(20);

/// Bumped on every visibility change, so a delayed release can tell whether
/// the window it was scheduled for is still the current situation.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Is the window currently out of sight — hidden to the tray, or
/// minimised to the taskbar?
///
/// Split out from the FFI so the policy is readable (and so a query
/// that fails is treated as "visible", never as an excuse to throttle a
/// window the user is looking at).
fn is_out_of_sight_state(visible: Option<bool>, minimized: Option<bool>) -> bool {
    let visible = visible.unwrap_or(true);
    let minimized = minimized.unwrap_or(false);
    !visible || minimized
}

fn is_out_of_sight<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    is_out_of_sight_state(window.is_visible().ok(), window.is_minimized().ok())
}

fn immediate_posture(out_of_sight: bool) -> Posture {
    if out_of_sight {
        Posture::Offscreen
    } else {
        Posture::Onscreen
    }
}

fn should_park(scheduled_generation: u64, current_generation: u64, out_of_sight: bool) -> bool {
    scheduled_generation == current_generation && out_of_sight
}

/// Put the webview into whatever posture the window's current visibility
/// calls for.
///
/// Showing, and backgrounding the page, take effect at once; only the
/// memory release is deferred by [`HIDE_GRACE`], so a brief minimise does
/// not cost a round of page faults on the way back.
///
/// Safe to call as often as you like — repeat calls for a level already
/// applied return without touching the webview, so callers do not have
/// to track edges themselves.
pub fn sync_to_visibility<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    // Every call invalidates whatever parking was already scheduled.
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;

    let posture = immediate_posture(is_out_of_sight(&window));
    if posture == Posture::Onscreen {
        // Coming back is immediate: the user is waiting on this one, and
        // leaving `IsVisible` false would show them a blank window.
        set_posture(&window, posture);
        return;
    }

    // Backgrounding the page is immediate too. It costs nothing to undo,
    // and it is what stops the work that was refilling the working set.
    set_posture(&window, posture);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(HIDE_GRACE).await;
        // Shown again (or hidden again, which scheduled its own parking)
        // while we waited.
        let current_generation = GENERATION.load(Ordering::Relaxed);
        if generation != current_generation {
            return;
        }
        let Some(window) = app.get_webview_window(MAIN) else {
            return;
        };
        if should_park(generation, current_generation, is_out_of_sight(&window)) {
            set_posture(&window, Posture::Parked);
        }
    });
}

/// Apply a posture, skipping the COM calls when it is already in force.
fn set_posture<R: Runtime>(window: &WebviewWindow<R>, posture: Posture) {
    let want = posture as u8;
    if APPLIED.swap(want, Ordering::Relaxed) == want {
        return;
    }
    apply(window, posture);
}

#[cfg(target_os = "windows")]
fn apply<R: Runtime>(window: &WebviewWindow<R>, posture: Posture) {
    let visible = matches!(posture, Posture::Onscreen);
    let level = if matches!(posture, Posture::Parked) {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
    } else {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
    };

    // `with_webview` hops to the main thread, so this returns before
    // anything is set. Nothing depends on the ordering: the only
    // observable effects are whether the page believes it is on screen
    // and how eagerly WebView2 releases caches.
    let result = window.with_webview(move |platform| {
        // SAFETY: `controller()` hands back a live COM pointer owned by
        // wry for the lifetime of the webview, and this closure runs on
        // the thread that owns it. Every call is checked; a runtime too
        // old to implement ICoreWebView2_19 fails that cast and only the
        // memory level is skipped.
        unsafe {
            let controller = platform.controller();

            // Visibility first, and never skipped on the way back: a
            // webview left invisible under a shown window is a blank
            // window, which is the one failure here a user would call a
            // bug rather than a regression.
            if let Err(err) = controller.SetIsVisible(visible) {
                log::debug!("[webview-memory] set visible={visible}: {err}");
            }

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

/// Non-Windows platforms have no equivalent knobs; WKWebView and
/// WebKitGTK track window visibility themselves.
#[cfg(not(target_os = "windows"))]
fn apply<R: Runtime>(_window: &WebviewWindow<R>, _posture: Posture) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_or_minimized_windows_are_out_of_sight() {
        assert!(is_out_of_sight_state(Some(false), Some(false)));
        assert!(is_out_of_sight_state(Some(true), Some(true)));
        assert!(is_out_of_sight_state(Some(false), Some(true)));
        assert!(!is_out_of_sight_state(Some(true), Some(false)));
    }

    #[test]
    fn failed_window_queries_do_not_throttle_a_visible_window() {
        assert!(!is_out_of_sight_state(None, None));
        assert!(!is_out_of_sight_state(None, Some(false)));
        assert!(!is_out_of_sight_state(Some(true), None));
    }

    #[test]
    fn visible_windows_use_the_onscreen_posture_immediately() {
        assert_eq!(immediate_posture(false), Posture::Onscreen);
    }

    #[test]
    fn hidden_windows_are_backgrounded_before_the_grace_period() {
        assert_eq!(immediate_posture(true), Posture::Offscreen);
    }

    #[test]
    fn parking_requires_the_same_hidden_generation() {
        assert!(should_park(7, 7, true));
        assert!(!should_park(7, 8, true));
        assert!(!should_park(7, 7, false));
    }
}
