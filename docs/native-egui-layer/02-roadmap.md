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

**Deliberately NOT yet implemented** — see roadmap below: page
coordinates (strokes currently stored in NDC, stretch on rotate);
persistence (strokes vanish on close); per-note canvas state (all
ink notes share one global stroke buffer); pressure; stroke
smoothing; thick / pressure-tapered strokes; live collab; desktop
port. Code is still single-file (`drawing/render.rs` is ~700
lines) — a modularisation pass is queued before the next big
feature lands.

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

| # | Item | Notes |
|---|------|-------|
| R1 | Split `drawing/render.rs` into a directory | `drawing/render.rs` is ~700 lines and growing. Suggested layout: `drawing/{mod, surface, input, render/{pipeline, frame}, ui/{toolbar}, thread, jni}.rs`. Pure mechanical move + re-exports — no behavioural change. |
| R2 | `canvas_ui` submodule for egui UI | Carve the egui `TopBottomPanel` + button handling out of `render_frame` into `drawing/ui/`. Future toolbar tabs (color picker, eraser toggle, brush size, undo, page nav) each get their own file (`ui/color_picker.rs`, `ui/eraser.rs`, …). Top-level `ui/mod.rs` exposes a `CanvasUi` struct with `fn run(&mut self, ctx: &egui::Context) -> RenderActions`. |
| R3 | `SurfaceSource` trait for cross-platform | Abstract "give me a raw-window-handle + width/height" behind a trait. Android impl wraps `ANativeWindow` (current code, moved to `platform/android.rs`); desktop impl wraps winit/wry handle (E1). Render core takes `&dyn SurfaceSource` and stops knowing about Android. |
| R4 | `InputSource` abstraction | Same idea for the touch/stylus event stream. Android impl is JNI `pushPoint`; desktop impl is winit `WindowEvent`; iOS is UIKit pen events. Common output: `Sample { pos, pressure, tilt, action, time }`. |
| R5 | `platform/` module split | `drawing/platform/{android, desktop, ios}.rs`, gated by `cfg(target_os)`. Each file owns its `SurfaceSource` + `InputSource` impls and lifecycle hooks. Cross-cutting concerns (NDK context init, JNI class caching) live in the Android-specific file. |
| R6 | Cargo workspace consideration | When the drawing crate grows past `src-tauri/src/drawing/`, consider extracting it to a workspace member (`crates/mindstream-canvas/`) so the cross-platform render core has a clean dependency boundary from the Tauri app. Not urgent; flag if compile times get painful. |

### C. Real-feature debt — depends on R landing first

| # | Item | Notes |
|---|------|-------|
| C0 | Page-coordinate model (stop-stretch + A4) | **Picked scope #1 + A4.** Strokes stored in page coordinates (f64 or f32 in document units), not NDC. View transform (`{scale, pan}`) computed each frame to fit page → surface preserving aspect. Default page: A4 portrait at 144 DPI (1190 × 1684 page-units). Constants live in `drawing/page.rs` so future page sizes (Letter, custom, infinite scroll) are a config swap. Rotation no longer stretches because the same page coordinates re-fit to the new surface. **Foundation for C1/C2/C5 — strokes must be stored in a coord system that's independent of which device drew them.** |
| C1 | Per-note canvas state | Today there's one global stroke buffer; all ink notes share it. Move strokes into per-note `Document` keyed by `note_id`, swap on `drawing_show(note_id)`. |
| C2 | Persistence via yrs (`yjs-rs`) | **Picked.** Use `yrs::Doc` like markdown / freeform notes — strokes as a `Y.Array<Y.Map>`, each map carrying `{id, color, width, points: Y.Array<Point>}`. Saved into `note.yrs_state`, synced via Etebase (no special-cased server schema — same path the other note kinds already use). Pen-down opens a fresh `Stroke`, samples append to its `points` Y.Array, pen-up commits. Eraser sets a tombstone field on the stroke (don't delete; we want offline-merge convergence). Format versioned via a `schema` field on the doc root for future migrations. |
| C3 | Pressure capture | Kotlin already pulls `MotionEvent.AXIS_PRESSURE`; the JNI `pushPoint` signature drops it. Widen the `Sample` shape from R4 to carry `pressure` + `tilt` + `time`; thread through the render thread; store on each Point in the Y.Array (C2). |
| C4 | Variable-width strokes via `lyon` | Replace `PrimitiveTopology::LineList` with `lyon` tessellation: pressure-tapered triangle strips with rounded caps. Vertex format grows to `{pos, width}` or pre-baked outlines. Page-coord model (C0) means the tessellator works in document space and the view transform handles screen mapping. |
| C5 | Live collab on the canvas | Each open ink note's `yrs::Doc` plugs into the existing `CollabProvider` infrastructure (same path markdown notes use for live editing). Yrs broadcasts pen samples to peers as they arrive; remote samples merge into the doc and trigger a re-render. Local-first by construction: offline writes append to the local Y.Array and sync on next reconnect with CRDT-correct merge. Depends on C2 (must have the yrs doc shape first). |

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
