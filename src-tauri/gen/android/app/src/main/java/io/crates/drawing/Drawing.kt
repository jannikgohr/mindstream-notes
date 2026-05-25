package io.crates.drawing

import android.app.Activity
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.MotionEvent
import android.view.MotionPredictor
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.graphics.lowlatency.CanvasFrontBufferedRenderer

/**
 * Logical height of the Svelte mobile-editor header, in dp. Mirrors
 * Tailwind `h-12` (= 3rem = 48dp) used by MobileEditor.svelte. We
 * inset the SurfaceView by this (plus the system-bar inset) so the
 * Svelte header — and specifically its back arrow / title /
 * favourite star — stays visible and tappable above the canvas.
 *
 * Brittle in the sense that a future Svelte redesign would need this
 * constant updated. A cleaner approach is to have JS measure the
 * header element and report the height via a Tauri command on each
 * resize; left as a follow-up.
 */
private const val MOBILE_HEADER_HEIGHT_DP = 48

/**
 * High-volume touch diagnostics. Keep disabled for normal drawing:
 * S Pen input can deliver hundreds of samples per second, and logcat
 * writes on that path are enough to create the lag these logs were
 * originally added to investigate.
 */
private const val DRAWING_INPUT_LOGS = false

private const val FRONT_BUFFER_TOOLBAR_HEIGHT_PX = 120f
private const val FRONT_BUFFER_CANCEL_DELAY_MS = 48L

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
            // Request the highest-Hz display mode the panel offers
            // (at the current resolution) while an ink note is open.
            // 120Hz halves per-vsync latency on phones like the S23+
            // vs the default 60Hz. Released in hide() so the markdown
            // editor + general WebView UI stays on adaptive refresh.
            // Triggers a surface re-create on devices that actually
            // switch modes — same path that handles rotation, so
            // SurfaceHolder.Callback already covers it.
            requestHighRefreshRate(activity)
            val v = DrawingSurfaceView(activity)
            val parent = webView.parent as ViewGroup
            // topMargin = system-bar inset + Svelte header height so
            // the SurfaceView sits below MobileEditor's header rather
            // than covering it. The header's back arrow / title /
            // favourite star stay reachable because touches in y <
            // topMargin fall through to the WebView underneath
            // (SurfaceView only receives touches inside its own
            // bounds). The WindowInsets listener inside
            // DrawingSurfaceView reapplies topMargin on rotation /
            // IME show-hide so the offset adapts.
            val params = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            params.topMargin = computeTopInsetPx(parent, activity)
            v.layoutParams = params
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
            releaseRefreshRate(activity)
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
        releaseRefreshRate(activity)
    }

    /**
     * Forward a Rust-driven style update to the active SurfaceView's
     * front-buffer ink layer. No-op if the SurfaceView is currently
     * detached (e.g. user hasn't opened an ink note yet, or has just
     * navigated away). Safe to call from any thread — the style
     * fields on [FrontBufferInk] are `@Volatile` so a write here
     * publishes immediately to the touch / render threads that read
     * them.
     */
    fun setLiveInkStyle(colorArgb: Int, minWidthPx: Float, maxWidthPx: Float) {
        view?.setLiveInkStyle(colorArgb, minWidthPx, maxWidthPx)
    }

    companion object {
        init {
            // Same library the Keyring JNI symbols live in — the Rust
            // drawing code is statically linked into libmindstream_notes_lib.so
            // alongside the rest of the app. System.loadLibrary is
            // idempotent so it's fine that Keyring also loaded it.
            System.loadLibrary("mindstream_notes_lib")
            // Hand Rust a GlobalRef to this class so it can call our
            // @JvmStatic methods from the render thread without doing
            // its own env.find_class(). That find_class fails for app
            // classes on a Rust-spawned thread (the JVM hands those
            // threads the system class loader, which only sees core
            // Android classes) — see jni.rs::DRAWING_CLASS. This must
            // run AFTER loadLibrary because the JNI symbol it dispatches
            // to lives in libmindstream_notes_lib.so.
            cacheJniClass(Drawing::class.java)
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
            Log.i("MindstreamDrawing", "Drawing.attach: native ink bridge attached")
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

        /**
         * Called from Rust to change the live-ink front-buffer overlay's
         * color and stroke-width range. Rust is the source of truth for
         * the active stroke style — Kotlin's FrontBufferInk reads these
         * fields when queueing each segment, so a write here takes
         * effect from the next segment onwards. `colorArgb` packs
         * 0xAARRGGBB matching Android's `Color` int format, which is
         * the same packing Rust uses internally (see strokes_doc.rs
         * `DEFAULT_COLOR`). Widths are in surface pixels (Canvas
         * coordinate space); Rust converts its page-unit constants
         * via the current page-to-surface scale before the call.
         */
        @JvmStatic
        fun setLiveInkStyleFromNative(
            colorArgb: Int,
            minWidthPx: Float,
            maxWidthPx: Float
        ) {
            instance?.setLiveInkStyle(colorArgb, minWidthPx, maxWidthPx)
        }

        // ---- Rust JNI exports (called from DrawingSurfaceView below) ----
        // No @JvmStatic on these: their symbol must mangle to
        // Java_io_crates_drawing_Drawing_00024Companion_<name>.
        external fun setSurface(surface: Surface, width: Int, height: Int)
        external fun resizeSurface(width: Int, height: Int)
        external fun clearSurface()
        external fun pushPoint(
            x: Float,
            y: Float,
            pressure: Float,
            toolType: Int,
            buttons: Int,
            action: Int,
            timeMs: Long
        )

        /**
         * Predicted in-flight sample from android.view.MotionPredictor.
         * Distinct entry point from pushPoint because predicted samples
         * are NOT committed to the persisted stroke — they only paint a
         * transient "predicted lead" segment past the raw head until
         * the next real sample arrives. No action/tool/buttons because
         * a prediction is always mid-stroke MOVE-style. Time is the
         * predicted eventTime (uptimeMillis) so the Rust render thread
         * can age it against other timestamps if needed; today it's
         * only logged.
         */
        external fun pushPredictedPoint(
            x: Float,
            y: Float,
            pressure: Float,
            timeMs: Long
        )

        /**
         * Hands Rust a GlobalRef to the Drawing class so render-thread
         * callbacks (showFromNative/hideFromNative/backFromNative) can
         * dispatch without going through `env.find_class`, which fails
         * for app classes on a Rust-spawned JVM-attached thread. Called
         * exactly once from the companion's static init.
         */
        external fun cacheJniClass(klass: Class<*>)
    }
}

