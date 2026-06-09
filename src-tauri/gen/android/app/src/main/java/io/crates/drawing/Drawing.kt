package io.crates.drawing

import android.app.Activity
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.os.Build
import android.util.Log
import android.view.InputDevice
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
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

private const val FRONT_BUFFER_CANCEL_DELAY_MS = 48L

/**
 * Android live-ink overlay bridge.
 *
 * The canonical ink editor is the WebView/Svelte canvas. This class
 * adds a sibling `SurfaceView` that captures the in-flight wet stroke
 * with `CanvasFrontBufferedRenderer` for sub-vsync latency, while
 * forwarding the underlying `MotionEvent`s to the WebView so the
 * Svelte editor remains the source of truth for committed strokes.
 *
 * Wiring:
 *   - `attach(activity, webView)` runs from `MainActivity.onWebViewCreate`.
 *   - JS opens an ink note → `drawing_show_live_ink_overlay` Tauri
 *     command → Rust calls `Drawing.showLiveOverlayFromNative()` →
 *     this class injects a `DrawingSurfaceView` as a sibling of the
 *     WebView and starts rendering the front-buffer ink layer.
 *   - The SurfaceView reads pen / touch input directly, forwards each
 *     event to the WebView via `dispatchTouchEvent`, and queues the
 *     same samples into its own `FrontBufferInk` layer for low-latency
 *     paint. Stylus-button erases get dispatched to JS as a custom
 *     event the editor handles.
 *
 * JNI symbol mangling: package + class + `$Companion` are load-bearing,
 * so the Rust JNI export must mangle to
 * `Java_io_crates_drawing_Drawing_00024Companion_cacheJniClass`.
 * Renaming any of those fragments breaks the link at startup.
 */
class Drawing(private val activity: Activity, private val webView: WebView) {

    /** The currently-attached live-overlay view, or null when hidden. */
    private var liveView: DrawingSurfaceView? = null

    /**
     * True if [hideSync] tore down the live overlay for a lifecycle
     * pause (`onPause`) — i.e. we should re-create it on the matching
     * [resumeIfNeeded] call. Cleared whenever JS or the user act
     * explicitly ([showLiveOverlay] or [hideLiveOverlay]).
     */
    private var liveAttachedBeforePause: Boolean = false

    fun showLiveOverlay() {
        activity.runOnUiThread {
            liveAttachedBeforePause = false
            if (liveView != null) return@runOnUiThread
            requestHighRefreshRate(activity)
            val v = DrawingSurfaceView(activity, webView)
            val parent = webView.parent as ViewGroup
            val params = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            val topMarginPx = computeTopInsetPx(parent, activity)
            params.topMargin = topMarginPx
            v.layoutParams = params
            parent.addView(v)
            liveView = v
            // Snapshot the SurfaceView's top offset so the companion's
            // bounds check can translate MotionEvent coords (SurfaceView-
            // local) into the webview-local space JS pushes bounds in.
            liveOverlaySurfaceTopOffsetPx = topMarginPx
        }
    }

    fun hideLiveOverlay() {
        activity.runOnUiThread {
            liveAttachedBeforePause = false
            val v = liveView ?: return@runOnUiThread
            Log.i("MindstreamDrawing", "Drawing.hideLiveOverlay: detaching SurfaceView")
            (v.parent as? ViewGroup)?.removeView(v)
            liveView = null
            // Drop any stale bounds so a future overlay (e.g. a
            // different note) starts from a clean slate — JS pushes
            // its own bounds on mount.
            controlBounds = emptyList()
            documentBounds = emptyList()
            liveOverlaySurfaceTopOffsetPx = 0
            releaseRefreshRate(activity)
        }
    }

    fun enterImmersiveInkMode() {
        activity.runOnUiThread {
            hideSystemNavigation(activity)
        }
    }

    fun exitImmersiveInkMode() {
        activity.runOnUiThread {
            showSystemNavigation(activity)
        }
    }

    /**
     * UI-thread-only synchronous tear-down. Called from
     * [MainActivity.onPause]; pairs with [resumeIfNeeded] on resume so
     * the overlay survives a screen-off / app-switch / lock cycle.
     */
    fun hideSync() {
        check(android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) {
            "hideSync must be called on the UI thread"
        }
        val live = liveView
        if (live != null) {
            Log.i("MindstreamDrawing", "Drawing.hideSync: detaching live overlay (UI thread)")
            (live.parent as? ViewGroup)?.removeView(live)
            liveView = null
            liveAttachedBeforePause = true
        }
        releaseRefreshRate(activity)
    }

