//! Native app restart — Android only.
//!
//! Desktop switches vaults by relaunching through
//! `@tauri-apps/plugin-process` (`relaunch()`), but that plugin is
//! desktop-only and process relaunch is unreliable on Android. The
//! mobile vault switch therefore writes the new active profile to
//! `profiles.json` and then reboots the process here so boot
//! re-resolves the now-active vault (see `profiles.rs` + `lib.rs`
//! setup).
//!
//! The `restart_app` command is registered only on Android; JS calls
//! `switch_profile` then invokes it, falling back to a "relaunch
//! manually" notice on any target where the command is absent.
//!
//! Rust reaches Kotlin through the same JNI class-caching dance the
//! drawing bridge uses: a Tauri command runs on a runtime thread that
//! can't `find_class` an app class, so it dispatches off a `GlobalRef`
//! cached from the `AppRestart` companion's static init.

#[cfg(target_os = "android")]
mod android {
    use std::sync::OnceLock;

    use jni::objects::{GlobalRef, JClass, JObject};
    use jni::{JNIEnv, JavaVM};

    /// Global ref to the Kotlin `AppRestart` class, populated by
    /// `cacheJniClass` from the companion's static `init` block.
    static RESTART_CLASS: OnceLock<GlobalRef> = OnceLock::new();

    /// JNI symbol mangling: package `com.jannikgohr.mindstream_notes`
    /// (the `_` in `mindstream_notes` mangles to `_1`) + class
    /// `AppRestart` + `$Companion` (`_00024Companion`). Renaming any
    /// fragment breaks the link at startup.
    #[no_mangle]
    pub extern "system" fn Java_com_jannikgohr_mindstream_1notes_AppRestart_00024Companion_cacheJniClass(
        env: JNIEnv,
        _companion: JClass,
        klass: JObject,
    ) {
        match env.new_global_ref(klass) {
            Ok(global_ref) => {
                if RESTART_CLASS.set(global_ref).is_err() {
                    log::warn!("[restart] cacheJniClass called more than once; ignoring");
                } else {
                    log::info!("[restart] cached AppRestart class ref");
                }
            }
            Err(e) => log::error!("[restart] new_global_ref(AppRestart.class) failed: {e}"),
        }
    }

    /// Call `AppRestart.restartFromNative()` to reboot the process.
    /// Returns once the call is dispatched — the actual restart runs on
    /// the Android main thread and kills this process, so a successful
    /// invocation never returns to JS.
    pub fn restart() -> Result<(), String> {
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

        let global_ref = RESTART_CLASS.get().ok_or_else(|| {
            "AppRestart class not yet cached; AppRestart companion static init must have run"
                .to_string()
        })?;
        let class = unsafe { JClass::from_raw(global_ref.as_raw()) };
        env.call_static_method(&class, "restartFromNative", "()V", &[])
            .map_err(|e| format!("call_static_method restartFromNative: {e}"))?;
        Ok(())
    }
}

/// Restart the running app process. Android-only — the mobile vault
/// switch invokes this after `switch_profile` writes the new active
/// vault so boot re-opens it. Desktop relaunches from JS via
/// `@tauri-apps/plugin-process` instead and never calls this.
#[cfg(target_os = "android")]
#[tauri::command]
pub fn restart_app() -> Result<(), String> {
    android::restart()
}
