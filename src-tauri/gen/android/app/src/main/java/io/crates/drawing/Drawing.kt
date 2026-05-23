package io.crates.drawing

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.util.Log
import android.view.MotionEvent
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.ViewGroup
import android.webkit.WebView

/**
 * Native "ink" drawing surface — POC.
 *
 * Mirrors the architecture from the audit (`io.crates.keyring.Keyring`
 * gave us the canonical raw-JNI pattern; `tauri-plugin-barcode-scanner`
 * gave us the sibling-view injection pattern). The two are stitched
 * together here:
 *
 *   - `attach(activity, webView)` runs from MainActivity.onWebViewCreate,
 *     which is WryActivity's official "the webview now exists" hook
 *     (equivalent to a Tauri mobile plugin's `Plugin.load(webView)`).
 *   - `Drawing.instance.show()` injects a SurfaceView as a sibling of
 *     the WebView. Visibility / lifecycle is driven by JS through Rust
 *     via the `Drawing.showFromNative()` / `hideFromNative()` callbacks
 *     defined in the companion below.
 *   - The SurfaceView captures stylus / touch input directly and pushes
 *     each sample (incl. historical buffered samples for >120Hz devices)
 *     straight to Rust via `pushPoint`. We never go through Tauri's
 *     `@Command` IPC for input — that pipeline would JSON-serialise
 *     every sample and crater on a real stylus.
 *
 * JNI symbol mangling: package + class + `$Companion` are load-bearing,
 * so the Rust exports are `Java_io_crates_drawing_Drawing_00024Companion_*`.
 * Renaming any of those fragments breaks the link at startup — same
 * lesson as the Keyring class comment documents.
 */
class Drawing(private val activity: Activity, private val webView: WebView) {

    /** The currently-attached overlay, or null when hidden. */
    private var view: DrawingSurfaceView? = null

    fun show() {
        activity.runOnUiThread {
            if (view != null) return@runOnUiThread
            val v = DrawingSurfaceView(activity)
            val parent = webView.parent as ViewGroup
            // Match the WebView's bounds so the canvas covers exactly the
            // editor area. The simplest match for now is full-parent — the
            // WebView itself fills the activity content view, so the
            // SurfaceView ends up at the same size implicitly via
            // MATCH_PARENT layout params.
            v.layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            parent.addView(v)
            // Make the WebView transparent so any UI rendered by the
            // Svelte DrawingNoteEditor (even just a background colour)
            // doesn't sit between us and the user. Cosmetic-only for the
            // POC because setZOrderOnTop(true) on the SurfaceView already
            // puts our content above the WebView; flip it anyway so the
            // peek-through is consistent if we later drop zOrderOnTop.
            webView.setBackgroundColor(Color.TRANSPARENT)
            view = v
        }
    }

    fun hide() {
        activity.runOnUiThread {
            val v = view ?: return@runOnUiThread
            Log.i("MindstreamDrawing", "Drawing.hide: detaching SurfaceView")
            (v.parent as? ViewGroup)?.removeView(v)
            view = null
        }
    }

    /**
     * UI-thread-only synchronous tear-down. Used from MainActivity
     * lifecycle hooks (onPause, onDestroy) — those callbacks run on
     * the UI thread, so we skip the runOnUiThread bounce and the
     * SurfaceView detach happens immediately. Inside the detach,
     * `SurfaceView.onDetachedFromWindow` fires `surfaceDestroyed`
     * synchronously, which calls into Rust's `clear_surface`, which
     * blocks until the render thread has dropped wgpu's GpuState.
     * By the time this method returns, the EGL handles wgpu held
     * are gone — safe for the Activity to continue tearing down its
     * own GL context.
     */
    fun hideSync() {
        check(android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) {
            "hideSync must be called on the UI thread"
        }
        val v = view ?: return
        Log.i("MindstreamDrawing", "Drawing.hideSync: detaching SurfaceView (UI thread)")
        (v.parent as? ViewGroup)?.removeView(v)
        view = null
    }