    fun resumeIfNeeded() {
        check(android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) {
            "resumeIfNeeded must be called on the UI thread"
        }
        if (liveAttachedBeforePause) {
            Log.i(
                "MindstreamDrawing",
                "Drawing.resumeIfNeeded: re-attaching live overlay after lifecycle pause"
            )
            showLiveOverlay()
        }
    }

    /**
     * Forward a Rust-driven style update to the active live overlay's
     * front-buffer ink layer. No-op if the SurfaceView is currently
     * detached. Safe to call from any thread — the style fields on
     * [FrontBufferInk] are `@Volatile` so a write here publishes
     * immediately to the touch / render threads that read them.
     */
    fun setLiveInkStyle(colorArgb: Int, minWidthPx: Float, maxWidthPx: Float) {
        liveView?.setLiveInkStyle(colorArgb, minWidthPx, maxWidthPx)
    }

    fun cancelLiveInk() {
        liveView?.cancelLiveInk()
    }

    companion object {
        init {
            // Same library the Keyring JNI symbols live in — the Rust
            // drawing code is statically linked into
            // libmindstream_notes_lib.so alongside the rest of the app.
            // System.loadLibrary is idempotent so it's fine that Keyring
            // also loaded it.
            System.loadLibrary("mindstream_notes_lib")
            // Hand Rust a GlobalRef to this class so it can call our
            // @JvmStatic methods from a JVM-attached thread without
            // doing its own env.find_class() — that fails for app
            // classes on Rust-spawned threads. Must run AFTER
            // loadLibrary because the JNI symbol it dispatches to
            // lives in libmindstream_notes_lib.so.
            cacheJniClass(Drawing::class.java)
        }

        /**
         * Held by MainActivity once `attach` runs in onWebViewCreate.
         * Lives for the activity's lifetime; the live-overlay
         * callbacks bounce off it, so a Rust call that arrives before
         * attach is a silent no-op.
         */
        @Volatile
        private var instance: Drawing? = null

        /** Called from MainActivity.onWebViewCreate. */
        fun attach(activity: Activity, webView: WebView) {
            Log.i("MindstreamDrawing", "Drawing.attach: native ink bridge attached")
            instance = Drawing(activity, webView)
        }

        /** Called from MainActivity.onPause. */
        fun detach() {
            instance?.hideSync()
        }

        /** Called from MainActivity.onResume. */
        fun resume() {
            instance?.resumeIfNeeded()
        }

        // ---- Called from Rust via JNI (jni::ui::invoke_static_void) ----
        // @JvmStatic so they show up as plain static methods on the
        // Drawing class itself — call_static_method on the Rust side
        // would otherwise need to dig out the Companion field. The
        // `cacheJniClass` external function below intentionally DOESN'T
        // use @JvmStatic because that would change the JNI symbol
        // mangling and break the matching Rust export.

        @JvmStatic
        fun showLiveOverlayFromNative() {
            instance?.showLiveOverlay()
        }

        @JvmStatic
        fun hideLiveOverlayFromNative() {
            instance?.hideLiveOverlay()
        }

        @JvmStatic
        fun enterImmersiveInkModeFromNative() {
            instance?.enterImmersiveInkMode()
        }

        @JvmStatic
        fun exitImmersiveInkModeFromNative() {
            instance?.exitImmersiveInkMode()
        }

        @JvmStatic
        fun cancelLiveInkFromNative() {
            instance?.cancelLiveInk()
        }

        @Volatile
        internal var controlBounds: List<android.graphics.RectF> = emptyList()
        /**
         * Visible page rects in webview-local surface pixels. Acts as
         * an allow-list: the live overlay refuses to paint anywhere
         * outside the union of these rectangles, mirroring the JS
         * canvas's `containsPagePoint` check. An empty list means
         * "nothing is paintable" — also the initial state, so the
         * overlay stays inert until JS has pushed real bounds.
         */
        @Volatile
        internal var documentBounds: List<android.graphics.RectF> = emptyList()
        /**
         * Top inset (in surface pixels) of the active live-overlay
         * SurfaceView, relative to the WebView origin. Set by
         * [showLiveOverlay] when the SurfaceView is attached. Used by
         * [blocksLiveInkAt] / [blocksLiveInkSegment] to translate
         * SurfaceView-local MotionEvent y into the webview-local space
         * [controlBounds] and [documentBounds] are pushed in. Reset to
         * 0 on hide so a stale value doesn't bleed into the next
         * overlay.
         */
        @Volatile
        internal var liveOverlaySurfaceTopOffsetPx: Int = 0
        @Volatile
        private var fingerDrawingAllowed: Boolean = true
        @Volatile
        private var fingerDrawingSettingLoaded: Boolean = false

        /**
         * Pushes the screen-space bounds of Svelte UI controls (ink
         * toolbar, popovers, …) so the live overlay refuses to paint
         * over them. Called from Rust via the
         * `drawing_set_control_bounds` Tauri command. The flat
         * `bounds` array is grouped into quads of [x0, y0, x1, y1] in
         * webview-local surface pixels — what JS produces from
         * `getBoundingClientRect()` × `devicePixelRatio`. Pushing an
         * empty array clears all bounds.
         */
        @JvmStatic
        fun setControlBoundsFromNative(bounds: FloatArray) {
            controlBounds = decodeBounds(bounds)
        }

        /**
         * Pushes the visible page rects so the live overlay only
         * paints inside the document area. Called from Rust via the
         * `drawing_set_document_bounds` Tauri command. Empty array
         * means "block all painting" — the overlay returns to the
         * inert state it has before JS pushes any layout.
         */
        @JvmStatic
        fun setDocumentBoundsFromNative(bounds: FloatArray) {
            documentBounds = decodeBounds(bounds)
        }

        private fun decodeBounds(bounds: FloatArray): List<android.graphics.RectF> {
            val rects = java.util.ArrayList<android.graphics.RectF>()
            for (i in 0 until bounds.size step 4) {
                if (i + 3 < bounds.size) {
                    rects.add(android.graphics.RectF(bounds[i], bounds[i + 1], bounds[i + 2], bounds[i + 3]))
                }
            }
            return rects
        }

        @JvmStatic
        fun setFingerDrawingAllowedFromNative(allowed: Boolean) {
            fingerDrawingAllowed = allowed
            fingerDrawingSettingLoaded = true
        }

        fun setFingerDrawingAllowedDefaultFromDevice(context: Context) {
            if (fingerDrawingSettingLoaded) {
                Log.i(
                    "MindstreamDrawing",
                    "finger drawing default skipped; using saved allowed=$fingerDrawingAllowed"
                )
                return
            }
            val hasPen = hasPenSupport(context)
            val allowed = !hasPen
            fingerDrawingAllowed = allowed
            fingerDrawingSettingLoaded = true
            Log.i(
                "MindstreamDrawing",
                "finger drawing default allowed=$allowed hasPenSupport=$hasPen"
            )
        }

        private fun hasPenSupport(context: Context): Boolean {
            val inputManager = context.getSystemService(Context.INPUT_SERVICE)
                as? android.hardware.input.InputManager
            if (inputManager == null) return false
            for (deviceId in inputManager.inputDeviceIds) {
                val device = inputManager.getInputDevice(deviceId) ?: continue
                if ((device.sources and InputDevice.SOURCE_STYLUS) == InputDevice.SOURCE_STYLUS) {
                    return true
                }
            }
            return false
        }

        fun canDrawWithTool(toolType: Int): Boolean =
            fingerDrawingAllowed ||
                toolType == MotionEvent.TOOL_TYPE_STYLUS ||
                toolType == MotionEvent.TOOL_TYPE_ERASER ||
                toolType == MotionEvent.TOOL_TYPE_MOUSE

        fun isStylusButtonPressed(buttons: Int): Boolean =
            (buttons and MotionEvent.BUTTON_STYLUS_PRIMARY) != 0 ||
                (buttons and MotionEvent.BUTTON_STYLUS_SECONDARY) != 0

        fun canDrawLiveInk(toolType: Int, buttons: Int): Boolean =
            canDrawWithTool(toolType) &&
                toolType != MotionEvent.TOOL_TYPE_ERASER &&
                !isStylusButtonPressed(buttons)

        fun inControlBounds(x: Float, y: Float): Boolean {
            val bounds = controlBounds
            for (r in bounds) {
                if (r.contains(x, y)) return true
            }
            return false
        }

        private fun inDocumentBounds(x: Float, y: Float): Boolean {
            val bounds = documentBounds
            for (r in bounds) {
                if (r.contains(x, y)) return true
            }
            return false
        }

        /**
         * `x` and `y` are SurfaceView-local surface pixels (MotionEvent
         * coords). Bounds are stored in webview-local surface pixels —
         * translate by [liveOverlaySurfaceTopOffsetPx] before
         * comparing. Painting is allowed iff the point lies inside any
         * [documentBounds] rect AND outside every [controlBounds] rect.
         */
        fun blocksLiveInkAt(x: Float, y: Float): Boolean {
            val yCanvas = y + liveOverlaySurfaceTopOffsetPx
            if (!inDocumentBounds(x, yCanvas)) return true
            return inControlBounds(x, yCanvas)
        }

        fun blocksLiveInkSegment(x0: Float, y0: Float, x1: Float, y1: Float): Boolean {
            val offset = liveOverlaySurfaceTopOffsetPx
            val y0c = y0 + offset
            val y1c = y1 + offset
            // Either endpoint outside the document area → drop the
            // segment. Mirrors the JS sampler's behaviour of ending
            // strokes when the pointer exits the page.
            if (!inDocumentBounds(x0, y0c) || !inDocumentBounds(x1, y1c)) return true
            val bounds = controlBounds
            for (r in bounds) {
                if (segmentIntersectsRect(x0, y0c, x1, y1c, r)) return true
            }
            return false
        }

        private fun segmentIntersectsRect(
            x0: Float,
            y0: Float,
            x1: Float,
            y1: Float,
            rect: android.graphics.RectF
        ): Boolean {
            if (rect.contains(x0, y0) || rect.contains(x1, y1)) return true

            val minX = minOf(x0, x1)
            val maxX = maxOf(x0, x1)
            val minY = minOf(y0, y1)
            val maxY = maxOf(y0, y1)
            if (maxX < rect.left || minX > rect.right || maxY < rect.top || minY > rect.bottom) {
                return false
            }

            return segmentsIntersect(x0, y0, x1, y1, rect.left, rect.top, rect.right, rect.top) ||
                segmentsIntersect(x0, y0, x1, y1, rect.right, rect.top, rect.right, rect.bottom) ||
                segmentsIntersect(x0, y0, x1, y1, rect.right, rect.bottom, rect.left, rect.bottom) ||
                segmentsIntersect(x0, y0, x1, y1, rect.left, rect.bottom, rect.left, rect.top)
        }

        private fun segmentsIntersect(
            ax: Float,
            ay: Float,
            bx: Float,
            by: Float,
            cx: Float,
            cy: Float,
            dx: Float,
            dy: Float
        ): Boolean {
            val o1 = orientation(ax, ay, bx, by, cx, cy)
            val o2 = orientation(ax, ay, bx, by, dx, dy)
            val o3 = orientation(cx, cy, dx, dy, ax, ay)
            val o4 = orientation(cx, cy, dx, dy, bx, by)

            if (o1 == 0 && onSegment(ax, ay, cx, cy, bx, by)) return true
            if (o2 == 0 && onSegment(ax, ay, dx, dy, bx, by)) return true
            if (o3 == 0 && onSegment(cx, cy, ax, ay, dx, dy)) return true
            if (o4 == 0 && onSegment(cx, cy, bx, by, dx, dy)) return true

            return o1 != o2 && o3 != o4
        }

        private fun orientation(
            ax: Float,
            ay: Float,
            bx: Float,
            by: Float,
            cx: Float,
            cy: Float
        ): Int {
            val cross = (by - ay) * (cx - bx) - (bx - ax) * (cy - by)
            return when {
                kotlin.math.abs(cross) < 0.0001f -> 0
                cross > 0f -> 1
                else -> 2
            }
        }

        private fun onSegment(
            ax: Float,
            ay: Float,
            px: Float,
            py: Float,
            bx: Float,
            by: Float
        ): Boolean =
            px >= minOf(ax, bx) - 0.0001f &&
                px <= maxOf(ax, bx) + 0.0001f &&
                py >= minOf(ay, by) - 0.0001f &&
                py <= maxOf(ay, by) + 0.0001f

        /**
         * Called from Rust to change the live-ink front-buffer
         * overlay's color and stroke-width range. Rust is the source
         * of truth for the active stroke style — Kotlin's
         * [FrontBufferInk] reads these fields when queueing each
         * segment, so a write here takes effect from the next segment
         * onwards. `colorArgb` packs 0xAARRGGBB matching Android's
         * `Color` int format. Widths are in surface pixels.
         */
        @JvmStatic
        fun setLiveInkStyleFromNative(
            colorArgb: Int,
            minWidthPx: Float,
            maxWidthPx: Float
        ) {
            instance?.setLiveInkStyle(colorArgb, minWidthPx, maxWidthPx)
        }

        // ---- Rust JNI export ----
        // No @JvmStatic: the symbol must mangle to
        // Java_io_crates_drawing_Drawing_00024Companion_cacheJniClass
        // so the matching Rust extern in
        // src-tauri/src/drawing/platform/android.rs resolves.
        external fun cacheJniClass(klass: Class<*>)
    }
}

