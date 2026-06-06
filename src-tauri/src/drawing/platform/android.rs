//! Android platform glue for the drawing surface.
//!
//! Two responsibilities, both intrinsically Android-specific:
//!
//!   1. `AndroidWindow` — the [`SurfaceSource`](super::super::surface_source::SurfaceSource)
//!      impl wrapping `ANativeWindow*`. The render pipeline only
//!      sees the trait; this file owns the unsafe pointer
//!      ownership + the raw-handle plumbing.
//!
//!   2. JNI exports — Kotlin ↔ Rust bridge. Two directions:
//!
//!      Kotlin → Rust  (data plane — high-frequency)
//!        setSurface(Surface, w, h)
//!        resizeSurface(w, h)
//!        clearSurface()
//!        setFingerDrawingAllowed(allowed)
//!        pushPoint(x, y, pressure, toolType, buttons, action, timeMs)
//!        pushPredictedPoint(x, y, pressure, timeMs)
//!
//!        Exposed as `Java_io_crates_drawing_Drawing_00024Companion_*`
//!        symbols. Package + class + `$Companion` are load-bearing
//!        for the symbol mangling, matching the proven
//!        `io.crates.keyring` pattern already in this repo —
//!        renaming any fragment breaks the link at startup.
//!
//!      Rust → Kotlin  (control plane — low-frequency)
//!        `ui::call_show()`                 → Drawing.showFromNative()
//!        `ui::call_hide()`                 → Drawing.hideFromNative()
//!        `ui::call_back()`                 → Drawing.backFromNative()
//!        `ui::call_set_live_ink_style(…)`  → Drawing.setLiveInkStyleFromNative(…)
//!
//!        Uses the JavaVM stashed in ndk_context by Keyring.kt's
//!        `initializeNdkContext` in MainActivity.onCreate. The
//!        Kotlin companion methods are `@JvmStatic` so the call
//!        site just hits a plain static method on `Drawing`
//!        directly. The `DRAWING_CLASS` GlobalRef is what makes
//!        that resolvable from the render thread (which would
//!        otherwise see only the system class loader).

use std::ptr::NonNull;
use std::sync::OnceLock;

use jni::objects::{GlobalRef, JClass, JObject};
use jni::sys::{jboolean, jfloat, jint, jlong};
use jni::JNIEnv;
use raw_window_handle::{
    AndroidDisplayHandle, AndroidNdkWindowHandle, DisplayHandle, HandleError, HasDisplayHandle,
    HasWindowHandle, RawDisplayHandle, RawWindowHandle, WindowHandle,
};

use crate::drawing::input::{Sample, SampleAction, ToolKind};
use crate::drawing::render;

/// Read the system uptime in milliseconds, in the same clock
/// `MotionEvent.eventTime` is reported in (`SystemClock.uptimeMillis()`
/// → `CLOCK_MONOTONIC`). Lets the render-thread latency
/// instrumentation compute `now_uptime_ms() - sample.eventTime_ms`
/// = "how old is this sample" without having to plumb the Kotlin
/// SystemClock through JNI on the hot path.
///
/// `clock_gettime` is a vDSO call on Android — ~tens of nanoseconds,
/// safe to call freely from the render thread. Returns 0 on the
/// (in-practice-impossible) failure case; the worst that does is
/// produce wildly wrong-looking lag numbers in logcat which we'd
/// notice instantly.
pub fn now_uptime_ms() -> f64 {
    let mut ts: libc::timespec = unsafe { std::mem::zeroed() };
    // SAFETY: clock_gettime is async-signal-safe and well-defined
    // on Android for CLOCK_MONOTONIC; we own `ts` so the write is
    // bounded to our stack slot.
    let rc = unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
    if rc != 0 {
        return 0.0;
    }
    (ts.tv_sec as f64) * 1000.0 + (ts.tv_nsec as f64) / 1_000_000.0
}

// ---------- AndroidWindow (SurfaceSource impl) ----------

