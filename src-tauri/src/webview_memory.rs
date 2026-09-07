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

/// How long the window has to stay out of sight before its memory is
/// released.
///
/// Dropping to LOW is not free to undo: WebView2 decommits pages, so the
/// first interactions after the window comes back fault them in again. For
/// a window parked in the tray all afternoon that is a good trade; for a
/// minimise-and-restore ten seconds later it is a pure loss, paid exactly
/// when the user is looking. The delay keeps the win and skips the churn.
const HIDE_GRACE: Duration = Duration::from_secs(20);

#[derive(Debug, PartialEq, Eq)]
struct VisibilityChange {
    generation: u64,
    posture: Posture,
    apply: bool,
    schedule_parking: bool,
}

/// The platform-independent visibility policy.
///
/// Tauri supplies window state and WebView2 applies the result. Keeping the
/// generation and deduplication here makes the restore-before-timeout race
/// testable without a real window or a 20-second sleep.
struct VisibilityPolicy {
    /// Last posture applied, as a [`Posture`] discriminant. Zero means no
    /// posture has been applied yet.
    applied: AtomicU8,
    /// Bumped on every visibility event so delayed parking can reject stale
    /// work after a restore or a newer hide event.
    generation: AtomicU64,
}

impl VisibilityPolicy {
    const fn new() -> Self {
        Self {
            applied: AtomicU8::new(0),
            generation: AtomicU64::new(0),
        }
    }

    fn visibility_changed(&self, out_of_sight: bool) -> VisibilityChange {
        let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
        let posture = if out_of_sight {
            Posture::Offscreen
        } else {
            Posture::Onscreen
        };

        VisibilityChange {
            generation,
            posture,
            apply: self.claim(posture),
            schedule_parking: out_of_sight,
        }
    }

    fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::Relaxed) == generation
    }

    fn parking_due(&self, generation: u64, out_of_sight: bool) -> Option<Posture> {
        if !out_of_sight || !self.is_current(generation) {
            return None;
        }
        self.claim(Posture::Parked).then_some(Posture::Parked)
    }

    fn claim(&self, posture: Posture) -> bool {
        let want = posture as u8;
        self.applied.swap(want, Ordering::Relaxed) != want
    }
}

static POLICY: VisibilityPolicy = VisibilityPolicy::new();

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
    // Every call invalidates whatever parking was already scheduled. Both
    // foregrounding and backgrounding are immediate; only parking waits.
    let change = POLICY.visibility_changed(is_out_of_sight(&window));
    if change.apply {
        apply(&window, change.posture);
    }
    if !change.schedule_parking {
        return;
    }

    let generation = change.generation;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(HIDE_GRACE).await;
        // Shown again (or hidden again, which scheduled its own parking)
        // while we waited.
        if !POLICY.is_current(generation) {
            return;
        }
        let Some(window) = app.get_webview_window(MAIN) else {
            return;
        };
        if let Some(posture) = POLICY.parking_due(generation, is_out_of_sight(&window)) {
            apply(&window, posture);
        }
    });
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
    fn visible_windows_apply_onscreen_without_scheduling_work() {
        let policy = VisibilityPolicy::new();

        assert_eq!(
            policy.visibility_changed(false),
            VisibilityChange {
                generation: 1,
                posture: Posture::Onscreen,
                apply: true,
                schedule_parking: false,
            }
        );
    }

    #[test]
    fn hidden_windows_apply_offscreen_and_schedule_parking() {
        let policy = VisibilityPolicy::new();

        assert_eq!(
            policy.visibility_changed(true),
            VisibilityChange {
                generation: 1,
                posture: Posture::Offscreen,
                apply: true,
                schedule_parking: true,
            }
        );
    }

    #[test]
    fn restoring_before_the_grace_period_cancels_parking() {
        let policy = VisibilityPolicy::new();
        let hidden = policy.visibility_changed(true);
        let restored = policy.visibility_changed(false);

        assert_eq!(restored.posture, Posture::Onscreen);
        assert!(restored.apply);
        assert!(!policy.is_current(hidden.generation));
        assert_eq!(policy.parking_due(hidden.generation, true), None);
    }

    #[test]
    fn the_latest_hidden_generation_parks_once() {
        let policy = VisibilityPolicy::new();
        let first = policy.visibility_changed(true);
        let latest = policy.visibility_changed(true);

        assert!(first.apply);
        assert!(!latest.apply, "offscreen was already applied");
        assert_eq!(policy.parking_due(first.generation, true), None);
        assert_eq!(
            policy.parking_due(latest.generation, true),
            Some(Posture::Parked)
        );
        assert_eq!(policy.parking_due(latest.generation, true), None);
    }

    #[test]
    fn a_window_that_is_visible_when_the_timer_fires_does_not_park() {
        let policy = VisibilityPolicy::new();
        let hidden = policy.visibility_changed(true);

        assert_eq!(policy.parking_due(hidden.generation, false), None);
    }

    #[test]
    fn restoring_a_parked_window_reapplies_the_onscreen_posture() {
        let policy = VisibilityPolicy::new();
        let hidden = policy.visibility_changed(true);
        assert_eq!(
            policy.parking_due(hidden.generation, true),
            Some(Posture::Parked)
        );

        let restored = policy.visibility_changed(false);
        assert_eq!(restored.posture, Posture::Onscreen);
        assert!(restored.apply);
    }
}
