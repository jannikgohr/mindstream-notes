package com.jannikgohr.mindstream_notes

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * Native app-restart bridge.
 *
 * Desktop switches vaults by relaunching via @tauri-apps/plugin-process,
 * but that plugin is desktop-only and process relaunch is unreliable on
 * Android. The mobile vault switch instead writes the new active profile
 * to profiles.json and then calls this to reboot the process so boot
 * re-resolves the active vault.
 *
 * Rust calls [restartFromNative] via JNI (see src-tauri/src/app_restart.rs).
 * JNI symbol mangling: the Rust export must resolve to
 * `Java_com_jannikgohr_mindstream_1notes_AppRestart_00024Companion_cacheJniClass`,
 * so the package, class name and `$Companion` are all load-bearing —
 * renaming any of them breaks the link at startup.
 */
class AppRestart {
    companion object {
        init {
            // Same library the Keyring / Drawing JNI symbols live in —
            // the Rust restart code is statically linked into
            // libmindstream_notes_lib.so. loadLibrary is idempotent, so
            // it's fine that the other bridges also load it.
            System.loadLibrary("mindstream_notes_lib")
            // Hand Rust a GlobalRef to this class so a Tauri command
            // thread can call restartFromNative without its own
            // find_class() (which fails for app classes off the main
            // thread). Must run AFTER loadLibrary.
            cacheJniClass(AppRestart::class.java)
        }

        /**
         * Application context stashed by [init] from
         * MainActivity.onCreate. Held for the process lifetime; a
         * restart requested before init is a logged no-op.
         */
        @Volatile
        private var appContext: Context? = null

        /** Called from MainActivity.onCreate. */
        fun init(context: Context) {
            appContext = context.applicationContext
        }

        /**
         * Rebuild the launcher task and kill the current process. Posts
         * to the main thread; [Intent.makeRestartActivityTask] carries
         * FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TASK so the fresh
         * task replaces the current one (the ProcessPhoenix pattern).
         * Rust invokes this from a JNI-attached runtime thread, so the
         * main-thread hop keeps the Activity teardown on the UI thread.
         */
        @JvmStatic
        fun restartFromNative() {
            val ctx = appContext
            if (ctx == null) {
                Log.e("MindstreamRestart", "restart requested before init(); ignoring")
                return
            }
            Handler(Looper.getMainLooper()).post {
                val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
                val component = launch?.component
                if (component == null) {
                    Log.e("MindstreamRestart", "no launch intent for ${ctx.packageName}")
                    return@post
                }
                Log.i("MindstreamRestart", "restarting process into fresh launcher task")
                val restart = Intent.makeRestartActivityTask(component)
                ctx.startActivity(restart)
                Runtime.getRuntime().exit(0)
            }
        }

        // No @JvmStatic: the symbol must mangle to the Companion form the
        // Rust extern in src-tauri/src/app_restart.rs resolves.
        external fun cacheJniClass(klass: Class<*>)
    }
}