/**
 * Compute the top inset that the drawing SurfaceView's layoutParams
 * should use: system status bar inset (e.g. 74px on Samsung S23+)
 * plus the Svelte header height (48dp × density). Falls back to 0
 * for the system bar if the root window insets aren't available
 * yet (rare; the OnApplyWindowInsetsListener will re-run with the
 * real value soon after attach).
 */
private fun computeTopInsetPx(parent: ViewGroup, activity: Activity): Int {
    val rootInsets = ViewCompat.getRootWindowInsets(parent)
    val systemBarTop = rootInsets
        ?.getInsets(WindowInsetsCompat.Type.systemBars())
        ?.top
        ?: 0
    val density = activity.resources.displayMetrics.density
    val headerHeightPx = (MOBILE_HEADER_HEIGHT_DP * density).toInt()
    return systemBarTop + headerHeightPx
}

/**
 * Ask the system for the highest-refresh-rate display mode that
 * matches the current resolution. Halves per-vsync latency on
 * variable-refresh phones (e.g. ~8.3ms vs ~16.7ms on the S23+'s
 * 120Hz panel). No-op on 60Hz-only displays like the Tab S7 FE —
 * we just don't find a mode with a higher rate.
 *
 * We pick by exact resolution match rather than asking for a raw
 * rate (`preferredRefreshRate`) because some panels expose 120Hz
 * only at a lower resolution; we don't want to silently drop
 * resolution to gain Hz. Mode-id pinning is the safer dial.
 *
 * Setting `preferredDisplayModeId` triggers a surface re-create on
 * devices that actually switch modes — same surfaceDestroyed →
 * surfaceCreated path the rotation listener already handles, so
 * the wgpu side recovers automatically.
 */
private fun requestHighRefreshRate(activity: Activity) {
    val window = activity.window
    @Suppress("DEPRECATION")
    val display = window.windowManager.defaultDisplay
    val currentMode = display.mode
    val target = display.supportedModes
        .filter {
            it.physicalWidth == currentMode.physicalWidth &&
            it.physicalHeight == currentMode.physicalHeight
        }
        .maxByOrNull { it.refreshRate }
    if (target == null || target.refreshRate <= currentMode.refreshRate + 0.5f) {
        Log.i(
            "MindstreamDrawing",
            "no higher-refresh mode available (current=${currentMode.refreshRate}Hz)"
        )
        return
    }
    Log.i(
        "MindstreamDrawing",
        "requesting refresh rate ${target.refreshRate}Hz (modeId=${target.modeId}, was ${currentMode.refreshRate}Hz)"
    )
    val attrs = window.attributes
    attrs.preferredDisplayModeId = target.modeId
    window.attributes = attrs
}