/// Owns an `ANativeWindow*` and implements the raw-handle traits
/// wgpu needs to build a Surface. Drop releases the window
/// reference, balancing the `ANativeWindow_acquire` (or the
/// equivalent `ANativeWindow_fromSurface` call below) that
/// produced the pointer in the first place.
///
/// This is the Android impl of `crate::drawing::surface_source::SurfaceSource`
/// — picked up automatically by the blanket impl over types that
/// satisfy `HasWindowHandle + HasDisplayHandle + Send`.
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

// ---------- JNI: Kotlin → Rust ----------

/// Global ref to the Kotlin `io.crates.drawing.Drawing` class,
/// populated by `cacheJniClass` from the companion's static `init`
/// block. We need this because `JavaVM::attach_current_thread` on a
/// Rust-spawned thread (our render thread) returns a `JNIEnv` whose
/// `find_class` only sees the *system* class loader — app classes
/// like ours throw `ClassNotFoundException`. Stashing a GlobalRef
/// made during Java-originating class loading sidesteps that
/// entirely.
static DRAWING_CLASS: OnceLock<GlobalRef> = OnceLock::new();

/// `Drawing.Companion.cacheJniClass(Drawing.class)`.
///
/// Called once from the companion's static `init` block. The class
/// object is captured here as a `GlobalRef` so the Rust render
/// thread can invoke static methods on `Drawing` without doing its
/// own `find_class` (which fails for app classes — see DRAWING_CLASS
/// docstring above).
///
/// Safe to call multiple times: the second `set` silently no-ops
/// because OnceLock won't overwrite, and we log a warning so we
/// notice if some teardown / re-init cycle is hitting it unexpectedly.
#[no_mangle]
pub extern "system" fn Java_io_crates_drawing_Drawing_00024Companion_cacheJniClass(
    env: JNIEnv,
    _companion: JClass,
    klass: JObject,
) {
    match env.new_global_ref(klass) {
        Ok(global_ref) => {
            if DRAWING_CLASS.set(global_ref).is_err() {
                log::warn!("[drawing] cacheJniClass called more than once — ignoring");
            } else {
                log::info!("[drawing] cached Drawing class ref for render-thread callbacks");
            }
        }
        Err(e) => log::error!("[drawing] new_global_ref(Drawing.class) failed: {e}"),
    }
}

/// `Drawing.Companion.setSurface(surface, width, height)`.
///
/// Acquires an `ANativeWindow*` from the Java `Surface`, wraps it
/// in [`AndroidWindow`], boxes it as `Box<dyn SurfaceSource>`, and
/// hands ownership to the render thread. `ANativeWindow_fromSurface`
/// already acquires a reference, which is balanced by `AndroidWindow::drop`
/// after the wgpu surface is torn down.
#[no_mangle]
pub extern "system" fn Java_io_crates_drawing_Drawing_00024Companion_setSurface(
    env: JNIEnv,
    _class: JClass,
    surface: JObject,
    width: jint,
    height: jint,
) {
    let native_window = unsafe {
        ndk_sys::ANativeWindow_fromSurface(env.get_raw() as *mut _, surface.as_raw() as *mut _)
    };
    let Some(ptr) = NonNull::new(native_window) else {
        log::error!("[drawing] ANativeWindow_fromSurface returned null");
        return;
    };
    let window = Box::new(AndroidWindow::new(ptr));
    render::set_surface(window, width.max(0) as u32, height.max(0) as u32);
}

/// `Drawing.Companion.resizeSurface(width, height)`.
///
/// Plumbs through to the render thread, which reconfigures the wgpu
/// surface. Called by SurfaceHolder.Callback.surfaceChanged.
#[no_mangle]
pub extern "system" fn Java_io_crates_drawing_Drawing_00024Companion_resizeSurface(
    _env: JNIEnv,
    _class: JClass,
    width: jint,
    height: jint,
) {
    render::resize_surface(width.max(0) as u32, height.max(0) as u32);
}

/// `Drawing.Companion.clearSurface()` — surface is going away, drop
/// the wgpu state before the underlying ANativeWindow becomes invalid.
/// Called by SurfaceHolder.Callback.surfaceDestroyed.
#[no_mangle]
pub extern "system" fn Java_io_crates_drawing_Drawing_00024Companion_clearSurface(
    _env: JNIEnv,
    _class: JClass,
) {
    render::clear_surface();
}

