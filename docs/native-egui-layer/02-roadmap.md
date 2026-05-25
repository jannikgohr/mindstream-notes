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
Module layout has settled into a clear cross-platform / platform
split: `drawing/{input, page, strokes_doc, surface_source}.rs` are
host-buildable and have no platform deps; `drawing/pipeline.rs` +
`drawing/render.rs` + `drawing/ui/` are cfg-android (will go
cross-platform when E1 lands) but talk only to abstractions —
`Box<dyn SurfaceSource>` rather than `ANativeWindow*`, `input::Sample`
rather than raw `MotionEvent` ints; `drawing/platform/android.rs`
owns the Android-specific glue (the `AndroidWindow` SurfaceSource
impl + all JNI exports). R1, R2, R3, R4 initial scope, and R5
(Android side) are all in.

Auto-save (P4): a dedicated `drawing/save_worker.rs` thread owns
the full debounce → fetch → SQLite write flow. Render thread fires
a non-blocking `notify_dirty(note_id)` mpsc send; worker debounces
(default 800 ms, JS pushes the user setting via
`drawing_set_save_debounce`), pulls the encoded yrs bytes via an
in-process render-thread channel (NOT IPC), and writes via the
new `notes::save_yrs_state` column-only helper. JS sees only
small `drawing:save_status` events (`{note_id, status:
editing|saving|saved|error}`) — the yrs blob never crosses IPC
again. `drawing_hide` triggers a worker flush so navigate-away
within the debounce window saves immediately.

Eraser (D3) post-ship perf pass dropped a 65-sample / 55-hit drag
from ~1.5 s to ~80 ms (~20× total):
1. `visible_strokes` decoded-stroke cache on CanvasDocument
   eliminates per-sample yrs walks (~10 ms → ~0.2 ms per sample).
2. Batched yrs writes + retess once per render loop iteration
   instead of per sample (eraser drags would otherwise compound
   N × O(strokes) yrs walks).
3. `StrokesDoc::tombstone_strokes(&HashSet)` bulk-tombstone (one
   yrs walk total, regardless of how many ids).

Tap-to-canvas latency: end-to-end perf pass dropped a heavy ink
note from ~1.1 s to ~287 ms on a Tab S7 FE. Stack of wins:
schema-v2 opaque-payload strokes (one yrs op per stroke instead of
per point — collab-safe via the outer `Y.Array<Y.Map>`); skipping
the JS-side `loadNote` round-trip (Rust reads `yrs_state` from
SQLite directly inside `drawing_show`); pre-warming `PersistentGpu`
in a background task at app startup so wgpu init is off the open
critical path; `for_each_stroke` switched from indexed `.get()`
(O(log n) per call) to `.iter()` (O(n) total); vertex colour packed
to `Unorm8x4` for half the per-vertex bytes; partial vertex buffer
upload (pen-mode append-only writes ~72 bytes/sample instead of
rewriting the whole ~2 MB buffer); `clear`+extend in tessellation
paths instead of fresh Vec allocations. Diagnostic logs at
`[drawing.perf] …` + `[drawing.perf.eraser] …` stay in for now
since they're rare-event + useful for further tuning.

Input-to-display latency on Galaxy Tab S7 FE: the device exposed
only FIFO presentation and reported `MotionPredictor available=false`,
so the winning path is no longer "predict farther ahead". The current
Android pass uses late-latched FIFO rendering plus an AndroidX
`CanvasFrontBufferedRenderer` live-ink overlay for the in-flight stroke
head. The front-buffer layer draws directly from Kotlin touch samples
while Rust/wgpu remains the source of truth for committed document
strokes; it is cancelled shortly after pen-up so the normal renderer
can take over without a visible gap. Runtime stroke prediction stays
disabled on this device class because the predicted endpoint path could
create ghost straight-line joins.

