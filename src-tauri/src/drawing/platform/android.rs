//! Android live-ink JNI bridge.
//!
//! The canonical ink editor is the WebView/Svelte canvas. Android still
//! owns a small native latency helper: Kotlin captures `MotionEvent`s
//! and paints the in-flight wet stroke with
//! `CanvasFrontBufferedRenderer`, while forwarding the same event to
//! the WebView for canonical document mutation.
//!
//! This Rust module is intentionally control-plane only:
//!
//! - cache a `Drawing` class ref so Rust commands can call Kotlin
//!   static methods from any thread,
//! - expose the Rust-to-Kotlin live-overlay commands used by JS via
//!   Tauri.

use std::sync::OnceLock;

use jni::objects::{GlobalRef, JClass, JObject};
use jni::JNIEnv;

/// Global ref to the Kotlin `io.crates.drawing.Drawing` class,
/// populated by `cacheJniClass` from the companion's static `init`
/// block. `JavaVM::attach_current_thread` on a Rust-spawned thread
/// cannot reliably `find_class` for app classes, so callers use this
/// cached class object instead.
static DRAWING_CLASS: OnceLock<GlobalRef> = OnceLock::new();

#[no_mangle]
pub extern "system" fn Java_io_crates_drawing_Drawing_00024Companion_cacheJniClass(
    env: JNIEnv,
    _companion: JClass,
    klass: JObject,
) {
    match env.new_global_ref(klass) {
        Ok(global_ref) => {
            if DRAWING_CLASS.set(global_ref).is_err() {
                log::warn!("[drawing] cacheJniClass called more than once; ignoring");
            } else {
                log::info!("[drawing] cached Drawing class ref for live-overlay callbacks");
            }
        }
        Err(e) => log::error!("[drawing] new_global_ref(Drawing.class) failed: {e}"),
    }
}

pub mod ui {
    use jni::objects::{JClass, JValue};
    use jni::JavaVM;

    pub fn call_show_live_overlay() -> Result<(), String> {
        invoke_static_void("showLiveOverlayFromNative")
    }

    pub fn call_hide_live_overlay() -> Result<(), String> {
        invoke_static_void("hideLiveOverlayFromNative")
    }

    pub fn call_enter_immersive_ink_mode() -> Result<(), String> {
        invoke_static_void("enterImmersiveInkModeFromNative")
    }

    pub fn call_exit_immersive_ink_mode() -> Result<(), String> {
        invoke_static_void("exitImmersiveInkModeFromNative")
    }

    pub fn call_cancel_live_ink() -> Result<(), String> {
        invoke_static_void("cancelLiveInkFromNative")
    }

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

    fn invoke_static_void(method: &str) -> Result<(), String> {
        invoke_static(method, "()V", &[])
    }

    fn invoke_static(method: &str, sig: &str, args: &[JValue<'_, '_>]) -> Result<(), String> {
        let ctx = ndk_context::android_context();
        let vm_ptr = ctx.vm();
        if vm_ptr.is_null() {
            return Err(
                "ndk_context JavaVM is null; Keyring.initializeNdkContext must run first".into(),
            );
        }
        let vm = unsafe { JavaVM::from_raw(vm_ptr.cast()) }
            .map_err(|e| format!("JavaVM::from_raw: {e}"))?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("attach_current_thread: {e}"))?;

        let global_ref = super::DRAWING_CLASS.get().ok_or_else(|| {
            "Drawing class not yet cached; Drawing companion static init must have run".to_string()
        })?;
        let class = unsafe { JClass::from_raw(global_ref.as_raw()) };

        env.call_static_method(&class, method, sig, args)
            .map_err(|e| format!("call_static_method {method}: {e}"))?;

        Ok(())
    }
}
