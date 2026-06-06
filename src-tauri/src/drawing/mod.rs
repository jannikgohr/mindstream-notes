//! Native "ink" drawing layer.
//!
//! What this is:
//! - A Tauri-callable surface that injects a hardware-accelerated
//!   Android `SurfaceView` below the Tauri WebView's chrome. The
//!   SurfaceView captures touch / stylus input and renders thin lines
//!   via `wgpu` with an `egui` toolbar overlay.
//!
//! Module layout:
//! - `mod.rs`: this file, Tauri commands and module declarations.
//! - `input.rs`: platform-neutral input types (`Sample`, `ToolKind`,
//!   `SampleAction`, `buttons`). Host-buildable; the R4 input shape.
//! - `surface_source.rs`: `SurfaceSource` trait (R3). Pure bounds, no
//!   platform deps.
//! - `page.rs`: page-coordinate model and the
//!   `segment_quad_positions` geometry math.
//! - `strokes_doc.rs`: yrs schema facade.
//! - `stroke_modeler.rs`: D1 stroke smoothing wrapper around
//!   ink-stroke-modeler-rs. Host-buildable.
//! - `pipeline.rs`: wgpu state and per-frame GPU pass. Takes
//!   `Box<dyn SurfaceSource>` rather than any platform-specific
//!   window type.
//! - `ui/`: egui-driven UI overlay.
//!   - `mod.rs`: `CanvasUi`, `RenderActions`, and `UiOutput`.
//!   - `toolbar.rs`: the toolbar widget.
//! - `render.rs`: render thread state machine and the Tauri-facing
//!   public API.
//! - `platform/`: per-OS glue (R5).
//!   - `android.rs`: `AndroidWindow` and JNI exports, cfg-gated to
//!     `target_os = "android"`.
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

#[cfg(desktop)]
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;
#[cfg(desktop)]
use tauri::{Manager, PhysicalPosition, PhysicalSize};

// Cross-platform modules (no wgpu / no JNI / no NDK) — kept
// compiled everywhere so `cargo test` catches regressions on the
// host without needing the Android target.
pub mod input;
pub mod page;
pub mod save_worker;
pub mod stroke_modeler;
pub mod strokes_doc;
pub mod surface_source;

// Native-render modules. `pipeline` / `render` / `ui` are shared by
// Android's SurfaceView bridge and desktop's first native-window
// bridge; `platform/` carries the OS-specific glue.
#[cfg(any(target_os = "android", desktop))]
pub mod collab;
#[cfg(any(target_os = "android", desktop))]
pub mod pipeline;
#[cfg(any(target_os = "android", desktop))]
pub mod platform;
#[cfg(any(target_os = "android", desktop))]
pub mod render;
#[cfg(any(target_os = "android", desktop))]
pub mod ui;

#[cfg(desktop)]
const DESKTOP_INK_WINDOW_LABEL: &str = "mindstream-ink-note";
#[cfg(desktop)]
const MAIN_WINDOW_LABEL: &str = "main";
#[cfg(desktop)]
static DESKTOP_ACTIVE_NOTE: OnceLock<Mutex<Option<String>>> = OnceLock::new();

// ---------- App startup hook ----------

/// One-time wiring at app start: stand up the save-worker thread
/// (which owns auto-save debounce + SQLite writes for ink notes).
/// Called exactly once from the Tauri `setup` callback. Save worker
/// init itself is idempotent — second call silently no-ops.
pub fn init(app: AppHandle) {
    save_worker::init(app.clone());
    #[cfg(any(target_os = "android", desktop))]
    render::init(app);
}

#[cfg(desktop)]
fn desktop_active_note() -> &'static Mutex<Option<String>> {
    DESKTOP_ACTIVE_NOTE.get_or_init(|| Mutex::new(None))
}

#[cfg(desktop)]
fn set_desktop_active_note(note_id: Option<String>) {
    if let Ok(mut active) = desktop_active_note().lock() {
        *active = note_id;
    }
}

#[cfg(desktop)]
fn desktop_active_note_id() -> Option<String> {
    desktop_active_note()
        .lock()
        .ok()
        .and_then(|active| active.clone())
}