**Deliberately NOT yet implemented** — see roadmap below: stroke
smoothing; stylus-button → action mapping (the bits flow but
nothing acts on them yet); colour picker / brush size; pan + zoom;
multi-page; live collab; desktop / iOS ports. Rounded caps +
mitered joints (via `lyon`) deferred until thick-stroke joints
actually look notchy in practice.

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
| R3 | `SurfaceSource` trait for cross-platform | Abstract "give me a raw-window-handle + width/height" behind a trait. Render core takes the trait instead of any platform-specific window type; per-platform impls own the native handle. | **Done** — `drawing/surface_source.rs` defines `trait SurfaceSource: HasWindowHandle + HasDisplayHandle + Send {}` with a blanket impl over any matching type. `pipeline::build_first_time` / `build_surface_only` take `Box<dyn SurfaceSource>`; `Msg::SurfaceReady` carries it across the channel (which let us drop the old `unsafe impl Send for Msg`); `render::set_surface` accepts the box. `raw-window-handle` promoted from the android-only dep block to top-level so the trait compiles on host. |
| R4 | `InputSource` abstraction | Same idea for the touch/stylus event stream. Android impl is JNI `pushPoint`; desktop impl is winit `WindowEvent`; iOS is UIKit pen events. Two message shapes, because stylus input is really two different concepts: **(a)** continuous per-sample state — `Sample { x, y, pressure, tool, action, … }`, with `buttons` (bitflags), `tilt`, `azimuth`, `time` added as consumers materialise; **(b)** discrete gestures — `StylusGesture { kind: DoubleTap \| Squeeze \| … }`, fired between strokes, no associated position. Apple Pencil 2's double-tap + Pencil Pro's squeeze live in (b) because they come via `UIPencilInteraction` separately from `UITouch`; held barrel buttons (S Pen, Surface Pen, Wacom) live in (a). | **Done** (initial scope) — `drawing/input.rs` ships `Sample` / `ToolKind` / `SampleAction` as the platform-neutral types the render thread now consumes; JNI translates raw `MotionEvent.*` ints into them at the boundary. Deferred (pending consumers): `buttons: StylusButtons` lands with C6, `StylusGesture` with D8, `tilt` / `azimuth` / `time` when a consumer (D1 smoothing) needs them. The full trait-based `trait InputSource` arrives when more than one platform exists (E1 / E2). |
| R5 | `platform/` module split | `drawing/platform/{android, desktop, ios}.rs`, gated by `cfg(target_os)`. Each file owns its `SurfaceSource` + input bridge + lifecycle hooks. Cross-cutting concerns (NDK context init, JNI class caching) live in the Android-specific file. | **Done** (Android side) — `drawing/platform/android.rs` consolidates `AndroidWindow` (was `surface.rs`) and all JNI exports (was `jni.rs`); the old top-level files are deleted. `drawing/platform/mod.rs` is the cfg-gated module router. `desktop.rs` / `ios.rs` slot in here when E1 / E2 land. JNI symbol names + arg order are unchanged so Kotlin linkage is unaffected. |
| R6 | Cargo workspace consideration | When the drawing crate grows past `src-tauri/src/drawing/`, consider extracting it to a workspace member (`crates/mindstream-canvas/`) so the cross-platform render core has a clean dependency boundary from the Tauri app. Not urgent; flag if compile times get painful. | Pending (low priority) |

### C. Real-feature debt — depends on R landing first

(In practice C0–C2 were taken ahead of R3–R5 because the data-model
work was independent of the platform-abstraction work; C3+ continues
that order. R3–R5 still gate E.)