/// `Drawing.Companion.setFingerDrawingAllowed(allowed)` — low-rate
/// Kotlin → Rust state sync. Kotlin sends the device-default value
/// after checking whether Android exposes a stylus input source;
/// toolbar changes flow Rust → Kotlin via
/// `setFingerDrawingAllowedFromNative`.
#[no_mangle]
pub extern "system" fn Java_io_crates_drawing_Drawing_00024Companion_setFingerDrawingAllowed(
    _env: JNIEnv,
    _class: JClass,
    allowed: jboolean,
) {
    render::set_finger_drawing_allowed(allowed != 0);
}

/// `Drawing.Companion.pushPoint(x, y, pressure, toolType, buttons, action, timeMs)`
/// — a single MotionEvent sample (or one element of the
/// historical-sample sweep).
///
///   - `pressure` is `MotionEvent.AXIS_PRESSURE` in 0..1 (1.0 for
///     devices / events that don't report pressure — Kotlin
///     substitutes the default before crossing the boundary).
///   - `tool_type` mirrors `MotionEvent.TOOL_TYPE_*` (0 unknown,
///     1 finger, 2 stylus, 3 mouse, 4 eraser). Converted to
///     [`ToolKind`] here.
///   - `buttons` is `MotionEvent.buttonState` — a bitmask of
///     `BUTTON_*` flags. Forwarded raw into `Sample.buttons`;
///     bit tests live in `crate::drawing::input::buttons` /
///     [`Sample::has_stylus_primary_button`]. Android's button
///     state is per-event, not per-historical-sample, so the
///     Kotlin side passes the same value for the whole batch.
///   - `action` uses Android's `MotionEvent.ACTION_*` integer
///     constants verbatim. Converted to [`SampleAction`] here;
///     unrecognised values (e.g. ACTION_HOVER_MOVE) are dropped
///     before reaching the render thread.
///   - `time_ms` is `MotionEvent.getEventTime()` / `getHistoricalEventTime(h)`
///     in milliseconds since boot (monotonic). Divided by 1000 to
///     produce the `f64` seconds the D1 stroke modeler expects.
///     Negative values (shouldn't happen — eventTime is documented
///     monotonic per gesture) get clamped to 0 so a buggy driver
///     can't poison the modeler with a negative dt.
///
/// Hot path: this fires up to a few hundred Hz when the user is
/// drawing. Keep the body trivial — anything heavy belongs on the
/// render thread, behind the channel.
#[no_mangle]
pub extern "system" fn Java_io_crates_drawing_Drawing_00024Companion_pushPoint(
    _env: JNIEnv,
    _class: JClass,
    x: jfloat,
    y: jfloat,
    pressure: jfloat,
    tool_type: jint,
    buttons: jint,
    action: jint,
    time_ms: jlong,
) {
    let Some(action) = SampleAction::from_raw(action) else {
        // Unknown ACTION_* (HOVER_MOVE, OUTSIDE, multi-pointer
        // index bits, …) — the render thread only models the four
        // stroke phases, so drop these at the boundary rather than
        // pretend they're a recognised phase.
        return;
    };
    render::push_sample(Sample {
        x,
        y,
        pressure,
        tool: ToolKind::from_raw(tool_type),
        // Reinterpret rather than sign-extend: `MotionEvent
        // .buttonState` is an Int in Kotlin but is treated as an
        // unsigned bitmask. `as u32` on a negative jint would set
        // the high bits unexpectedly; cast through the bit pattern.
        buttons: buttons as u32,
        action,
        time: (time_ms.max(0) as f64) / 1000.0,
    });
}

/// `Drawing.Companion.pushPredictedPoint(x, y, pressure, timeMs)` —
/// a forward extrapolation from Android's MotionPredictor (API 33+).
/// Distinct from `pushPoint` because predicted samples are NOT
/// persisted into the stroke document; they only paint a transient
/// "predicted lead" segment past the raw head until the next real
/// sample arrives and replaces them. No action / tool / buttons
/// fields — predictions are always mid-stroke MOVE-style and the
/// stroke's tool / button state was already captured at DOWN.
///
/// Hot path: fires once per Kotlin `onTouchEvent` while drawing
/// (≈ 60 Hz). Same trivial-pass-through pattern as `pushPoint` —
/// anything non-trivial belongs on the render thread.
#[no_mangle]
pub extern "system" fn Java_io_crates_drawing_Drawing_00024Companion_pushPredictedPoint(
    _env: JNIEnv,
    _class: JClass,
    x: jfloat,
    y: jfloat,
    pressure: jfloat,
    time_ms: jlong,
) {
    render::push_predicted_point(x, y, pressure, (time_ms.max(0) as f64) / 1000.0);
}