#[cfg(desktop)]
fn desktop_note_is_active(note_id: &str) -> bool {
    desktop_active_note_id().as_deref() == Some(note_id)
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
    app: AppHandle,
    db: tauri::State<'_, crate::db::Db>,
    note_id: String,
) -> Result<(), String> {
    #[cfg(any(target_os = "android", desktop))]
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
        render::set_active_note(Some(note_id.clone()), Some(yrs_state));
        let t_active = t_active_start.elapsed();
        let t_show_start = std::time::Instant::now();
        #[cfg(target_os = "android")]
        let result = platform::android::ui::call_show().map_err(|e| format!("drawing_show: {e}"));
        #[cfg(desktop)]
        let result = {
            set_desktop_active_note(Some(note_id.clone()));
            show_desktop_ink_window(&app, &note_id)
        };
        log::info!(
            "[drawing.perf] drawing_show: sql_load={:?} set_active={:?} call_show={:?} state_bytes={}",
            t_load,
            t_active,
            t_show_start.elapsed(),
            state_bytes
        );
        result
    }
    #[cfg(not(any(target_os = "android", desktop)))]
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

/// Persist an ink note state update through the same merge/write path
/// the native save worker uses. Desktop web calls this with the
/// `StrokesDoc` bytes emitted by `ink-egui-web`; Android normally
/// reaches the same helper through `save_worker`.
#[tauri::command]
pub fn drawing_save_ink_state(
    db: tauri::State<'_, crate::db::Db>,
    note_id: String,
    yrs_state: Vec<u8>,
) -> Result<(), String> {
    db.with_conn_mut(|c| crate::notes::save_yrs_state(c, &note_id, &yrs_state))
        .map_err(|e| format!("drawing_save_ink_state: {e}"))?
        .then_some(())
        .ok_or_else(|| format!("drawing_save_ink_state: note {note_id} not found"))
}

#[tauri::command]
#[allow(unused_variables)]
pub fn drawing_start_collab(
    app: AppHandle,
    note_id: String,
    url: String,
    room_id: String,
    key_bytes: Vec<u8>,
) -> Result<(), String> {
    #[cfg(any(target_os = "android", desktop))]
    {
        collab::start(app, note_id, url, room_id, key_bytes)
    }
    #[cfg(not(any(target_os = "android", desktop)))]
    {
        Ok(())
    }
}

#[tauri::command]
#[allow(unused_variables)]
pub fn drawing_stop_collab(app: AppHandle, note_id: String) -> Result<(), String> {
    #[cfg(any(target_os = "android", desktop))]
    {
        collab::stop(&app, &note_id);
    }
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
pub fn drawing_hide(_app: AppHandle, note_id: Option<String>) -> Result<(), String> {
    save_worker::flush_all();
    #[cfg(any(target_os = "android", desktop))]
    if let Some(id) = note_id.as_deref() {
        collab::stop(&_app, id);
    }
    #[cfg(target_os = "android")]
    {
        let _ = note_id;
        render::set_active_note(None, None);
        platform::android::ui::call_hide().map_err(|e| format!("drawing_hide: {e}"))
    }
    #[cfg(desktop)]
    {
        let should_hide = note_id
            .as_deref()
            .map(desktop_note_is_active)
            .unwrap_or(true);
        if should_hide {
            set_desktop_active_note(None);
            render::set_active_note(None, None);
            render::clear_surface();
            if let Some(window) = _app.get_window(DESKTOP_INK_WINDOW_LABEL) {
                let _ = window.hide();
            }
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "android", desktop)))]
    {
        Ok(())
    }
}

#[tauri::command]
pub fn drawing_show_live_ink_overlay() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        platform::android::ui::call_show_live_overlay()
            .map_err(|e| format!("drawing_show_live_ink_overlay: {e}"))
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(())
    }
}

#[tauri::command]
pub fn drawing_hide_live_ink_overlay() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        platform::android::ui::call_hide_live_overlay()
            .map_err(|e| format!("drawing_hide_live_ink_overlay: {e}"))
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(())
    }
}

