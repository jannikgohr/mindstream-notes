# Native egui Drawing Layer — Roadmap

Phase 1 status snapshot + remaining work. Companion to
[`01-audit.md`](./01-audit.md); the spec the audit reports on still
lives in the original chat transcript (TODO: extract as `00-spec.md`).

## Where we are

POC complete: opening a note of `note_kind === 'ink'` injects an
Android `SurfaceView` over the Tauri WebView, drives a wgpu render
loop with raw stylus/touch input flowing in via JNI, paints thin
black lines on a white canvas, and shows an egui toolbar with
working Back + Clear buttons. The egui Back button cleanly
unmounts the editor and returns to the mobile home view; the
Android system back press also tears down cleanly (verified on a
real Samsung S23+ after the JNI class-cache fix).

Deliberately NOT yet implemented — see roadmap below: pressure,
stroke smoothing, lyon-tessellated thick strokes, persistence,
per-note canvas state, real toolbar UI, desktop port.

## Roadmap

Items grouped by readiness/effort, not chronology. Within each
bucket they're rough-priority-ordered.

### A. Unblocking — finish the POC

| # | Item | Notes |
|---|------|-------|
| A1 | Dynamic `WindowInsets` via JNI | Replace the `STATUS_BAR_INSET_PX = 144.0` hardcode with the actual `WindowInsetsCompat.systemBars().top` value. Kotlin reads it on attach, calls a new JNI export, Rust stashes it for the egui top-margin calc. |
| A2 | Confirm Android system back on real device | The egui Back path is verified; system back path runs the same `hideSync → surfaceDestroyed → sync wait` sequence but wasn't re-tested after the class-cache fix. |
| A3 | Restore audit-spec toolbar color | Drop the loud red (`rgb 180,30,30`) we used as a "did this reach the surface" debug marker. Switch to `rgb 32,32,36`. |

### B. POC polish — small, makes it not embarrassing

| # | Item | Notes |
|---|------|-------|
| B1 | Toolbar icons not text | `← Back` / `Clear` → ArrowLeft + Trash glyphs. egui has `ImageButton`; pre-bake PNG/SVG into the binary or use `egui::include_image!`. |
| B2 | Theme egui to match app | `egui::Visuals` so dark mode / accent color carries over. Cosmetic — bridge to `getSettingValue('app.theme')`. |
| B3 | Make in-app back arrow reachable | Today the SurfaceView covers the Svelte `MobileEditor` header. Either: (a) measure the WebView's editor `<div>` rect in JS and resize the SurfaceView to match (real layering, requires touch-passthrough), or (b) accept egui as the sole nav for ink notes and stop trying. Decide consciously. |

### C. Real-feature debt — medium

| # | Item | Notes |
|---|------|-------|
| C1 | Per-note canvas state | Today there's one global stroke buffer; all ink notes share it. Move strokes into a `HashMap<NoteId, Vec<Stroke>>` and swap on show/hide. |
| C2 | Persistence | Pick a wire format. Two candidates: (i) JSON-serialised `Vec<Stroke>` in `body`, no CRDT — simple, no offline-merge story; (ii) Y.Array of strokes in `yrs_state`, like `freeform` notes — consistent with existing sync, much more plumbing. Needs the same decision conversation `note_kind=freeform` had. |
| C3 | Pressure capture | Kotlin already pulls `MotionEvent.AXIS_PRESSURE`; the JNI `pushPoint` signature drops it. Widen to `pushPoint(x, y, pressure, action)` + thread through the render thread + add to vertex data. |
| C4 | Variable-width strokes via `lyon` | Replace `PrimitiveTopology::LineList` with `lyon` tessellation: pressure-tapered triangle strips with rounded caps. Vertex format grows to `{pos, width}` or pre-baked outlines. |

### D. Quality / feel — medium

| # | Item | Notes |
|---|------|-------|
| D1 | `ink-stroke-modeler-rs` smoothing | Audit's headline recommendation. Kalman-filtered strokes, battle-tested error handling, free pressure modeling. Requires verifying C++/cxx cross-compile to `aarch64-linux-android` — fallback is rnote's pure-Rust Catmull-Rom builder. |
| D2 | Forward stroke prediction | `stroke_modeler.predict()` renders the ink a few ms ahead of the actual pen position; single largest perceived-latency win on Android per audit. Needs a prediction-window-ms decision (16–32 is the sane range). |
| D3 | Eraser tool | Tool-mode toggle in the toolbar; drag-to-erase intersects strokes. Requires stroke-level (not segment-level) data model — feeds C1 / C4 too. |
| D4 | Undo / redo | Stack of stroke ops. Easy once strokes are first-class objects. |
| D5 | Color picker + brush size | Toolbar additions. Trivial after D3 lands the tool/state plumbing. |

### E. Platform expansion — large

| # | Item | Notes |
|---|------|-------|
| E1 | Desktop port (Windows/Linux/macOS) | Phase 2 in the spec. Swap `ANativeWindow` surface source for winit/wry handle. Render core (egui + wgpu + lyon + modeler) stays identical — that's the whole point of the surface abstraction. Largest single chunk of work; revisit only after the mobile feature set settles. |
| E2 | iOS port | Not in the original spec. Conceptually parallel to Android: `UIView` injection + UIKit pen-event capture + wgpu over Metal. |

### F. Open architecture questions (recap from audit)

- **F1.** SurfaceView vs TextureView — **resolved:** SurfaceView. Latency is what we wanted; the compositing pitfall (z-order layering) turned into the "use egui toolbar instead of WebView chrome" decision.
- **F2.** Single-process JNI design — **resolved:** all in `libmindstream_notes_lib.so`. Same library carries Keyring + Drawing JNI symbols. Side-effect: the drawing layer can't be extracted as a standalone Tauri plugin crate without restructuring.
- **F3.** Whether drawing needs its own NDK-context init — **resolved:** no, `Keyring.initializeNdkContext` (called from `MainActivity.onCreate`) populates `ndk_context` process-wide. Documented as a load-bearing dependency: if Keyring ever goes away, drawing's `ui::call_*` JNI callbacks lose their JavaVM and silently no-op.
- **F4.** Prediction window in ms — open, deferred to D2.
- **F5.** Pen-vs-finger mode setting — open. `freeform` notes have an existing `editor.freeform.penMode` setting (auto / always / off); ink notes should plausibly mirror so the same gesture is consistent across both editor kinds.
