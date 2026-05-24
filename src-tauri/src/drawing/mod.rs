//! Native "ink" drawing layer.
//!
//! What this is:
//!   - A Tauri-callable surface that injects a hardware-accelerated
//!     Android `SurfaceView` below the Tauri WebView's chrome. The
//!     SurfaceView captures touch / stylus input and renders thin
//!     lines via `wgpu` with an `egui` toolbar overlay.
//!
//! Module layout:
//!   - `mod.rs`             — this file: Tauri commands + module decls
//!   - `input.rs`           — platform-neutral input types (`Sample`,
//!                            `ToolKind`, `SampleAction`, `buttons`).
//!                            Host-buildable; the R4 input shape.
//!   - `surface_source.rs`  — `SurfaceSource` trait (R3). Pure
//!                            bounds, no platform deps.
//!   - `page.rs`            — page-coordinate model + the
//!                            `segment_quad_positions` geometry math.
//!   - `strokes_doc.rs`     — yrs schema façade.
//!   - `pipeline.rs`        — wgpu state + per-frame GPU pass.
//!                            Takes `Box<dyn SurfaceSource>` rather
//!                            than any platform-specific window type.
//!   - `ui/`                — egui-driven UI overlay.
//!     - `mod.rs`             — `CanvasUi` + `RenderActions` + `UiOutput`
//!     - `toolbar.rs`         — the toolbar widget
//!   - `render.rs`          — render thread state machine + the
//!                            Tauri-facing public API.
//!   - `platform/`          — per-OS glue (R5):
//!     - `android.rs`         — `AndroidWindow` + JNI exports.
//!                              cfg-gated to `target_os = "android"`.
//!
//! Threading model:
//!   - All wgpu / egui state lives on a dedicated render thread
//!     spawned by `render::set_surface` on first call.
//!   - Platform input bridges (today: Android JNI in `platform::android`)
//!     just push messages onto an mpsc channel the render thread
//!     owns.
//!   - The Tauri commands below only forward to Kotlin via JNI
//!     callback (`platform::android::ui::call_show` / `call_hide`)
//!     — they do not touch render state directly.
//!
//! Layering (Android):
//!   `[ Status bar (system overlay) ]`
//!   `[ Svelte header (WebView)     ]` ← reachable; back arrow lives here
//!   `[ Android SurfaceView         ]` ← inset by topMargin so it sits
//!   `[ egui toolbar (atop above)   ]`    below the header; egui paints
//!   `[ stroke canvas (atop above)  ]`    its toolbar at the top of the
//!                                       surface (which is below header)

use std::sync::OnceLock;

use tauri::{AppHandle, Emitter};

// Cross-platform modules (no wgpu / no JNI / no NDK) — kept
// compiled everywhere so `cargo test` catches regressions on the
// host without needing the Android target.
pub mod input;
pub mod page;
pub mod strokes_doc;
pub mod surface_source;

// Android-only modules (wgpu / egui / NDK / JNI). When the desktop
// port (E1) lands, `pipeline` + `render` + `ui` drop their cfg
// gates and the per-platform glue under `platform/` carries the
// remaining cfgs.
#[cfg(target_os = "android")]
pub mod pipeline;
#[cfg(target_os = "android")]
pub mod platform;
#[cfg(target_os = "android")]
pub mod render;
#[cfg(target_os = "android")]
pub mod ui;

// ---------- Tauri event-emit plumbing ----------

/// Name of the "stroke document changed, save it soon" event.
/// `DrawingNoteEditor.svelte` listens for this and debounces a
/// `drawing_get_state` → `save_note` round-trip. Payload is a
/// `String` carrying the affected note id so editors filter to
/// only their own note (dockview can have multiple ink notes
/// open in separate tabs on desktop).
pub const DIRTY_EVENT: &str = "drawing:dirty";

