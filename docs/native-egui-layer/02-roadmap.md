# Native egui Drawing Layer — Roadmap

Phase 1 status snapshot + remaining work. Companion to
[`01-audit.md`](./01-audit.md); the spec the audit reports on still
lives in the original chat transcript (TODO: extract as `00-spec.md`).

## Where we are

POC complete and stable on real hardware (Samsung S23+, Tab S7+ FE):
opening a note of `note_kind === 'ink'` injects an Android
`SurfaceView` *below* MobileEditor's header (via `topMargin =
systemBarInset + 48dp`), drives a wgpu render loop with raw
stylus/touch input flowing in via JNI, paints thin black lines on
a white canvas, and shows an egui toolbar with working Back + Clear
buttons. The Android system back, the in-app Svelte back arrow, and
the egui Back all converge on a single `navigateBack()` that pops
the browser history (`history.back()` → popstate → `setMobileScreen
('home')`); from the home screen, system back closes the app.

Heavy wgpu state (`Device` / `Queue` / `pipeline` / `egui_renderer`)
lives in a `PersistentGpu` struct that's built once and kept alive
for the process lifetime — only the per-surface state (`Surface` +
`AndroidWindow` + `vertex_buffer`) drops on `surfaceDestroyed`,
which dodges the HWUI/EGL mutex teardown crash on activity finish.

Rotation triggers a re-render via the SurfaceView's
`addOnLayoutChangeListener` (more reliable than `surfaceChanged` on
Samsung devices).

Since the POC landed, the foundational data-model work is in:
page coordinates with A4 portrait default (C0), per-note canvas
state (C1), yrs-backed persistence + live-CRDT stroke document
(C2), end-to-end pressure capture (C3 — also threads
`MotionEvent.getToolType` so the render thread knows whether a
sample came from finger / stylus / eraser), variable-width
pressure-tapered strokes (C4 — per-segment CPU tessellation into
TriangleList quads; per-vertex colour means S Pen strokes render in
debug-blue while finger strokes stay black; no `lyon` dep yet,
joints aren't mitered), and stylus-button capture (C6 — Kotlin
forwards `event.buttonState` so the renderer can debug-colour
"side button held" in orange).
The code has been split out of single-file `render.rs` into
`surface.rs` / `pipeline.rs` / `ui/{mod, toolbar}.rs` / `jni.rs`
(R1, R2 partial), and the platform-neutral input shape lives in
`drawing/input.rs` (R4 initial scope); `render.rs` retains the
render-thread loop + JNI-facing public API and now consumes
`input::Sample` rather than raw `MotionEvent.*` ints.

**Deliberately NOT yet implemented** — see roadmap below: stroke
smoothing; stylus-button → action mapping (the bits flow but
nothing acts on them yet); live collab; cross-platform
`SurfaceSource` trait; desktop port. Rounded caps + mitered joints
(via `lyon`) deferred until thick-stroke joints actually look
notchy in practice.

## Roadmap

Items grouped by readiness/effort, not chronology. Within each
bucket they're rough-priority-ordered. Buckets later in the
alphabet generally depend on earlier ones.

### A. Unblocking — finish the POC

All resolved.

| # | Item | Status |
|---|------|--------|
| A1 | Dynamic `WindowInsets` via JNI | **Done** (then mostly retired by B3 — Kotlin handles topMargin directly; the Rust setInsets path stays in for future re-use). |
| A2 | Confirm Android system back on real device | **Done** — clean exit, no FORTIFY. |
| A3 | Restore audit-spec toolbar color | **Done** — `rgb 32,32,36`. |

### B. POC polish — small, makes it not embarrassing

| # | Item | Notes | Status |
|---|------|-------|--------|
| B1 | Toolbar icons not text | `← Back` / `Clear` → ArrowLeft + Trash glyphs via egui `ImageButton` (`egui::include_image!`). | Pending |
| B2 | Theme egui to match app accent + dark mode | `egui::Visuals` bridged to `getSettingValue('app.theme')`. | Pending |
| B3 | Layering decision | **Done** — inset SurfaceView via `topMargin`. Svelte header stays reachable; egui toolbar sits below it. |

### R. Refactor — modularity + cross-platform groundwork

This is the prerequisite for everything in C and E. Doing it now
(while the surface area is still small enough to refactor in one
session) saves migration pain later.

| # | Item | Notes | Status |
|---|------|-------|--------|
| R1 | Split `drawing/render.rs` into a directory | Suggested layout: `drawing/{mod, surface, input, render/{pipeline, frame}, ui/{toolbar}, thread, jni}.rs`. | **Done** (85896e3) — landed as `surface.rs` / `pipeline.rs` / `ui/{mod, toolbar}.rs` / `jni.rs`; render-thread loop + JNI-facing public API kept in `render.rs` as the orchestrator. Further fragmentation (separate `thread.rs` / `frame.rs`) deferred until it pays off. |
| R2 | `canvas_ui` submodule for egui UI | Top-level `ui/mod.rs` exposes a `CanvasUi` struct with `fn run(&mut self, ctx: &egui::Context) -> RenderActions`. | **Done** (85896e3) — `CanvasUi` + `RenderActions` + `UiOutput` live in `drawing/ui/mod.rs`; toolbar widget in `ui/toolbar.rs`. Slot files (`ui/color_picker.rs`, `ui/eraser.rs`, …) referenced in the module doc, to be filled in during D. |
| R3 | `SurfaceSource` trait for cross-platform | Abstract "give me a raw-window-handle + width/height" behind a trait. Android impl wraps `ANativeWindow` (current code, moved to `platform/android.rs`); desktop impl wraps winit/wry handle (E1). Render core takes `&dyn SurfaceSource` and stops knowing about Android. | Pending |
| R4 | `InputSource` abstraction | Same idea for the touch/stylus event stream. Android impl is JNI `pushPoint`; desktop impl is winit `WindowEvent`; iOS is UIKit pen events. Two message shapes, because stylus input is really two different concepts: **(a)** continuous per-sample state — `Sample { x, y, pressure, tool, action, … }`, with `buttons` (bitflags), `tilt`, `azimuth`, `time` added as consumers materialise; **(b)** discrete gestures — `StylusGesture { kind: DoubleTap \| Squeeze \| … }`, fired between strokes, no associated position. Apple Pencil 2's double-tap + Pencil Pro's squeeze live in (b) because they come via `UIPencilInteraction` separately from `UITouch`; held barrel buttons (S Pen, Surface Pen, Wacom) live in (a). | **Done** (initial scope) — `drawing/input.rs` ships `Sample` / `ToolKind` / `SampleAction` as the platform-neutral types the render thread now consumes; JNI translates raw `MotionEvent.*` ints into them at the boundary. Deferred (pending consumers): `buttons: StylusButtons` lands with C6, `StylusGesture` with D8, `tilt` / `azimuth` / `time` when a consumer (D1 smoothing) needs them. The full trait-based `trait InputSource` arrives when more than one platform exists (E1 / E2). |
| R5 | `platform/` module split | `drawing/platform/{android, desktop, ios}.rs`, gated by `cfg(target_os)`. Each file owns its `SurfaceSource` + `InputSource` impls and lifecycle hooks. Cross-cutting concerns (NDK context init, JNI class caching) live in the Android-specific file. | Pending |
| R6 | Cargo workspace consideration | When the drawing crate grows past `src-tauri/src/drawing/`, consider extracting it to a workspace member (`crates/mindstream-canvas/`) so the cross-platform render core has a clean dependency boundary from the Tauri app. Not urgent; flag if compile times get painful. | Pending (low priority) |

### C. Real-feature debt — depends on R landing first

(In practice C0–C2 were taken ahead of R3–R5 because the data-model
work was independent of the platform-abstraction work; C3+ continues
that order. R3–R5 still gate E.)

| # | Item | Notes | Status |
|---|------|-------|--------|
| C0 | Page-coordinate model (stop-stretch + A4) | Strokes stored in page coordinates (document units), not NDC. View transform (`{scale, pan}`) computed each frame to fit page → surface preserving aspect. Default page: A4 portrait at 144 DPI (1190 × 1684 page-units). Constants live in `drawing/page.rs` so future page sizes (Letter, custom, infinite scroll) are a config swap. Rotation no longer stretches. | **Done** (e555652) |
| C1 | Per-note canvas state | One `StrokesDoc` per note, swapped on `drawing_show(note_id)`. | **Done** (f912c85) |
| C2 | Persistence via yrs (`yjs-rs`) | `yrs::Doc` like markdown / freeform notes — strokes as a `Y.Array<Y.Map>`, each map carrying `{id, color, width, points: Y.Array<Point>}`. Persisted into `note.yrs_state`, synced via Etebase. Pen-down opens a fresh `Stroke`, samples append to its `points` Y.Array, pen-up commits. Eraser sets a tombstone field (don't delete; offline-merge convergence). Format versioned via a `schema` field on the doc root. | **Done** (645dff6; persistence bugfix 36e74b5) |
| C3 | Pressure + tool-type capture | Kotlin reads `MotionEvent.AXIS_PRESSURE` (+ historical samples), sanitises NaN/0/over-1 to 1.0, and reads `event.getToolType(0)`, then passes through `pushPoint(x, y, pressure, toolType, action)`. Pressure stored as a parallel `pressures: Y.Array<f64>` on each stroke map (additive — no schema bump; legacy strokes default to 1.0 on read). Tool type isn't persisted directly; instead the renderer uses it at `begin_stroke` time to pick a colour (see C4) which is what survives into the doc. Unblocks C4 + D1 + D2 + C6. | **Done** |
| C4 | Variable-width strokes + per-stroke colour | Per-segment CPU tessellation (2-triangle quad with potentially different widths at each endpoint) — no `lyon` dep yet. Each stroke segment uses `width = MIN_WIDTH + (BASE_WIDTH - MIN_WIDTH) * pressure` (MIN=1.0, BASE=4.0 page-units = ~0.18–0.7 mm). Topology flipped to `TriangleList`; vertex format grew to `{position, color}` so each stroke can be rendered in its own colour. `begin_stroke` now takes a packed 0xAARRGGBB colour — currently chosen from tool type (stylus / eraser → debug blue, else → black) as a "did pen detection actually work" visualisation; D5 swaps that mapping for a user-picked palette. Pure-math `segment_quad_positions` lives in `page.rs` with host-side unit tests. Joints aren't mitered — fine for the current thin-stroke regime; revisit (probably with `lyon`'s stroke tessellator) if thick-stroke joints look notchy. Per-stroke `width` field in the schema is still ignored — wires up with D5. | **Done** (deferred lyon + rounded caps) |
| C5 | Live collab on the canvas | Each open ink note's `yrs::Doc` plugs into the existing `CollabProvider` infrastructure (same path markdown notes use for live editing). Yrs broadcasts pen samples to peers as they arrive; remote samples merge into the doc and trigger a re-render. Local-first by construction: offline writes append to the local Y.Array and sync on next reconnect with CRDT-correct merge. Depends on C2. | Pending |
| C6 | Stylus button capture (data plumbing) | Mirrors C3: Kotlin reads `event.buttonState`, JNI signature grew to `pushPoint(x, y, pressure, toolType, buttons, action)`, `Sample` carries `buttons: u32` (raw bitmask matching `MotionEvent.BUTTON_*`; `Sample::has_stylus_primary_button` does the typed bit test). Bit-value constants live in `drawing::input::buttons`. No persistence — buttons are input-time; their *consequences* (e.g. the chosen stroke colour) are what survives. UX policy still deferred to D8; the renderer currently uses `BUTTON_STYLUS_PRIMARY` only as a debug-colour override (button held → orange) so the user can visually confirm detection works on their device. Apple Pencil's discrete gestures (double-tap, Pro squeeze) still need a separate `StylusGesture` shape — open for D8. | **Done** (data plumbing) — promote `buttons: u32` to a `bitflags` type when a second consumer (D8) materialises. |

### D. Quality / feel — depends on C

| # | Item | Notes |
|---|------|-------|
| D1 | `ink-stroke-modeler-rs` smoothing | Audit's headline recommendation. Kalman-filtered strokes, battle-tested error handling, free pressure modeling. Requires verifying C++/cxx cross-compile to `aarch64-linux-android` — fallback is rnote's pure-Rust Catmull-Rom builder. |
| D2 | Forward stroke prediction | `stroke_modeler.predict()` renders the ink a few ms ahead of the actual pen position; single largest perceived-latency win on Android per audit. Needs a prediction-window-ms decision (16–32 is the sane range). |
| D3 | Eraser tool | Tool-mode toggle in the toolbar (lives in `ui/eraser.rs` per R2); drag-to-erase tombstones intersecting strokes (C2). |
| D4 | Undo / redo | Stack of Y.Array operations or per-stroke tombstone toggles. Easy once strokes are first-class CRDT entities. |
| D5 | Color picker + brush size | Toolbar additions in `ui/color_picker.rs` / `ui/brush.rs`. Trivial after D3 lands the tool/state plumbing. |
| D6 | Pan + pinch-zoom on the page | Two-finger gesture handling: Kotlin `GestureDetector` + `ScaleGestureDetector` push `Msg::ViewTransform { pan_delta, scale_delta }` to Rust; render reads current view transform from a uniform buffer (already added in C0). Clamp to keep page on-screen; momentum on fling. |
| D7 | Multi-page / infinite scroll | Once C0 + D6 are in, multi-page is "more pages along Y in document space". Page break renders as a thin gap + page number badge. |
| D8 | Stylus button + gesture → action mapping | UX-policy layer over C6 + the discrete-gesture path. Maps `StylusButtons` bitmask states (held during a stroke) and discrete `StylusGesture` events (between strokes) onto canvas actions: switch to eraser, cycle colour, undo, open quick-picker, etc. Lives in `ui/` (above the render thread) because the policy needs to see the current tool mode + the user's settings — render thread stays a dumb carrier of the input bits. Default mapping is open (see F7); the mechanism is what matters here. Apple Pencil 2 double-tap respects the system pref (`UIPencilInteraction.preferredTapAction`) when running on iOS so the gesture does the same thing in our app as in others; Android side has no equivalent system pref, so we expose our own setting. Depends on C6. |

### E. Platform expansion — unblocked by R

| # | Item | Notes |
|---|------|-------|
| E1 | Desktop port (Windows/Linux/macOS) | After R lands, this is "implement `SurfaceSource` and `InputSource` for winit/wry". Render core (egui + wgpu + lyon + modeler + page coords + yrs doc) stays identical. Largest single chunk of work; revisit only after mobile feature set settles. |
| E2 | iOS port | Conceptually parallel: `UIView` injection + UIKit pen-event capture + wgpu over Metal. Same `SurfaceSource` / `InputSource` shape as Android. |

### F. Open architecture questions (recap from audit)

- **F1.** SurfaceView vs TextureView — **resolved:** SurfaceView. Latency is what we wanted.
- **F2.** Single-process JNI design — **resolved:** all in `libmindstream_notes_lib.so`. Same library carries Keyring + Drawing JNI symbols. Side-effect: the drawing layer can't be extracted as a standalone Tauri plugin crate without restructuring (R6 may revisit).
- **F3.** Whether drawing needs its own NDK-context init — **resolved:** no, `Keyring.initializeNdkContext` (called from `MainActivity.onCreate`) populates `ndk_context` process-wide. Documented load-bearing dependency: if Keyring ever goes away, drawing's `ui::call_*` JNI callbacks lose their JavaVM and silently no-op. The cached Drawing-class JNI GlobalRef is a related load-bearing dep — see the comments in `Drawing.kt`'s companion init.
- **F4.** Prediction window in ms — open, deferred to D2.
- **F5.** Pen-vs-finger mode setting — open. `freeform` notes have an existing `editor.freeform.penMode` setting (auto / always / off); ink notes should mirror so the same gesture is consistent across both editor kinds.
- **F6.** Page size as a user-facing setting? — open. C0 hardcodes A4 portrait; eventually probably needs to be a per-note property (some users want letter, some want square, some want infinite scroll). Not blocking; revisit when multi-page lands (D7).
- **F7.** Default stylus-button + gesture binding? — open. Candidates for the held barrel button (S Pen / Surface / Wacom): (a) temporary eraser mode while held — matches most competing apps' default, makes the button feel like a "modifier key"; (b) cycle to next colour — useful for quick highlight runs; (c) open a radial quick-picker. Candidates for Apple Pencil double-tap: cycle current/previous tool (default in Apple Notes), open colour picker, undo. On iOS we should likely defer to `UIPencilInteraction.preferredTapAction` rather than ship our own default. On Android there's no system pref to defer to, so we ship a setting (`editor.ink.barrelButton` with the same enum as freeform's pen-mode setting per F5). Not blocking — C6 captures the bits regardless; D8 picks the mapping; this question just chooses the *default* the setting starts at.