/**
 * Compute the top inset that the live-overlay SurfaceView's
 * layoutParams should use: system status bar inset (e.g. 74px on
 * Samsung S23+) plus the Svelte header height (48dp × density).
 * Falls back to 0 for the system bar if the root window insets
 * aren't available yet (rare; the OnApplyWindowInsetsListener will
 * re-run with the real value soon after attach).
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
 * variable-refresh phones. No-op on 60Hz-only displays.
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
 * so the rest of the app goes back to the system's adaptive choice.
 */
private fun releaseRefreshRate(activity: Activity) {
    val attrs = activity.window.attributes
    if (attrs.preferredDisplayModeId != 0) {
        Log.i("MindstreamDrawing", "releasing refresh rate preference")
        attrs.preferredDisplayModeId = 0
        activity.window.attributes = attrs
    }
}

private fun hideSystemNavigation(activity: Activity) {
    val window = activity.window
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    controller.systemBarsBehavior =
        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    controller.hide(WindowInsetsCompat.Type.navigationBars())
}

private fun showSystemNavigation(activity: Activity) {
    val window = activity.window
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    controller.show(WindowInsetsCompat.Type.navigationBars())
}

/**
 * The live-ink overlay surface. Mirror-mode only: every touch event
 * is forwarded to the WebView (so Svelte stays the source of truth
 * for committed strokes), and the same samples are queued into a
 * `CanvasFrontBufferedRenderer` for sub-vsync wet-stroke paint.
 *
 * Stylus-button (eraser) input is routed differently — instead of
 * feeding ink, we serialise the coalesced sample list into a custom
 * DOM event so the Svelte editor's eraser path can handle it on the
 * same canvas it owns committed strokes on.
 */
