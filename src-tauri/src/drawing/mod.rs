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
//!   - `stroke_modeler.rs`  — D1 stroke smoothing wrapper around
//!                            ink-stroke-modeler-rs. Host-buildable.
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

use tauri::AppHandle;

// Cross-platform modules (no wgpu / no JNI / no NDK) — kept
// compiled everywhere so `cargo test` catches regressions on the
// host without needing the Android target.
pub mod input;
pub mod page;
pub mod save_worker;
pub mod stroke_modeler;
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

// ---------- App startup hook ----------

/// One-time wiring at app start: stand up the save-worker thread
/// (which owns auto-save debounce + SQLite writes for ink notes).
/// Called exactly once from the Tauri `setup` callback. Save worker
/// init itself is idempotent — second call silently no-ops.
pub fn init(app: AppHandle) {
    save_worker::init(app);
}

/// Tell the auto-save worker that the named ink note's stroke
/// document changed. Called from the render thread at the three
/// "stroke document mutated" edges:
///   - stroke end (ACTION_UP / ACTION_CANCEL)
///   - eraser-style clear (`Msg::Clear`)
///   - toolbar clear button (egui `actions.clear`)
///
/// Cheap and non-blocking — an mpsc channel send. The save worker
/// handles the debounce + SQLite write on its own thread and emits
/// `drawing:save_status` Tauri events back to JS for the UI's
/// editing / saving / saved / error state.
///
/// Pre-P4 this also emitted a `drawing:dirty` Tauri event that JS
/// listened on for a debounced `drawing_get_state` → `saveNote`
/// round-trip. That JS path is gone — the worker owns everything
/// now and the (potentially MB-class) yrs blob never crosses IPC.
pub fn notify_dirty(note_id: &str) {
    save_worker::notify_dirty(note_id);
}

/// Reveal the native drawing surface over the current WebView and
/// activate the per-note stroke document for the given note id.
///
/// Called by `DrawingNoteEditor.svelte` in `onMount`. On desktop
/// this is a no-op success: the frontend renders a placeholder
/// rather than trying to call native code.
///
/// The persisted CRDT bytes are read here from SQLite directly —
/// originally the frontend did a separate `loadNote` IPC and
/// passed `yrs_state` into this command, but at 1+ MB of stroke
/// data Tauri's JSON-encoded IPC dominated the open path (~800ms
/// for a 1.24 MB blob measured on a Tab S7 FE). Reading the column
/// in-process drops that to a single SQLite SELECT (~few ms) and
/// keeps the bytes from ever crossing a serialisation boundary.
/// A missing / never-saved note returns empty bytes, which the
/// render thread treats as a fresh `StrokesDoc`.
///
/// The set-active-note + initial-state hop and the surface-show
/// hop are on the same Tauri command on purpose: going through two
/// separate IPC round-trips opens a race where the SurfaceView
/// would briefly render the previous note's strokes before the
/// active-note swap message reaches the render thread.
#[tauri::command]
#[allow(unused_variables)]
pub fn drawing_show(
    db: tauri::State<'_, crate::db::Db>,
    note_id: String,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        // Open-path timing — prefix `[drawing.perf]` so it's easy to
        // grep in logcat. Tells us:
        //   - sql_load:   SQLite read of yrs_state (was a full
        //                 loadNote IPC, now an in-process column read)
        //   - set_active: channel send for Msg::SetActiveNote
        //   - call_show:  JNI call into Kotlin's Drawing.show
        //   - state_bytes: how heavy the stroke doc is — informs
        //                  whether the from_bytes rebuild on the
        //                  render thread might be the next bottleneck
        let t_load_start = std::time::Instant::now();
        let yrs_state = db
            .with_conn(|c| crate::notes::load_yrs_state(c, &note_id))
            .map_err(|e| format!("drawing_show: load_yrs_state: {e}"))?;
        let t_load = t_load_start.elapsed();
        let state_bytes = yrs_state.len();

        let t_active_start = std::time::Instant::now();
        // Set the active note BEFORE bringing the surface up so the
        // first frame already shows the right strokes.
        render::set_active_note(Some(note_id), Some(yrs_state));
        let t_active = t_active_start.elapsed();
        let t_show_start = std::time::Instant::now();
        let result = platform::android::ui::call_show()
            .map_err(|e| format!("drawing_show: {e}"));
        log::info!(
            "[drawing.perf] drawing_show: sql_load={:?} set_active={:?} call_show={:?} state_bytes={}",
            t_load,
            t_active,
            t_show_start.elapsed(),
            state_bytes
        );
        result
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(())
    }
}

/// Push a new auto-save debounce window (in ms) to the save worker.
/// JS calls this from the editor's settings effect so the worker
/// uses the same value the user picked. Idempotent — same-value
/// re-pushes are no-ops on the worker side.
#[tauri::command]
#[allow(unused_variables)]
pub fn drawing_set_save_debounce(ms: u64) -> Result<(), String> {
    save_worker::set_debounce(ms);
    Ok(())
}

/// Hide the native drawing surface and let the WebView take input again.
///
/// Called from `onDestroy`. Idempotent — repeated hides are fine.
/// Also flushes any pending auto-save immediately so a "drew, then
/// navigated away within the 800 ms debounce window" gesture
/// doesn't strand the change in the worker's pending map (which
/// would still eventually fire, but with a visible delay if the
/// user is, say, scrolling through other notes immediately after).
#[tauri::command]
pub fn drawing_hide() -> Result<(), String> {
    save_worker::flush_all();
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
