package com.jannikgohr.mindstream_notes

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import io.crates.drawing.Drawing
import io.crates.keyring.Keyring

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Initialise the NDK context BEFORE delegating to super.onCreate:
    // TauriActivity boots the Rust runtime during super.onCreate, which
    // in turn runs lib.rs::init_keyring → android_native_keyring_store
    // ::Store::new(). That call panics if ndk-context isn't populated.
    //
    // The drawing plugin also relies on ndk_context (its show/hide
    // callbacks fetch the JavaVM that gets stashed here), so this same
    // init covers both. Don't reorder — Tauri's super.onCreate is the
    // boundary after which Rust code starts running.
    Keyring.initializeNdkContext(this.applicationContext)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  /**
   * WryActivity's official "the webview now exists" hook — equivalent
   * to a Tauri mobile plugin's `Plugin.load(webView)`. We use it to
   * attach the native drawing layer as a sibling of the WebView so the
   * SurfaceView lives in the same ViewGroup; visibility is then
   * toggled by JS via the `drawing_show` / `drawing_hide` Tauri
   * commands (see src-tauri/src/drawing/mod.rs).
   */
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    Drawing.attach(this, webView)
  }

  /**
   * Tear down the native drawing surface here, while EGL is still
   * valid. Letting it survive to Activity.onStop / onDestroy means
   * Android's GL teardown invalidates the EGL display under wgpu's
   * feet, and wgpu's swap-chain Drop hits a destroyed pthread mutex
   * (FORTIFY SIGABRT, two threads racing on the same mutex addr).
   *
   * Detach is a no-op when nothing is attached — safe to call on every
   * pause regardless of whether an ink note is open. If a SurfaceView
   * was actually attached, Drawing flags itself so the matching
   * [onResume] below re-creates it. (Pre-resume-hook this was assumed
   * to be re-driven by DrawingNoteEditor's onMount, but the Svelte
   * component stays mounted across the activity-pause lifecycle, so
   * onMount doesn't fire a second time and the user was left with a
   * frozen ink view requiring back+forward navigation to recover.)
   */
  override fun onPause() {
    Drawing.detach()
    super.onPause()
  }

  /**
   * Pair to [onPause]: re-create the drawing SurfaceView if it was
   * torn down for the pause. No-op when nothing was attached (e.g.
   * user was on a non-ink screen at pause time) or when JS hid the
   * ink note explicitly during the paused window.
   *
   * Order matters: super.onResume first so wry / the WebView finish
   * their own resume bookkeeping before we touch the view tree.
   */
  override fun onResume() {
    super.onResume()
    Drawing.resume()
  }
}