private class DrawingSurfaceView(
    context: Context,
    private val webView: WebView
) : SurfaceView(context), SurfaceHolder.Callback {

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

    private var mirrorStylusEraserActive = false

    init {
        setZOrderOnTop(true)
        holder.setFormat(PixelFormat.TRANSLUCENT)
        holder.addCallback(this)
        isFocusable = true
        isClickable = true
        Drawing.setFingerDrawingAllowedDefaultFromDevice(context)
        if (frontBufferInk != null) {
            Log.i("MindstreamDrawing", "front-buffer ink enabled")
        }

        // Reapply the SurfaceView's topMargin on every inset change so
        // rotations / IME show-hide don't leave the canvas overlapping
        // the system bar + Svelte header. On many devices the inset
        // doesn't change between portrait/landscape, so this listener
        // may never fire — the initial `computeTopInsetPx` call in
        // `Drawing.showLiveOverlay()` already set the right value.
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
    }

    override fun surfaceCreated(holder: SurfaceHolder) {
        Log.i("MindstreamDrawing", "surfaceCreated w=$width h=$height")
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        Log.i("MindstreamDrawing", "surfaceChanged w=$width h=$height format=$format")
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        Log.i("MindstreamDrawing", "surfaceDestroyed — cancelling live overlay")
        frontBufferInk?.cancel()
    }

    override fun onDetachedFromWindow() {
        frontBufferInk?.release()
        super.onDetachedFromWindow()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val action = event.actionMasked
        if (event.pointerCount != 1) {
            frontBufferInk?.cancel()
            if (mirrorStylusEraserActive) {
                dispatchStylusEraserEvent(event, MotionEvent.ACTION_CANCEL)
                mirrorStylusEraserActive = false
            } else {
                forwardToWebView(event)
            }
            return true
        }
        val toolType = event.getToolType(0)
        val buttons = event.buttonState
        if (Drawing.isStylusButtonPressed(buttons) || mirrorStylusEraserActive) {
            dispatchStylusEraserEvent(event, action)
            mirrorStylusEraserActive =
                action != MotionEvent.ACTION_UP && action != MotionEvent.ACTION_CANCEL
            frontBufferInk?.cancel()
            return true
        }

        forwardToWebView(event)
        val historySize = event.historySize
        val historicalAction =
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                MotionEvent.ACTION_MOVE
            } else {
                action
            }
        for (h in 0 until historySize) {
            frontBufferInk?.onPoint(
                event.getHistoricalX(h),
                event.getHistoricalY(h),
                sanitizePressure(event.getHistoricalPressure(h)),
                toolType,
                buttons,
                historicalAction
            )
        }
        frontBufferInk?.onPoint(
            event.x,
            event.y,
            sanitizePressure(event.pressure),
            toolType,
            buttons,
            action
        )
        return true
    }

    private fun dispatchStylusEraserEvent(event: MotionEvent, action: Int) {
        val density = webView.resources.displayMetrics.density.coerceAtLeast(1f)
        val offsetX = (left - webView.left).toFloat()
        val offsetY = (top - webView.top).toFloat()
        val pointsJson = StringBuilder("[")
        for (h in 0 until event.historySize) {
            appendEraserPoint(
                pointsJson,
                (event.getHistoricalX(h) + offsetX) / density,
                (event.getHistoricalY(h) + offsetY) / density,
                sanitizePressure(event.getHistoricalPressure(h))
            )
        }
        appendEraserPoint(
            pointsJson,
            (event.x + offsetX) / density,
            (event.y + offsetY) / density,
            sanitizePressure(event.pressure)
        )
        pointsJson.append("]")

        val actionName = when (action) {
            MotionEvent.ACTION_DOWN -> "down"
            MotionEvent.ACTION_UP -> "up"
            MotionEvent.ACTION_CANCEL -> "cancel"
            else -> "move"
        }
        webView.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('mindstream:android-stylus-eraser',{detail:{action:'$actionName',points:$pointsJson}}));",
            null
        )
    }

    private fun appendEraserPoint(
        out: StringBuilder,
        x: Float,
        y: Float,
        pressure: Float
    ) {
        if (out.length > 1) out.append(',')
        out
            .append("{\"x\":")
            .append(x)
            .append(",\"y\":")
            .append(y)
            .append(",\"pressure\":")
            .append(pressure)
            .append('}')
    }

    private fun forwardToWebView(event: MotionEvent) {
        val copy = MotionEvent.obtain(event)
        copy.offsetLocation((left - webView.left).toFloat(), (top - webView.top).toFloat())
        webView.dispatchTouchEvent(copy)
        copy.recycle()
    }

    private fun sanitizePressure(raw: Float): Float {
        if (raw.isNaN() || raw <= 0f) return 1f
        if (raw > 1f) return 1f
        return raw
    }

    fun setLiveInkStyle(colorArgb: Int, minWidthPx: Float, maxWidthPx: Float) {
        frontBufferInk?.setStyle(colorArgb, minWidthPx, maxWidthPx)
    }

    fun cancelLiveInk() {
        frontBufferInk?.cancel()
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
                // The Svelte canvas owns committed strokes. This
                // renderer is only the transient low-latency head.
            }
        })

    // Style state — Rust drives these via
    // `Drawing.setLiveInkStyleFromNative`. Defaults reproduce the
    // pre-Rust-driven look (debug-blue stylus, 2–5 px pressure ramp)
    // so the overlay still renders correctly if Rust hasn't pushed a
    // style yet. `@Volatile` because writes come from a Rust-spawned
    // JNI-attached thread and reads happen on the touch + front-buffer
    // render threads.
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
        // rather than rejected.
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
                suppressed = Drawing.blocksLiveInkAt(x, y) || !Drawing.canDrawLiveInk(toolType, buttons)
                inStroke = !suppressed
                lastX = x
                lastY = y
                lastPressure = pressure
            }
            MotionEvent.ACTION_MOVE -> {
                if (!inStroke || suppressed) return
                if (!Drawing.canDrawLiveInk(toolType, buttons)) {
                    cancel()
                    return
                }
                val segment = buildSegment(x, y, pressure)
                if (!Drawing.blocksLiveInkSegment(lastX, lastY, x, y)) {
                    if (!loggedFirstSegment) {
                        loggedFirstSegment = true
                        Log.i("MindstreamDrawing", "front-buffer ink first segment rendered")
                    }
                    renderer.renderFrontBufferedLayer(segment)
                }
                lastX = x
                lastY = y
                lastPressure = pressure
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (inStroke &&
                    !suppressed &&
                    Drawing.canDrawLiveInk(toolType, buttons) &&
                    !Drawing.blocksLiveInkSegment(lastX, lastY, x, y)
                ) {
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
        // Svelte canvas stroke can catch up before the transient
        // overlay is hidden.
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
