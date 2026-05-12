package io.crates.keyring

import android.content.Context

/**
 * JNI bridge for `android-native-keyring-store` (a v4 keyring-rs
 * companion crate). The Rust code on the other side reads
 * `ndk_context::android_context()` to fetch the JavaVM + Application
 * pointer; that handle has to be populated from Kotlin before any
 * `Store::new()` runs, otherwise Rust panics.
 *
 * The package path (`io.crates.keyring`) and class name (`Keyring`)
 * are load-bearing: the JNI symbol exported by the crate is
 * `Java_io_crates_keyring_Keyring_00024Companion_initializeNdkContext`
 * — renaming this file breaks the lookup.
 *
 * MainActivity.onCreate calls [initializeNdkContext] before delegating
 * to super.onCreate, which is where Tauri spins up the Rust runtime
 * and our lib.rs::init_keyring registers the credential store.
 */
class Keyring {
    companion object {
        init {
            // The android-native-keyring-store crate is statically linked
            // into our Rust cdylib, so its JNI symbols end up in
            // libmindstream_notes_lib.so rather than a standalone .so.
            // System.loadLibrary is idempotent — TauriActivity may have
            // loaded it already; this guarantees it has by the time
            // initializeNdkContext is dispatched.
            System.loadLibrary("mindstream_notes_lib")
        }

        // No @JvmStatic: JNI lookup must resolve to
        // Java_io_crates_keyring_Keyring_00024Companion_initializeNdkContext
        // (the symbol the crate exports). @JvmStatic would strip $Companion
        // from the lookup and cause UnsatisfiedLinkError at startup.
        external fun initializeNdkContext(context: Context)
    }
}