| # | Item | Notes | Status |
|---|------|-------|--------|
| C0 | Page-coordinate model (stop-stretch + A4) | Strokes stored in page coordinates (document units), not NDC. View transform (`{scale, pan}`) computed each frame to fit page → surface preserving aspect. Default page: A4 portrait at 144 DPI (1190 × 1684 page-units). Constants live in `drawing/page.rs` so future page sizes (Letter, custom, infinite scroll) are a config swap. Rotation no longer stretches. | **Done** (e555652) |
| C1 | Per-note canvas state | One `StrokesDoc` per note, swapped on `drawing_show(note_id)`. | **Done** (f912c85) |
| C2 | Persistence via yrs (`yjs-rs`) + auto-save | Schema-v2: `strokes: Y.Array<Y.Map>` with each map carrying `{id, tombstoned, payload: Any::Buffer}`. The payload is our own little binary format (version + color + n_points + interleaved f32 points + f32 pressures, LE throughout) — one yrs op per stroke instead of per-point. Persisted into `note.yrs_state`, synced via Etebase, collab-safe at stroke granularity (outer `Y.Array<Y.Map>` keeps merge correctness; remote strokes appear atomically on pen-up). Auto-save (P4): dedicated `drawing/save_worker.rs` thread owns debounce + writes; render thread fires non-blocking `notify_dirty(id)` mpsc send, worker pulls bytes via in-process channel and writes via `notes::save_yrs_state` — bytes never cross IPC. JS only sees `drawing:save_status` events for the dockview saving-icon. Debounce window is JS-configurable via `drawing_set_save_debounce`. `drawing_hide` triggers worker `flush_all` so navigate-away saves immediately. | **Done** (645dff6; persistence bugfix 36e74b5; schema-v2 + auto-save shipped post-original-C2; P4 worker swap subsequently) |
| C3 | Pressure + tool-type capture | Kotlin reads `MotionEvent.AXIS_PRESSURE` (+ historical samples), sanitises NaN/0/over-1 to 1.0, and reads `event.getToolType(0)`, then passes through `pushPoint(x, y, pressure, toolType, action)`. Pressure stored as a parallel `pressures: Y.Array<f64>` on each stroke map (additive — no schema bump; legacy strokes default to 1.0 on read). Tool type isn't persisted directly; instead the renderer uses it at `begin_stroke` time to pick a colour (see C4) which is what survives into the doc. Unblocks C4 + D1 + D2 + C6. | **Done** |
| C4 | Variable-width strokes + per-stroke colour | Per-segment CPU tessellation (2-triangle quad with potentially different widths at each endpoint) — no `lyon` dep yet. Each stroke segment uses `width = MIN_WIDTH + (BASE_WIDTH - MIN_WIDTH) * pressure` (MIN=1.0, BASE=4.0 page-units = ~0.18–0.7 mm). Topology flipped to `TriangleList`; vertex format grew to `{position, color}` so each stroke can be rendered in its own colour. `begin_stroke` now takes a packed 0xAARRGGBB colour — currently chosen from tool type (stylus / eraser → debug blue, else → black) as a "did pen detection actually work" visualisation; D5 swaps that mapping for a user-picked palette. Pure-math `segment_quad_positions` lives in `page.rs` with host-side unit tests. Joints aren't mitered — fine for the current thin-stroke regime; revisit (probably with `lyon`'s stroke tessellator) if thick-stroke joints look notchy. Per-stroke `width` field in the schema is still ignored — wires up with D5. | **Done** (deferred lyon + rounded caps) |
| C5 | Live collab on the canvas | Each open ink note's `yrs::Doc` plugs into the existing `CollabProvider` infrastructure (same path markdown notes use for live editing). Yrs broadcasts pen samples to peers as they arrive; remote samples merge into the doc and trigger a re-render. Local-first by construction: offline writes append to the local Y.Array and sync on next reconnect with CRDT-correct merge. Depends on C2. | Pending |
| C6 | Stylus button capture (data plumbing) | Mirrors C3: Kotlin reads `event.buttonState`, JNI signature grew to `pushPoint(x, y, pressure, toolType, buttons, action)`, `Sample` carries `buttons: u32` (raw bitmask matching `MotionEvent.BUTTON_*`; `Sample::has_stylus_primary_button` does the typed bit test). Bit-value constants live in `drawing::input::buttons`. No persistence — buttons are input-time; their *consequences* (e.g. the chosen stroke colour) are what survives. UX policy still deferred to D8; the renderer currently uses `BUTTON_STYLUS_PRIMARY` only as a debug-colour override (button held → orange) so the user can visually confirm detection works on their device. Apple Pencil's discrete gestures (double-tap, Pro squeeze) still need a separate `StylusGesture` shape — open for D8. | **Done** (data plumbing) — promote `buttons: u32` to a `bitflags` type when a second consumer (D8) materialises. |