#[tauri::command]
pub fn drawing_cancel_live_ink() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        platform::android::ui::call_cancel_live_ink()
            .map_err(|e| format!("drawing_cancel_live_ink: {e}"))
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(())
    }
}

#[tauri::command]
pub fn drawing_set_live_ink_style(
    color_argb: u32,
    min_width_px: f32,
    max_width_px: f32,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        platform::android::ui::call_set_live_ink_style(color_argb, min_width_px, max_width_px)
            .map_err(|e| format!("drawing_set_live_ink_style: {e}"))?;
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (color_argb, min_width_px, max_width_px);
    }
    Ok(())
}

#[tauri::command]
pub fn drawing_set_live_ink_finger_drawing(allowed: bool) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        platform::android::ui::call_set_finger_drawing_allowed(allowed)
            .map_err(|e| format!("drawing_set_live_ink_finger_drawing: {e}"))?;
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = allowed;
    }
    Ok(())
}

#[tauri::command]
#[allow(unused_variables)]
pub fn drawing_set_desktop_panel_bounds(
    app: AppHandle,
    note_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let active_note_id = desktop_active_note_id();
        let is_active = active_note_id.as_deref() == Some(note_id.as_str());
        if !is_active {
            if active_note_id.is_none() && visible {
                set_desktop_active_note(Some(note_id.clone()));
                render::set_active_note(Some(note_id.clone()), None);
                if let Some(window) = app.get_window(DESKTOP_INK_WINDOW_LABEL) {
                    let _ = window.set_title(&format!("Ink Note - {note_id}"));
                }
            } else {
                return Ok(());
            }
        }
        if is_active && !visible {
            set_desktop_active_note(None);
            render::set_active_note(None, None);
            if let Some(window) = app.get_window(DESKTOP_INK_WINDOW_LABEL) {
                let _ = window.hide();
            }
            return Ok(());
        }
        set_desktop_panel_bounds(&app, x, y, width, height, visible)
    }
    #[cfg(not(desktop))]
    {
        Ok(())
    }
}

/// Push the resolved app theme down to the egui toolbar (B2).
/// Called from `+layout.svelte` / `DrawingNoteEditor.svelte` whenever
/// `appearance.mode` resolves to a new dark/light state or the user
/// picks a new `appearance.accent`. The Rust side forwards to
/// `render::set_theme` which re-applies `egui::Visuals`.
///
/// `accent_hex` is the user-picked accent (`#RRGGBB` / `#RRGGBBAA`).
/// Missing / unparseable values fall back to the shadcn defaults
/// baked into [`drawing::ui::DrawingTheme::dark`] / `::light` — that
/// way an unset accent still produces a sensible palette.
#[tauri::command]
#[allow(unused_variables)]
pub fn drawing_set_theme(dark: bool, accent_hex: Option<String>) -> Result<(), String> {
    #[cfg(any(target_os = "android", desktop))]
    {
        let accent_argb = accent_hex
            .as_deref()
            .and_then(parse_accent_hex)
            .unwrap_or_else(|| default_accent_argb(dark));
        render::set_theme(dark, accent_argb);
    }
    Ok(())
}

#[tauri::command]
#[allow(unused_variables)]
pub fn drawing_set_toolbar_settings(
    tool: Option<String>,
    color_argb: Option<u32>,
    width: Option<f32>,
    finger_drawing_allowed: Option<bool>,
    page_theme_mode: Option<String>,
) -> Result<(), String> {
    #[cfg(any(target_os = "android", desktop))]
    {
        render::set_toolbar_settings(
            tool,
            color_argb,
            width,
            finger_drawing_allowed,
            page_theme_mode,
        );
    }
    Ok(())
}

