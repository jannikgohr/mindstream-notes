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
(C2), and end-to-end pressure capture (C3 — stored per-point;
renderer ignores it until C4 hooks up variable-width tessellation).
The code has been split out of single-file `render.rs` into
`surface.rs` / `pipeline.rs` / `ui/{mod, toolbar}.rs` / `jni.rs`
(R1, R2 partial); `render.rs` retains the render-thread loop +
JNI-facing public API.

**Deliberately NOT yet implemented** — see roadmap below: stroke
smoothing; thick / pressure-tapered strokes; live collab;
cross-platform `SurfaceSource` / `InputSource` traits; desktop
port.

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
| R4 | `InputSource` abstraction | Same idea for the touch/stylus event stream. Android impl is JNI `pushPoint`; desktop impl is winit `WindowEvent`; iOS is UIKit pen events. Common output: `Sample { pos, pressure, tilt, action, time }`. | Pending |
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
| C3 | Pressure capture | Kotlin reads `MotionEvent.AXIS_PRESSURE` (+ historical samples), sanitises NaN/0/over-1 to 1.0, and passes through `pushPoint(x, y, pressure, action)`. Stored as a parallel `pressures: Y.Array<f64>` on each stroke map (additive — no schema bump; legacy strokes default to 1.0 on read). The renderer threads pressure to `StrokesDoc::push_point` but currently ignores it on the GPU side (uniform-width `LineList` until C4). Unblocks C4 + D1 + D2. | **Done** |
| C4 | Variable-width strokes via `lyon` | Replace `PrimitiveTopology::LineList` with `lyon` tessellation: pressure-tapered triangle strips with rounded caps. Vertex format grows to `{pos, width}` or pre-baked outlines. Page-coord model (C0) means the tessellator works in document space and the view transform handles screen mapping. Depends on C3. | Pending |
| C5 | Live collab on the canvas | Each open ink note's `yrs::Doc` plugs into the existing `CollabProvider` infrastructure (same path markdown notes use for live editing). Yrs broadcasts pen samples to peers as they arrive; remote samples merge into the doc and trigger a re-render. Local-first by construction: offline writes append to the local Y.Array and sync on next reconnect with CRDT-correct merge. Depends on C2. | Pending |

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