/// `Drawing.Companion.pushViewGesture(focusX, focusY, panDx, panDy, scaleDelta)`
/// — a two-finger viewport gesture in surface pixels. Kotlin keeps
/// this separate from `pushPoint` so pinch/pan gestures never enter
/// the stroke model.
#[no_mangle]
pub extern "system" fn Java_io_crates_drawing_Drawing_00024Companion_pushViewGesture(
    _env: JNIEnv,
    _class: JClass,
    focus_x: jfloat,
    focus_y: jfloat,
    pan_dx: jfloat,
    pan_dy: jfloat,
    scale_delta: jfloat,
) {
    render::push_view_gesture(focus_x, focus_y, pan_dx, pan_dy, scale_delta);
}

// ---------- JNI: Rust → Kotlin (UI thread callbacks) ----------

pub mod ui {
    use jni::objects::{JClass, JValue};
    use jni::JavaVM;

    /// Call `Drawing.showFromNative()` from Rust. Triggered by the
    /// `drawing_show` Tauri command when the user opens an ink note.
    pub fn call_show() -> Result<(), String> {
        invoke_static_void("showFromNative")
    }

    /// Call `Drawing.hideFromNative()` from Rust.
    pub fn call_hide() -> Result<(), String> {
        invoke_static_void("hideFromNative")
    }

    pub fn call_show_live_overlay() -> Result<(), String> {
        invoke_static_void("showLiveOverlayFromNative")
    }

    pub fn call_hide_live_overlay() -> Result<(), String> {
        invoke_static_void("hideLiveOverlayFromNative")
    }

    pub fn call_cancel_live_ink() -> Result<(), String> {
        invoke_static_void("cancelLiveInkFromNative")
    }

    /// Call `Drawing.backFromNative()` — dispatches a `drawing-back`
    /// CustomEvent on the WebView's window so the Svelte mobile
    /// shell can navigate back to its home view. Currently unused
    /// (the in-egui Back button was removed in B1 because the Svelte
    /// mobile header above the SurfaceView already owns navigation);
    /// kept around for a future re-wire so the Kotlin
    /// `Drawing.backFromNative` export stays a valid JNI symbol.
    #[allow(dead_code)]
    pub fn call_back() -> Result<(), String> {
        invoke_static_void("backFromNative")
    }

    /// Push a new live-ink style (front-buffer overlay colour + width
    /// range) down to Kotlin. The render thread calls this whenever
    /// its source-of-truth stroke style changes — today: at every
    /// Pen / Eraser DOWN, so the very next segment uses the right
    /// colour. Future colour-picker / brush-size UI (D5) is expected
    /// to plug in here.
    ///
    /// Args:
    ///   - `color_argb` packs `0xAARRGGBB`. Matches the packing Rust
    ///     uses internally (`strokes_doc::DEFAULT_COLOR`) and the
    ///     `android.graphics.Color` int format — no conversion needed
    ///     on either side.
    ///   - `min_width_px` / `max_width_px` are in *surface pixels*,
    ///     because the Kotlin `Canvas` paints in pixels. Render-thread
    ///     callers multiply their page-unit constants by
    ///     `SurfaceBoundState::page_to_surface_scale` before the
    ///     call. The Kotlin side does its own bounds clamp so a
    ///     bogus negative width can't crash the Paint.
    pub fn call_set_live_ink_style(
        color_argb: u32,
        min_width_px: f32,
        max_width_px: f32,
    ) -> Result<(), String> {
        let args = [
            JValue::from(color_argb as i32),
            JValue::from(min_width_px),
            JValue::from(max_width_px),
        ];
        invoke_static("setLiveInkStyleFromNative", "(IFF)V", &args)
    }