/// Parse the `#RRGGBB` / `#RRGGBBAA` hex string the JS picker
/// produces into a packed `0xAARRGGBB` u32 (with alpha forced to
/// `0xFF` — the toolbar accent is always opaque).
fn parse_accent_hex(input: &str) -> Option<u32> {
    let s = input.strip_prefix('#').unwrap_or(input);
    let (r, g, b) = match s.len() {
        // `#RGB` / `#RGBA` shorthand: each nibble doubles into a byte.
        3 | 4 => {
            let r = u8::from_str_radix(&s[0..1], 16).ok()?;
            let g = u8::from_str_radix(&s[1..2], 16).ok()?;
            let b = u8::from_str_radix(&s[2..3], 16).ok()?;
            (r * 17, g * 17, b * 17)
        }
        6 | 8 => {
            let r = u8::from_str_radix(&s[0..2], 16).ok()?;
            let g = u8::from_str_radix(&s[2..4], 16).ok()?;
            let b = u8::from_str_radix(&s[4..6], 16).ok()?;
            (r, g, b)
        }
        _ => return None,
    };
    Some(0xFF00_0000 | ((r as u32) << 16) | ((g as u32) << 8) | (b as u32))
}

/// Fallback accent if the JS side hasn't pushed one yet (or sent an
/// unparseable value). Matches the `--primary` token resolved from
/// `src/app.css` for the corresponding mode — near-white on dark,
/// near-black on light.
fn default_accent_argb(dark: bool) -> u32 {
    if dark {
        // oklch(0.985 0 0) ≈ #FAFAFA
        0xFFFA_FAFA
    } else {
        // oklch(0.205 0 0) ≈ #262626
        0xFF26_2626
    }
}

/// Wipe the current accumulated strokes without hiding the surface.
///
/// Unused by the POC frontend (no toolbar) but wired so a follow-up
/// "clear canvas" button has somewhere to land.
#[tauri::command]
pub fn drawing_clear() -> Result<(), String> {
    #[cfg(any(target_os = "android", desktop))]
    {
        render::clear_strokes();
        Ok(())
    }
    #[cfg(not(any(target_os = "android", desktop)))]
    {
        Ok(())
    }
}

#[cfg(desktop)]
pub fn shutdown_desktop(app: &AppHandle) {
    set_desktop_active_note(None);
    if let Some(window) = app.get_window(DESKTOP_INK_WINDOW_LABEL) {
        render::set_active_note(None, None);
        render::clear_surface();
        let _ = window.close();
    }
}

#[cfg(desktop)]
fn show_desktop_ink_window(app: &AppHandle, note_id: &str) -> Result<(), String> {
    let window = if let Some(window) = app.get_window(DESKTOP_INK_WINDOW_LABEL) {
        window
    } else {
        let mut builder = tauri::Window::builder(app, DESKTOP_INK_WINDOW_LABEL)
            .title(format!("Ink Note - {note_id}"))
            .decorations(false)
            .shadow(false)
            .skip_taskbar(true)
            .resizable(false)
            .visible(false)
            .inner_size(1.0, 1.0)
            .position(0.0, 0.0);
        if let Some(main) = app.get_window(MAIN_WINDOW_LABEL) {
            builder = builder
                .parent(&main)
                .map_err(|e| format!("desktop ink window parent: {e}"))?;
        }
        builder
            .build()
            .map_err(|e| format!("desktop ink window: {e}"))?
    };

    let _ = window.set_title(&format!("Ink Note - {note_id}"));
    let size = window
        .inner_size()
        .map_err(|e| format!("desktop ink window size: {e}"))?;
    render::set_surface(Box::new(window), size.width.max(1), size.height.max(1));
    Ok(())
}

#[cfg(desktop)]
fn set_desktop_panel_bounds(
    app: &AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
) -> Result<(), String> {
    let Some(window) = app.get_window(DESKTOP_INK_WINDOW_LABEL) else {
        return Ok(());
    };
    if !visible || width < 2.0 || height < 2.0 {
        let _ = window.hide();
        return Ok(());
    }

    let width = width.round().max(1.0) as u32;
    let height = height.round().max(1.0) as u32;
    window
        .set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))
        .map_err(|e| format!("desktop ink set_position: {e}"))?;
    window
        .set_size(PhysicalSize::new(width, height))
        .map_err(|e| format!("desktop ink set_size: {e}"))?;
    render::resize_surface(width, height);
    let _ = window.show();
    Ok(())
}