/**
 * Release the refresh-rate preference set by [requestHighRefreshRate]
 * so the rest of the app (Svelte editor, etc.) goes back to the
 * system's adaptive choice. `preferredDisplayModeId = 0` is the
 * documented "no preference" value.
 *
 * Safe to call even if `request` wasn't called (e.g. on devices
 * where the request was a no-op): writing 0 over 0 is a no-op
 * itself.
 */
private fun releaseRefreshRate(activity: Activity) {
    val attrs = activity.window.attributes
    if (attrs.preferredDisplayModeId != 0) {
        Log.i("MindstreamDrawing", "releasing refresh rate preference")
        attrs.preferredDisplayModeId = 0
        activity.window.attributes = attrs
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
 *   - `PixelFormat.OPAQUE` keeps SurfaceFlinger on the cheapest
 *     composition path. The renderer clears the whole surface to white
 *     every frame, so an alpha channel buys us nothing and can add
 *     latency on stylus hardware.
 *   - `onTouchEvent` iterates historical samples first (chronologically
 *     older — Android's MotionEvent buffers up to ~240Hz of digitizer
 *     data between vsync ticks) then the current sample. Returning
 *     `true` consumes the event so it doesn't bubble to the WebView.
 */
private class DrawingSurfaceView(context: Context) :
    SurfaceView(context), SurfaceHolder.Callback {

    /**
     * Android-system motion predictor. Records every MotionEvent and
     * extrapolates forward in time so the inked stroke can paint a
     * "predicted lead" segment past the raw pen position — visual
     * compensation for the ~22 ms digitizer → display floor. Tuned
     * by the platform against many stylus traces, so direction-change
     * wobble is much less of a risk than a hand-rolled velocity
     * extrapolator.
     *
     * Only available on Android 14+ (API 34 / UPSIDE_DOWN_CAKE). On older
     * versions this stays null and the prediction zone is empty —
     * the two-zone (committed + raw head) path still renders.
     *
     * Constructed lazily on first touch rather than in `init {}`
     * because the constructor takes a Context but the SurfaceView's
     * context is the one we already hold — no async lifecycle to
     * worry about.
     */
    private val motionPredictor: MotionPredictor? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            MotionPredictor(context)
        } else {
            null
        }

    private var loggedPredictionSupport = false
    private val frontBufferInk: FrontBufferInk? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            FrontBufferInk(this)
        } else {
            Log.i(
                "MindstreamDrawing",
                "front-buffer ink unavailable sdk=${Build.VERSION.SDK_INT} requires=${Build.VERSION_CODES.Q}"
            )
            null
        }

    init {
        setZOrderOnTop(true)
        holder.setFormat(PixelFormat.OPAQUE)
        holder.addCallback(this)
        isFocusable = true
        isClickable = true
        if (motionPredictor == null) {
            Log.i(
                "MindstreamDrawing",
                "MotionPredictor unavailable sdk=${Build.VERSION.SDK_INT} requires=${Build.VERSION_CODES.UPSIDE_DOWN_CAKE}"
            )
        }
        if (frontBufferInk != null) {
            Log.i("MindstreamDrawing", "front-buffer ink enabled")
        }

        // Reapply the SurfaceView's topMargin on every inset change
        // so rotations / IME show-hide don't leave the canvas
        // overlapping the system bar + Svelte header. On many
        // devices (Samsung S23+ FE included) the system-bar inset
        // doesn't actually change between portrait/landscape, so
        // this listener may never fire — that's fine, the initial
        // `computeTopInsetPx` call in `Drawing.show()` already set
        // the right value. We always return the original insets
        // unconsumed — other views (the WebView in particular) still
        // need to see them.
        ViewCompat.setOnApplyWindowInsetsListener(this) { view, insets ->
            val parent = view.parent as? ViewGroup
            val ctx = view.context as? Activity
            if (parent != null && ctx != null) {
                val newTop = computeTopInsetPx(parent, ctx)
                val params = view.layoutParams
                if (params is ViewGroup.MarginLayoutParams && params.topMargin != newTop) {
                    Log.i(
                        "MindstreamDrawing",
                        "WindowInsets changed → topMargin ${params.topMargin} -> $newTop"
                    )
                    params.topMargin = newTop
                    view.layoutParams = params
                }
            }
            insets
        }

        // Belt-and-braces resize trigger. SurfaceHolder.surfaceChanged
        // is supposed to fire on rotation, but on some devices /
        // Android versions it either doesn't or fires with stale
        // dimensions — symptom: egui toolbar keeps the old portrait
        // width after rotating to landscape until the next touch
        // wakes the render thread.
        //
        // addOnLayoutChangeListener fires reliably whenever the
        // SurfaceView's bounds change (which includes every rotation),
        // so we push a Resize message immediately. But it can fire
        // BEFORE SurfaceFlinger has finished reallocating the
        // underlying ANativeWindow buffers at the new size — meaning
        // wgpu's surface.configure() succeeds at the new dims but
        // get_current_texture returns a buffer of the OLD dims,
        // producing a stretched/stale frame.
        //
        // The follow-up postDelayed calls re-fire the resize so the
        // wgpu surface gets re-configured after buffers have settled.
        // 50ms / 250ms covers both the common case (settle within a
        // frame or two) and the slow case (SurfaceFlinger backed up).
        // Each retry is idempotent: render thread calls surface
        // .configure with the same dims, sets dirty, renders.
        addOnLayoutChangeListener { _, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
            val newWidth = right - left
            val newHeight = bottom - top
            val oldWidth = oldRight - oldLeft
            val oldHeight = oldBottom - oldTop
            if (newWidth == oldWidth && newHeight == oldHeight) return@addOnLayoutChangeListener
            Log.i(
                "MindstreamDrawing",
                "layout changed: ${oldWidth}x${oldHeight} -> ${newWidth}x${newHeight}"
            )
            Drawing.resizeSurface(newWidth, newHeight)
            postDelayed({ Drawing.resizeSurface(newWidth, newHeight) }, 50)
            postDelayed({ Drawing.resizeSurface(newWidth, newHeight) }, 250)
        }
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
        frontBufferInk?.cancel()
        // Drop the wgpu surface before the underlying ANativeWindow
        // becomes invalid; the Rust side keeps its render thread and
        // accumulated geometry around so a return-from-background just
        // rebuilds the surface. clearSurface blocks until the render
        // thread acks — that's the lifecycle ordering that prevents
        // wgpu's swap-chain teardown from racing past EGL invalidation.
        Drawing.clearSurface()
        Log.i("MindstreamDrawing", "surfaceDestroyed — sync wait complete")
    }

    override fun onDetachedFromWindow() {
        frontBufferInk?.release()
        super.onDetachedFromWindow()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val action = event.actionMasked
        // Tool type + button state come from the event-level (not
        // historical-sample-level) accessors — Android batches both
        // per-pointer rather than per-historical-sample, so we read
        // them once and reuse for the whole sweep. `buttonState` is
        // the bitmask of `BUTTON_*` flags currently held; for the
        // S Pen, BUTTON_STYLUS_PRIMARY (0x20) tracks the side
        // button. Forwarded raw to Rust which does the bit tests.
        val toolType = event.getToolType(0)
        val buttons = event.buttonState
        if (DRAWING_INPUT_LOGS) {
            Log.d(
                "MindstreamDrawing",
                "onTouchEvent action=$action history=${event.historySize} x=${event.x} y=${event.y} p=${event.pressure} tool=$toolType buttons=0x${buttons.toString(16)}"
            )
            val osLagMs = SystemClock.uptimeMillis() - event.eventTime
            Log.i(
                "MindstreamDrawing",
                "[drawing.perf.lag] os_dispatch action=$action history=${event.historySize} os_lag=${osLagMs}ms"
            )
        }
        // Historical samples are the buffered digitizer reads between
        // the previous frame and this MotionEvent batch — replaying
        // them is what gets us the full pen sample rate instead of the
        // ~60Hz vsync rate. Iterate in order, then read the current
        // sample fields last so the stroke ends at the freshest point.
        // Pressure: AXIS_PRESSURE is 0..1 for stylus + force-touch
        // capable screens. Devices without pressure sensing report
        // 1.0 by Android convention, but a stray 0.0 (some emulators,
        // some HID drivers) would render variable-width strokes as
        // invisible hairlines — substitute the same 1.0 here so the
        // Rust side never sees the zero.
        // Per-historical-sample timestamps come from
        // getHistoricalEventTime(h); the final sample uses the
        // event-level eventTime. Both are uptimeMillis() (monotonic
        // since boot), which the Rust side divides by 1000 to feed
        // the D1 stroke modeler — which needs strictly non-negative
        // dt across consecutive samples within one stroke.
        val historySize = event.historySize
        val historicalAction =
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                MotionEvent.ACTION_MOVE
            } else {
                action
            }
        for (h in 0 until historySize) {
            pushActualPoint(
                event.getHistoricalX(h),
                event.getHistoricalY(h),
                sanitizePressure(event.getHistoricalPressure(h)),
                toolType,
                buttons,
                historicalAction,
                event.getHistoricalEventTime(h)
            )
        }
        pushActualPoint(
            event.x,
            event.y,
            sanitizePressure(event.pressure),
            toolType,
            buttons,
            action,
            event.eventTime
        )
        // Forward extrapolation via MotionPredictor (API 34+).
        // Record the just-arrived event (the system uses recent
        // recorded events to extrapolate) and ask for a prediction
        // PREDICTION_AHEAD_MS in the future. The result feeds the
        // Rust render thread's "predicted lead" zone — one segment
        // past the raw pen position. Skipped on Down/Up/Cancel
        // because predictions only make sense mid-stroke; firing
        // them on Down would extrapolate from a single point (the
        // predictor would emit garbage or null), and on Up the
        // stroke is over.
        motionPredictor?.let { predictor ->
            if (!loggedPredictionSupport) {
                loggedPredictionSupport = true
                Log.i(
                    "MindstreamDrawing",
                    "MotionPredictor available=${predictor.isPredictionAvailable(event.deviceId, event.source)} device=${event.deviceId} source=0x${event.source.toString(16)}"
                )
            }
            predictor.record(event)
            if (action == MotionEvent.ACTION_MOVE) {
                val targetMs = event.eventTime + PREDICTION_AHEAD_MS
                val predicted: MotionEvent? =
                    predictor.predict(targetMs * 1_000_000L)
                if (predicted != null) {
                    Drawing.pushPredictedPoint(
                        predicted.x,
                        predicted.y,
                        sanitizePressure(predicted.pressure),
                        predicted.eventTime
                    )
                    // recycle() is safe here — we only read the
                    // primitive fields above and don't hold a
                    // reference past this call.
                    predicted.recycle()
                }
            }
        }
        return true
    }

    companion object {
        /**
         * How far ahead, in milliseconds, to ask MotionPredictor to
         * extrapolate. Prediction rendering is currently disabled on
         * the Rust side because speculative endpoints caused visible
         * ghost-line artifacts on the Tab S7 FE.
         */
        private const val PREDICTION_AHEAD_MS: Long = 16L
    }

    private fun pushActualPoint(
        x: Float,
        y: Float,
        pressure: Float,
        toolType: Int,
        buttons: Int,
        action: Int,
        timeMs: Long
    ) {
        Drawing.pushPoint(x, y, pressure, toolType, buttons, action, timeMs)
        frontBufferInk?.onPoint(x, y, pressure, toolType, buttons, action)
    }

    private fun sanitizePressure(raw: Float): Float {
        if (raw.isNaN() || raw <= 0f) return 1f
        if (raw > 1f) return 1f
        return raw
    }

    fun setLiveInkStyle(colorArgb: Int, minWidthPx: Float, maxWidthPx: Float) {
        frontBufferInk?.setStyle(colorArgb, minWidthPx, maxWidthPx)
    }
}

