//! Native "ink" drawing layer.
//!
//! What this is:
//!   - A Tauri-callable surface that injects a hardware-accelerated
//!     Android `SurfaceView` below the Tauri WebView's chrome. The
//!     SurfaceView captures touch / stylus input and renders thin
//!     lines via `wgpu` with an `egui` toolbar overlay.
//!
//! Module layout:
//!   - `mod.rs`     — this file: Tauri commands + module declarations
//!   - `jni.rs`     — JNI exports (Kotlin ↔ Rust bridge)
//!   - `surface.rs` — `AndroidWindow` raw-window-handle wrapper
//!                    (cross-platform `SurfaceSource` trait pending,
//!                    see R3 in the roadmap)
//!   - `pipeline.rs`— wgpu state + per-frame GPU pass
//!                    (`PersistentGpu` + `SurfaceBoundState` +
//!                    `render_frame`)
//!   - `ui/`        — egui-driven UI overlay
//!     - `mod.rs`     — `CanvasUi` + `RenderActions` + `UiOutput`
//!     - `toolbar.rs` — the toolbar widget
//!   - `render.rs`  — render thread state machine + JNI-facing
//!                    public API
//!
//! Threading model:
//!   - All wgpu / egui state lives on a dedicated render thread
//!     spawned by `render::set_surface` on first call.
//!   - JNI entrypoints just push messages onto an mpsc channel
//!     the render thread owns.
//!   - The Tauri commands below only forward to Kotlin via JNI
//!     callback (`jni::ui::call_show` / `call_hide`) — they do
//!     not touch render state directly.
//!
//! Layering (Android):
//!   `[ Status bar (system overlay) ]`
//!   `[ Svelte header (WebView)     ]` ← reachable; back arrow lives here
//!   `[ Android SurfaceView         ]` ← inset by topMargin so it sits
//!   `[ egui toolbar (atop above)   ]`    below the header; egui paints
//!   `[ stroke canvas (atop above)  ]`    its toolbar at the top of the
//!                                       surface (which is below header)

// page.rs is pure document-coord math with no platform deps —
// keep it compiled everywhere so cargo test catches regressions on
// the host without needing the Android target.
pub mod page;

#[cfg(target_os = "android")]
pub mod jni;
#[cfg(target_os = "android")]
pub mod pipeline;
#[cfg(target_os = "android")]
pub mod render;
#[cfg(target_os = "android")]
pub mod surface;
#[cfg(target_os = "android")]
pub mod ui;

/// Reveal the native drawing surface over the current WebView and
/// activate the per-note stroke document for the given note id.
///
/// Called by `DrawingNoteEditor.svelte` in `onMount`. On desktop this
/// is a no-op success: the frontend renders a placeholder rather than
/// trying to call native code.
///
/// The set-active-note hop is on the same Tauri command on purpose:
/// going through two separate IPC round-trips opens a race where the
/// SurfaceView would briefly render the previous note's strokes
/// before the active-note swap message reaches the render thread.
#[tauri::command]
#[allow(unused_variables)]
pub fn drawing_show(note_id: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        // Set the active note BEFORE bringing the surface up so the
        // first frame already shows the right strokes.
        render::set_active_note(Some(note_id));
        jni::ui::call_show().map_err(|e| format!("drawing_show: {e}"))
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(())
    }
}

/// Hide the native drawing surface and let the WebView take input again.
///
/// Called from `onDestroy`. Idempotent — repeated hides are fine.
#[tauri::command]
pub fn drawing_hide() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        jni::ui::call_hide().map_err(|e| format!("drawing_hide: {e}"))
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