    pub fn call_set_finger_drawing_allowed(allowed: bool) -> Result<(), String> {
        let args = [JValue::Bool(if allowed { 1 } else { 0 })];
        invoke_static("setFingerDrawingAllowedFromNative", "(Z)V", &args)
    }

    /// Push all active control bounding boxes (flat f32 array: [minX, minY, maxX, maxY, ...])
    /// down to Kotlin so the front-buffer overlay can suppress strokes drawn over them.
    pub fn call_set_control_bounds(bounds: &[f32]) -> Result<(), String> {
        let ctx = ndk_context::android_context();
        let vm_ptr = ctx.vm();
        if vm_ptr.is_null() {
            return Err(
                "ndk_context JavaVM is null — Keyring.initializeNdkContext must run first".into(),
            );
        }
        let vm = unsafe { JavaVM::from_raw(vm_ptr.cast()) }
            .map_err(|e| format!("JavaVM::from_raw: {e}"))?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("attach_current_thread: {e}"))?;

        let global_ref = super::DRAWING_CLASS.get().ok_or_else(|| {
            "Drawing class not yet cached — Drawing companion static init must have run".to_string()
        })?;
        let class = unsafe { JClass::from_raw(global_ref.as_raw()) };

        let array = env
            .new_float_array(bounds.len() as jni::sys::jsize)
            .map_err(|e| format!("new_float_array: {e}"))?;

        env.set_float_array_region(&array, 0, bounds)
            .map_err(|e| format!("set_float_array_region: {e}"))?;

        let args = [JValue::from(&array)];

        env.call_static_method(&class, "setControlBoundsFromNative", "([F)V", &args)
            .map_err(|e| format!("call_static_method setControlBoundsFromNative: {e}"))?;

        Ok(())
    }

    /// Shortcut for the common "no args, returns void" shape.
    fn invoke_static_void(method: &str) -> Result<(), String> {
        invoke_static(method, "()V", &[] as &[JValue])
    }

    /// Common path: invoke a `void` static method on the cached
    /// `Drawing` class with optional JNI args. All show/hide/back/
    /// set-live-ink-style calls go through here; this also makes
    /// the error message uniform.
    ///
    /// Threading: ndk_context's JavaVM is process-global once
    /// initialised; `attach_current_thread` is safe to call from any
    /// thread. We deliberately do NOT use `env.find_class` — the
    /// attached `JNIEnv` on a Rust-spawned thread (the render thread
    /// in particular) carries the *system* class loader, which can't
    /// see `io.crates.drawing.Drawing` and throws
    /// `ClassNotFoundException`. The cached `GlobalRef` was created
    /// in `cacheJniClass` from the companion's static init, which
    /// runs on a Java-originating thread that has the app class
    /// loader.
    fn invoke_static(method: &str, sig: &str, args: &[JValue]) -> Result<(), String> {
        let ctx = ndk_context::android_context();
        let vm_ptr = ctx.vm();
        if vm_ptr.is_null() {
            return Err(
                "ndk_context JavaVM is null — Keyring.initializeNdkContext must run first".into(),
            );
        }
        // SAFETY: ndk_context guarantees `vm()` returns a JavaVM
        // pointer obtained from the JVM during MainActivity.onCreate,
        // valid for the remainder of the process.
        let vm = unsafe { JavaVM::from_raw(vm_ptr.cast()) }
            .map_err(|e| format!("JavaVM::from_raw: {e}"))?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("attach_current_thread: {e}"))?;

        let global_ref = super::DRAWING_CLASS.get().ok_or_else(|| {
            "Drawing class not yet cached — Drawing companion static init must have run".to_string()
        })?;
        // SAFETY: GlobalRef holds the same jobject we received as a
        // jclass from Kotlin's `Drawing::class.java`; JClass is a
        // transparent wrapper over JObject in the jni crate. Treating
        // the raw pointer as a borrowed JClass for the duration of
        // this call is sound because the GlobalRef keeps the
        // underlying class alive for the rest of the process.
        let class = unsafe { JClass::from_raw(global_ref.as_raw()) };
        env.call_static_method(&class, method, sig, args)
            .map_err(|e| format!("call_static_method {method}: {e}"))?;
        Ok(())
    }
}