private data class InkSegment(
    val x0: Float,
    val y0: Float,
    val x1: Float,
    val y1: Float,
    val pressure0: Float,
    val pressure1: Float,
    val color: Int,
    val minWidthPx: Float,
    val maxWidthPx: Float
)

private class FrontBufferInk(private val surfaceView: SurfaceView) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val renderer =
        CanvasFrontBufferedRenderer(surfaceView, object : CanvasFrontBufferedRenderer.Callback<InkSegment> {
            override fun onDrawFrontBufferedLayer(
                canvas: Canvas,
                bufferWidth: Int,
                bufferHeight: Int,
                param: InkSegment
            ) {
                paint.color = param.color
                paint.strokeWidth = widthForPressure(
                    param.pressure0,
                    param.pressure1,
                    param.minWidthPx,
                    param.maxWidthPx,
                )
                canvas.drawLine(param.x0, param.y0, param.x1, param.y1, paint)
            }

            override fun onDrawMultiBufferedLayer(
                canvas: Canvas,
                bufferWidth: Int,
                bufferHeight: Int,
                params: Collection<InkSegment>
            ) {
                // The Rust/wgpu layer owns committed strokes. This
                // renderer is only the transient low-latency head.
            }
        })

    // Style state — Rust drives these via `Drawing.setLiveInkStyleFromNative`.
    // Defaults reproduce the pre-Rust-driven look (debug-blue stylus,
    // 2–5 px pressure ramp) so the overlay still renders correctly
    // if Rust hasn't pushed a style yet — e.g. the very first
    // segment after surface attach, before the render thread has
    // had a chance to call back. `@Volatile` because writes come
    // from a Rust-spawned JNI-attached thread and reads happen on
    // the touch + front-buffer render threads.
    @Volatile private var styleColor: Int = Color.rgb(0, 102, 255)
    @Volatile private var styleMinWidthPx: Float = 2.0f
    @Volatile private var styleMaxWidthPx: Float = 5.0f

    private var lastX = 0f
    private var lastY = 0f
    private var lastPressure = 1f
    private var inStroke = false
    private var suppressed = false
    private var generation = 0
    private var loggedFirstSegment = false

    fun setStyle(colorArgb: Int, minWidthPx: Float, maxWidthPx: Float) {
        styleColor = colorArgb
        // Sanitise at the boundary: a zero / negative width would
        // render as an invisible hairline (or throw on some
        // platforms); clamp to a hard floor matching the original
        // 2 px default. Inverted ranges (min > max) get swapped
        // rather than rejected — easier to debug a too-thick stroke
        // than a silent no-op.
        val safeMin = minWidthPx.coerceAtLeast(0.5f)
        val safeMax = maxWidthPx.coerceAtLeast(safeMin)
        styleMinWidthPx = safeMin
        styleMaxWidthPx = safeMax
    }

    fun onPoint(
        x: Float,
        y: Float,
        pressure: Float,
        toolType: Int,
        buttons: Int,
        action: Int
    ) {
        when (action) {
            MotionEvent.ACTION_DOWN -> {
                generation += 1
                renderer.cancel()
                suppressed = y < FRONT_BUFFER_TOOLBAR_HEIGHT_PX
                inStroke = !suppressed
                lastX = x
                lastY = y
                lastPressure = pressure
            }
            MotionEvent.ACTION_MOVE -> {
                if (!inStroke || suppressed) return
                val segment = buildSegment(x, y, pressure)
                if (!loggedFirstSegment) {
                    loggedFirstSegment = true
                    Log.i("MindstreamDrawing", "front-buffer ink first segment rendered")
                }
                renderer.renderFrontBufferedLayer(segment)
                lastX = x
                lastY = y
                lastPressure = pressure
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (inStroke && !suppressed) {
                    renderer.renderFrontBufferedLayer(buildSegment(x, y, pressure))
                }
                inStroke = false
                suppressed = false
                val finishedGeneration = generation
                rendererSurfacePostCancel(finishedGeneration)
            }
        }
    }

    fun cancel() {
        inStroke = false
        suppressed = false
        generation += 1
        renderer.cancel()
    }

    fun release() {
        renderer.release(true)
    }

    private fun rendererSurfacePostCancel(finishedGeneration: Int) {
        // Leave the front-buffer layer up briefly so the committed
        // wgpu stroke can catch up on FIFO-only surfaces before the
        // transient overlay is hidden.
        surfaceView.postDelayed(
            {
                if (generation == finishedGeneration) {
                    renderer.cancel()
                }
            },
            FRONT_BUFFER_CANCEL_DELAY_MS
        )
    }

    // Bake the current style into the segment at queue time so a
    // mid-stroke setStyle call doesn't retroactively change segments
    // already in flight to the front-buffer renderer.
    private fun buildSegment(x: Float, y: Float, pressure: Float): InkSegment =
        InkSegment(
            lastX,
            lastY,
            x,
            y,
            lastPressure,
            pressure,
            styleColor,
            styleMinWidthPx,
            styleMaxWidthPx,
        )

    private fun widthForPressure(
        p0: Float,
        p1: Float,
        minWidthPx: Float,
        maxWidthPx: Float
    ): Float {
        val p = ((p0 + p1) * 0.5f).coerceIn(0f, 1f)
        return minWidthPx + (maxWidthPx - minWidthPx) * p
    }
}