/// AppHandle stashed at app startup so the render thread (which
/// has no other way to reach Tauri's emitter) can fire events.
/// Populated by [`init`] from `lib.rs`'s setup hook.
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Capture the `AppHandle` so [`notify_dirty`] can emit events
/// later. Called exactly once from the Tauri `setup` callback. A
/// second call silently no-ops (OnceLock semantics) — useful if a
/// future restart-without-process-exit story emerges.
pub fn init(app: AppHandle) {
    if APP_HANDLE.set(app).is_err() {
        log::warn!("[drawing] init called more than once — ignoring");
    }
}

/// Tell the frontend that the named ink note's stroke document
/// changed and should be saved soon. Called from the render thread
/// at the three "stroke document mutated" edges:
///   - stroke end (ACTION_UP / ACTION_CANCEL)
///   - eraser-style clear (`Msg::Clear`)
///   - toolbar clear button (egui `actions.clear`)
///
/// Cheap and non-blocking — emit returns immediately; the actual
/// fetch + save happens on the JS side after a debounce. If the
/// app handle hasn't been installed yet (defensive; shouldn't
/// happen in practice because `init` runs before any render
/// thread spawns), this is a silent no-op.
pub fn notify_dirty(note_id: &str) {
    let Some(app) = APP_HANDLE.get() else {
        log::debug!("[drawing] notify_dirty before init — ignored");
        return;
    };
    if let Err(e) = app.emit(DIRTY_EVENT, note_id.to_string()) {
        log::warn!("[drawing] emit {DIRTY_EVENT} failed: {e}");
    }
}

/// Reveal the native drawing surface over the current WebView and
/// activate the per-note stroke document for the given note id.
///
/// Called by `DrawingNoteEditor.svelte` in `onMount`. On desktop
/// this is a no-op success: the frontend renders a placeholder
/// rather than trying to call native code.
///
/// `yrs_state` is the persisted CRDT bytes from SQLite (empty for
/// a brand-new note) — passed through to the render thread which
/// builds the in-memory `StrokesDoc` from them on first activation
/// and ignores them on subsequent re-activations of the same note.
///
/// The set-active-note + initial-state hop and the surface-show
/// hop are on the same Tauri command on purpose: going through two
/// separate IPC round-trips opens a race where the SurfaceView
/// would briefly render the previous note's strokes before the
/// active-note swap message reaches the render thread.
#[tauri::command]
#[allow(unused_variables)]
pub fn drawing_show(note_id: String, yrs_state: Vec<u8>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        // Set the active note BEFORE bringing the surface up so the
        // first frame already shows the right strokes.
        render::set_active_note(Some(note_id), Some(yrs_state));
        platform::android::ui::call_show().map_err(|e| format!("drawing_show: {e}"))
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(())
    }
}

/// Fetch the active note's stroke document as v1-yrs bytes — the
/// shape the frontend hands to `save_note(..., yrs_state=...)` to
/// persist. Returns empty if no note is active.
///
/// Called by `DrawingNoteEditor.svelte` in `onDestroy` (and
/// eventually periodically while drawing) to flush in-memory
/// stroke state to SQLite + sync.
#[tauri::command]
pub fn drawing_get_state() -> Result<Vec<u8>, String> {
    #[cfg(target_os = "android")]
    {
        Ok(render::get_active_state())
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(Vec::new())
    }
}

/// Hide the native drawing surface and let the WebView take input again.
///
/// Called from `onDestroy`. Idempotent — repeated hides are fine.
#[tauri::command]
pub fn drawing_hide() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        platform::android::ui::call_hide().map_err(|e| format!("drawing_hide: {e}"))
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(())
    }
}

/// Wipe the current accumulated strokes without hiding the surface.
///
/// Unused by the POC frontend (no toolbar) but wired so a follow-up
/// "clear canvas" button has somewhere to land.
#[tauri::command]
pub fn drawing_clear() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        render::clear_strokes();
        Ok(())
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(())
    }
}
