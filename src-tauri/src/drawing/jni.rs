//! JNI boundary for the drawing plugin.
//!
//! Two directions:
//!
//!   Kotlin → Rust  (data plane — high-frequency)
//!     setSurface(Surface, w, h)
//!     resizeSurface(w, h)
//!     clearSurface()
//!     pushPoint(x, y, action)
//!
//!     Exposed as `Java_io_crates_drawing_Drawing_00024Companion_*`
//!     symbols. Package + class + `$Companion` are load-bearing for
//!     the symbol mangling, matching the proven `io.crates.keyring`
//!     pattern already in this repo.
//!
//!   Rust → Kotlin  (control plane — low-frequency)
//!     `ui::call_show()`  → Drawing.showFromNative()
//!     `ui::call_hide()`  → Drawing.hideFromNative()
//!
//!     Uses the JavaVM stashed in ndk_context by Keyring.kt's
//!     `initializeNdkContext` in MainActivity.onCreate. The Kotlin
//!     companion methods are `@JvmStatic` so the call site just
//!     hits a plain static method on `Drawing` directly.

use std::ptr::NonNull;
use std::sync::OnceLock;

use jni::objects::{GlobalRef, JClass, JObject};
use jni::sys::{jfloat, jint};
use jni::JNIEnv;

use crate::drawing::render;

/// Global ref to the Kotlin `io.crates.drawing.Drawing` class,
/// populated by `cacheJniClass` from the companion's static `init`
/// block. We need this because `JavaVM::attach_current_thread` on a
/// Rust-spawned thread (our render thread) returns a `JNIEnv` whose
/// `find_class` only sees the *system* class loader — app classes
/// like ours throw `ClassNotFoundException`. Stashing a GlobalRef
/// made during Java-originating class loading sidesteps that
/// entirely.
static DRAWING_CLASS: OnceLock<GlobalRef> = OnceLock::new();

// ---------- Kotlin → Rust ----------

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
/// The render thread takes ownership of an `ANativeWindow*` derived
/// from the Java Surface; ANativeWindow_fromSurface already acquires
/// a reference, which is balanced by `AndroidWindow::drop` on the
/// render side.
#[no_mangle]
pub extern "system" fn Java_io_crates_drawing_Drawing_00024Companion_setSurface(
    mut env: JNIEnv,
    _class: JClass,
    surface: JObject,
    width: jint,
    height: jint,
) {
    let native_window = unsafe {
        ndk_sys::ANativeWindow_fromSurface(
            env.get_raw() as *mut _,
            surface.as_raw() as *mut _,
        )
    };
    let Some(ptr) = NonNull::new(native_window) else {
        log::error!("[drawing] ANativeWindow_fromSurface returned null");
        return;
    };
    render::set_surface(ptr, width.max(0) as u32, height.max(0) as u32);
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

/// `Drawing.Companion.pushPoint(x, y, action)` — a single MotionEvent
/// sample (or one element of the historical-sample sweep). `action`
/// uses Android's MotionEvent.ACTION_* integer constants verbatim;
/// `render.rs` matches on the same values.
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
    action: jint,
) {
    render::push_sample(x, y, action);
}

// ---------- Rust → Kotlin (UI thread callbacks) ----------

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

    /// Call `Drawing.backFromNative()` — dispatches a `drawing-back`
    /// CustomEvent on the WebView's window so the Svelte mobile
    /// shell can navigate back to its home view. Triggered when the
    /// user taps the in-egui Back button.
    pub fn call_back() -> Result<(), String> {
        invoke_static_void("backFromNative")
    }

    /// Common path: invoke a no-arg `void` static method on the
    /// cached `Drawing` class. All three of show/hide/back go through
    /// here; this also makes the error message uniform.
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
    fn invoke_static_void(method: &str) -> Result<(), String> {
        let ctx = ndk_context::android_context();
        let vm_ptr = ctx.vm();
        if vm_ptr.is_null() {
            return Err(
                "ndk_context JavaVM is null — Keyring.initializeNdkContext must run first"
                    .into(),
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
            "Drawing class not yet cached — Drawing companion static init must have run"
                .to_string()
        })?;
        // SAFETY: GlobalRef holds the same jobject we received as a
        // jclass from Kotlin's `Drawing::class.java`; JClass is a
        // transparent wrapper over JObject in the jni crate. Treating
        // the raw pointer as a borrowed JClass for the duration of
        // this call is sound because the GlobalRef keeps the
        // underlying class alive for the rest of the process.
        let class = unsafe { JClass::from_raw(global_ref.as_raw()) };
        env.call_static_method(&class, method, "()V", &[] as &[JValue])
            .map_err(|e| format!("call_static_method {method}: {e}"))?;
        Ok(())
    }
}