### D. Quality / feel — depends on C

| # | Item | Notes |
|---|------|-------|
| D1 | `ink-stroke-modeler-rs` smoothing | Audit's headline recommendation. Kalman-filtered strokes, battle-tested error handling, free pressure modeling. Requires verifying C++/cxx cross-compile to `aarch64-linux-android` — fallback is rnote's pure-Rust Catmull-Rom builder. |
| D2 | Low-latency live stroke head | **Done for Android current pass.** Android `MotionPredictor` support is plumbed and logged, but the Tab S7 FE reports it unavailable and the predicted endpoint path caused ghost straight-line joins. The production latency win is late-latched FIFO rendering plus a `CanvasFrontBufferedRenderer` front-buffer overlay for the in-flight stroke head; Rust/wgpu still owns committed strokes and the overlay cancels after pen-up. |
| D3 | Eraser tool | Pen/Eraser segmented control in the toolbar; render thread holds the authoritative `ToolMode`. In Eraser mode each input sample runs a hit-test (`point_to_segment_distance_sq` from `page.rs`, host-tested) against `CanvasDocument::visible_strokes` — an in-memory `StrokeMeta { id, color, bbox, points, pressures }` cache that mirrors visible strokes from yrs. Bbox-reject most strokes in O(1); fine point-to-segment math only for the few overlap candidates. Matches accumulate into a per-batch `pending_eraser_tombstones: HashSet<String>`; at the end of each render-thread loop iteration the worker fires ONE `StrokesDoc::tombstone_strokes(&pending)` bulk yrs walk + one `retessellate_segments_from_cache` (instead of per-sample), turning a dense drag's O(samples × strokes) into O(strokes) total. Per-drag hits accumulate into a Vec that becomes one `UndoOp::EraserDrag` on pen-up. Eraser radius = 10 page-units (~1.4 mm at 144 DPI). End-to-end: ~1.5 s → ~80 ms on a 391-stroke / 65-sample / 55-hit drag (~20× from the original yrs-walking implementation). **Done.** |
| D4 | Undo / redo | Per-note transient stacks on `CanvasDocument`. `UndoOp` enum: `StrokeAdded(id)` (pen-up), `EraserDrag(Vec<id>)` (one per eraser drag), `ClearAll(Vec<id>)` (toolbar Clear, captures the pre-clear visible set so undo restores exactly that). Standard semantics: new mutation clears the redo stack. Toolbar Undo/Redo buttons grey out via `add_enabled` when the matching stack is empty. **Done.** |
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
- **F4.** Prediction window in ms — deferred unless a target device reports reliable `MotionPredictor` support. Current Tab S7 FE path uses front-buffer live ink instead.
- **F5.** Pen-vs-finger mode setting — open. `freeform` notes have an existing `editor.freeform.penMode` setting (auto / always / off); ink notes should mirror so the same gesture is consistent across both editor kinds.
- **F6.** Page size as a user-facing setting? — open. C0 hardcodes A4 portrait; eventually probably needs to be a per-note property (some users want letter, some want square, some want infinite scroll). Not blocking; revisit when multi-page lands (D7).
- **F7.** Default stylus-button + gesture binding? — open. Candidates for the held barrel button (S Pen / Surface / Wacom): (a) temporary eraser mode while held — matches most competing apps' default, makes the button feel like a "modifier key"; (b) cycle to next colour — useful for quick highlight runs; (c) open a radial quick-picker. Candidates for Apple Pencil double-tap: cycle current/previous tool (default in Apple Notes), open colour picker, undo. On iOS we should likely defer to `UIPencilInteraction.preferredTapAction` rather than ship our own default. On Android there's no system pref to defer to, so we ship a setting (`editor.ink.barrelButton` with the same enum as freeform's pen-mode setting per F5). Not blocking — C6 captures the bits regardless; D8 picks the mapping; this question just chooses the *default* the setting starts at.
