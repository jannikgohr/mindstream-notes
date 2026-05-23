//! Native "ink" drawing layer — POC.
//!
//! What this is:
//!   - A Tauri-callable surface that toggles a hardware-accelerated
//!     Android `SurfaceView` injected as a sibling beneath the Tauri
//!     WebView. When visible, the SurfaceView captures touch / stylus
//!     input and renders thin lines via `wgpu`.
//!
//! What this isn't (yet):
//!   - No persistence — strokes disappear when the note closes.
//!   - No egui, no lyon, no ink-stroke-modeler. The POC validates the
//!     surface / input / wgpu plumbing in isolation; smoothing,
//!     pressure-tapered strokes, and the egui toolbar are follow-ups.
//!     See `docs/native-egui-layer/01-audit.md` for the rationale.
//!   - Desktop is a placeholder. Phase-2 desktop ports will reuse
//!     `render.rs` with a different surface source (winit / wry handle).
//!
//! Layering:
//!   `[ Tauri WebView (transparent) ]` ← Layer 2, the Svelte shell
//!   `[ Android SurfaceView         ]` ← Layer 1, what we render into
//!   When `drawing_show()` runs, Kotlin attaches the SurfaceView and
//!   flips its visibility to VISIBLE; `drawing_hide()` reverses both.
//!
//! Threading model:
//!   - The Rust render state (`render::RenderState`) lives behind a
//!     single mutex. All wgpu mutation happens on a dedicated render
//!     thread spawned when `Java_..._setSurface` first runs; the JNI
//!     entrypoints just push messages onto a channel that thread owns.
//!   - The Tauri commands here only forward to Kotlin via JNI callback
//!     (`jni::ui::call_show()` / `call_hide()`), then return. They do
//!     not touch render state.

#[cfg(target_os = "android")]
pub mod jni;
#[cfg(target_os = "android")]
pub mod render;

/// Reveal the native drawing surface over the current WebView.
///
/// Called by `DrawingNoteEditor.svelte` in `onMount`. On desktop this
/// is a no-op success: the frontend renders a placeholder rather than
/// trying to call native code.
#[tauri::command]
pub fn drawing_show() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
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
