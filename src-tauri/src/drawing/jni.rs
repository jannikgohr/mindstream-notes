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

use jni::objects::{JClass, JObject};
use jni::sys::{jfloat, jint};
use jni::JNIEnv;

use crate::drawing::render;

// ---------- Kotlin → Rust ----------

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
    use jni::objects::JValue;
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

    /// Common path: look up `io.crates.drawing.Drawing` and call a
    /// no-arg `void` static method on it. Both show/hide go through
    /// here; this also makes the error message uniform.
    ///
    /// Threading: ndk_context's JavaVM is process-global once
    /// initialised; `attach_current_thread` is safe to call from
    /// whichever Tokio worker thread happens to be running the Tauri
    /// command. The Kotlin side dispatches the actual UI work to
    /// `runOnUiThread` so we don't have to do that here.
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

        let class = env
            .find_class("io/crates/drawing/Drawing")
            .map_err(|e| format!("find_class Drawing: {e}"))?;
        env.call_static_method(class, method, "()V", &[] as &[JValue])
            .map_err(|e| format!("call_static_method {method}: {e}"))?;
        Ok(())
    }
}
