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
    // The drawing plugin also relies on ndk_context (its live-overlay
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
   * attach the live-ink overlay bridge as a sibling of the WebView so
   * the SurfaceView lives in the same ViewGroup; visibility is then
   * toggled by JS via the `drawing_show_live_ink_overlay` /
   * `drawing_hide_live_ink_overlay` Tauri commands (see
   * src-tauri/src/drawing/mod.rs).
   */
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    Drawing.attach(this, webView)
  }

  /**
   * Detach the live overlay here. No-op when nothing is attached, so
   * safe to call on every pause regardless of whether an ink note is
   * open. If a SurfaceView was actually attached, Drawing flags itself
   * so the matching [onResume] below re-creates it — the Svelte editor
   * stays mounted across the activity-pause lifecycle, so we can't
   * lean on its onMount to re-show the overlay.
   */
  override fun onPause() {
    Drawing.detach()
    super.onPause()
  }

  /**
   * Pair to [onPause]: re-create the live overlay if it was torn down
   * for the pause. No-op when nothing was attached (e.g. user was on a
   * non-ink screen at pause time) or when JS hid the ink note
   * explicitly during the paused window.
   *
   * Order matters: super.onResume first so wry / the WebView finish
   * their own resume bookkeeping before we touch the view tree.
   */
  override fun onResume() {
    super.onResume()
    Drawing.resume()
  }
}