    companion object {
        init {
            // Same library the Keyring JNI symbols live in — the Rust
            // drawing code is statically linked into libmindstream_notes_lib.so
            // alongside the rest of the app. System.loadLibrary is
            // idempotent so it's fine that Keyring also loaded it.
            System.loadLibrary("mindstream_notes_lib")
        }

        /**
         * Held by MainActivity once `attach` runs in onWebViewCreate.
         * Lives for the activity's lifetime; the showFromNative /
         * hideFromNative callbacks bounce off it, so a Rust call that
         * arrives before attach is a silent no-op.
         */
        @Volatile
        private var instance: Drawing? = null

        /** Called from MainActivity.onWebViewCreate. */
        fun attach(activity: Activity, webView: WebView) {
            instance = Drawing(activity, webView)
        }

        /**
         * Called from MainActivity.onPause. Tears down our SurfaceView +
         * wgpu state while EGL is still valid — leaving cleanup to
         * Activity.onStop / onDestroy runs it after the system has
         * already invalidated the EGL display, which triggers wgpu's
         * Drop into a destroyed mutex (FORTIFY SIGABRT).
         */
        fun detach() {
            instance?.hideSync()
        }

        // ---- Called from Rust via JNI (jni::ui::invoke_static_void) ----
        // @JvmStatic so they show up as plain static methods on the
        // Drawing class itself — call_static_method on the Rust side
        // would otherwise need to dig out the Companion field. The
        // external functions below intentionally DON'T use @JvmStatic
        // because that changes the JNI symbol-mangling and would break
        // the matching Rust exports.

        @JvmStatic
        fun showFromNative() {
            instance?.show()
        }

        @JvmStatic
        fun hideFromNative() {
            instance?.hide()
        }

        /**
         * Called from Rust when the in-egui Back button is tapped.
         * We don't tear down the SurfaceView ourselves here — that
         * happens via the JS side: dispatching a `drawing-back`
         * CustomEvent on `window` triggers the Svelte mobile shell
         * to navigate away, which unmounts DrawingNoteEditor, which
         * calls drawingHide, which lands back here via hideFromNative.
         * Going through JS keeps the back behaviour symmetric with
         * any future in-app back affordance the Svelte side adds.
         */
        @JvmStatic
        fun backFromNative() {
            val inst = instance ?: return
            inst.activity.runOnUiThread {
                Log.i("MindstreamDrawing", "backFromNative: dispatching drawing-back JS event")
                inst.webView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('drawing-back'))",
                    null
                )
            }
        }

        // ---- Rust JNI exports (called from DrawingSurfaceView below) ----
        // No @JvmStatic on these: their symbol must mangle to
        // Java_io_crates_drawing_Drawing_00024Companion_<name>.
        external fun setSurface(surface: Surface, width: Int, height: Int)
        external fun resizeSurface(width: Int, height: Int)
        external fun clearSurface()
        external fun pushPoint(x: Float, y: Float, action: Int)
    }
}

/**
 * The actual hardware-accelerated surface we draw into.
 *
 *   - `setZOrderOnTop(true)` puts the surface above the activity's main
 *     window content (i.e. above the WebView). For the POC this is
 *     fine: no Svelte UI sits between the user and the canvas. When
 *     we eventually want a transparent egui toolbar above the canvas
 *     with the WebView further on top, we'll flip this off and rely
 *     on WebView transparency instead — see the audit's gotcha #1.
 *   - `PixelFormat.TRANSLUCENT` is required for the alpha channel to
 *     actually composite; without it the surface is opaque and any
 *     LoadOp::Clear(TRANSPARENT) on the wgpu side just paints black.
 *   - `onTouchEvent` iterates historical samples first (chronologically
 *     older — Android's MotionEvent buffers up to ~240Hz of digitizer
 *     data between vsync ticks) then the current sample. Returning
 *     `true` consumes the event so it doesn't bubble to the WebView.
 */
private class DrawingSurfaceView(context: Context) :
    SurfaceView(context), SurfaceHolder.Callback {

    init {
        setZOrderOnTop(true)
        holder.setFormat(PixelFormat.TRANSLUCENT)
        holder.addCallback(this)
        isFocusable = true
        isClickable = true
    }

    override fun surfaceCreated(holder: SurfaceHolder) {
        Log.i("MindstreamDrawing", "surfaceCreated w=$width h=$height")
        // width/height may still be 0 at this point on some devices —
        // surfaceChanged fires immediately after with the real size, at
        // which point the Rust side calls resize and reconfigures wgpu.
        Drawing.setSurface(holder.surface, width, height)
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        Log.i("MindstreamDrawing", "surfaceChanged w=$width h=$height format=$format")
        Drawing.resizeSurface(width, height)
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        Log.i("MindstreamDrawing", "surfaceDestroyed — entering sync wait")
        // Drop the wgpu surface before the underlying ANativeWindow
        // becomes invalid; the Rust side keeps its render thread and
        // accumulated geometry around so a return-from-background just
        // rebuilds the surface. clearSurface blocks until the render
        // thread acks — that's the lifecycle ordering that prevents
        // wgpu's swap-chain teardown from racing past EGL invalidation.
        Drawing.clearSurface()
        Log.i("MindstreamDrawing", "surfaceDestroyed — sync wait complete")
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val action = event.actionMasked
        // Diagnostic during POC bring-up: confirms touches actually
        // reach the SurfaceView even if nothing visible appears. The
        // matching Rust-side log lives in render.rs::push_sample.
        // Drop these once the pipeline is verified end-to-end.
        Log.d(
            "MindstreamDrawing",
            "onTouchEvent action=$action history=${event.historySize} x=${event.x} y=${event.y}"
        )
        // Historical samples are the buffered digitizer reads between
        // the previous frame and this MotionEvent batch — replaying
        // them is what gets us the full pen sample rate instead of the
        // ~60Hz vsync rate. Iterate in order, then read the current
        // sample fields last so the stroke ends at the freshest point.
        val historySize = event.historySize
        for (h in 0 until historySize) {
            Drawing.pushPoint(
                event.getHistoricalX(h),
                event.getHistoricalY(h),
                action
            )
        }
        Drawing.pushPoint(event.x, event.y, action)
        return true
    }
}
