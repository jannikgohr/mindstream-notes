# Native egui Drawing Layer — Audit of References

Phase 0 deliverable for the layered egui+wgpu drawing surface under the Tauri WebView (Android first). This is the prerequisite read for the spec in `docs/native-egui-layer/00-spec.md` (TBD — currently lives in the chat transcript that kicked off this branch).

The spec calls for cribbing from three projects. This doc gives a per-target verdict, then the architectural conclusions and gotchas that fall out of all three combined.

---

## Per-target verdicts

### 1. `clearlysid/tauri-plugin-egui` — **adapt mechanically, reject architecture**

**What it does.** Registers a `wry_plugin` against the Tauri runtime. For each Tauri `Window` opted into egui, it builds a wgpu surface from the whole window, runs the egui render loop inside `RedrawRequested`, and translates `tao` events (mouse/keyboard) into `egui::RawInput`.

**What's reusable** (`src/renderer.rs` — ~150 lines):
- `Gpu::new_async` — wgpu instance → adapter → device → queue → surface configuration. Copy verbatim with minor tweaks.
- Surface format pick: `find(|f| !f.is_srgb() && matches!(f, Rgba8Unorm|Bgra8Unorm|…))`. Egui wants linear; this matters on every platform.
- Alpha-mode pick: `find(|m| *m != CompositeAlphaMode::Opaque)` — exactly the trick we need for a transparent surface under the WebView.
- The per-frame loop shape: `take_egui_input → ctx.run → tessellate → egui_wgpu::Renderer::{update_texture, update_buffers, render}`.

**What's a dead end:**
- The whole `plugin.rs` (`PluginBuilder<T>`, `impl Plugin<T>`, `on_event`) is built on `tauri_runtime_wry::{Plugin, EventLoopIterationContext}` and `tao::event::Event`. **None of this exists on Android** — Tauri-on-Android doesn't run a `tao` event loop; it's Activity-driven. The `wry_plugin` mechanism is desktop-only.
- The plugin renders to the *entire window*, replacing the WebView's GL output. Our spec is the inverse: WebView on top, egui underneath, both in the same window. This plugin offers zero guidance on layering.
- Input translation (`translate_logical_key`, `translate_physical_key`, mouse/wheel handling) is hundreds of lines of mapping code we throw away — we need stylus pressure/tilt, not keyboard.
- `unsafe impl Send for EguiWindow {}` is a smell; their `egui::Context` lives behind a `Mutex` they only ever touch from the event-loop thread. We'll have similar threading constraints but should structure them more honestly.

**Versions.** Pins `wgpu = "25"`, `egui = "0.32"`, `egui-wgpu = "0.32"`, `tauri = "2.7"`. Our project is on `tauri = "2.11"` already (compatible with their fix re: tao patch upstreamed in 2.7). When we add these deps, match versions across the three egui crates.

**Verdict.** Copy `renderer.rs` style, ignore everything else. The mental model "Tauri owns the window, egui draws into it" is correct in spirit — but the *mechanism* (wry_plugin hooking into tao) doesn't translate to Android.

---

### 2. `flxzt/rnote` (rnote-compose crate) — **adopt the data model, delegate the math**

**The biggest single finding in this audit.** The spec's stroke pipeline ("moving average, B-spline interpolation, Ramer–Douglas–Peucker reduction") is reinventing the wheel. Rnote's modeled-stroke path (`crates/rnote-compose/src/builders/penpathmodeledbuilder.rs`) delegates *all* of that to **[`ink-stroke-modeler-rs`](https://crates.io/crates/ink-stroke-modeler-rs)** — a Rust binding for Google's `ink-stroke-modeler` (the same Kalman-filter–based modeler used in Android's `androidx.input.motionprediction`, Chrome OS handwriting, and Google Pixel's stylus stack).

This gives us, for free:
- Per-frame smoothing with a tuned Kalman filter.
- **Forward stroke prediction** — `stroke_modeler.predict()` returns where the pen *will be* in the next few ms, so we can render ahead of the actual touchpoint and hide input→display latency. This is the single highest-impact lever for perceived ink lag on Android, and the spec doesn't mention it.
- Pressure modeling.
- Battle-tested error cases (duplicate samples, negative time deltas, samples too far apart).

Rnote's tuning constants are a sane starting point:
```rust
ModelerParams {
    sampling_min_output_rate: 120.0,
    sampling_end_of_stroke_stopping_distance: 0.01,
    sampling_end_of_stroke_max_iterations: 20,
    sampling_max_outputs_per_call: 200,
    stylus_state_modeler_max_input_samples: 20,
    ..ModelerParams::suggested()
}
```

**Data shapes worth lifting** (`crates/rnote-compose/src/penpath/`):
- `Element { pos: Vector2<f64>, pressure: f64 }` — minimal canonical input. Pressure clamped `[0.0, 1.0]`. Time travels alongside, not inside.
- `Segment` enum: `LineTo { end } | QuadBezTo { cp, end } | CubBezTo { cp1, cp2, end }` — the output shape from a builder. This is what `lyon` would tessellate.
- `PenEvent::Down` is emitted *repeatedly* while the pen is down and moving, not just at touchdown. Stateless events. Good model for the JNI input stream.

**What we skip:**
- `kurbo` + `piet` + `piet-cairo` rendering stack — they target GTK4. We render via `egui_wgpu` + `lyon` direct to wgpu vertex buffers.
- `nalgebra` (`Vector2<f64>`). For a wgpu pipeline `glam` (`Vec2`, `f32`) is lighter, idiomatic, and avoids the f64→f32 downcast on every vertex. Cost: we'd convert at the modeler boundary.
- The shape pens (rectangle, ellipse, arrow builders, rough.js port) — we just want freehand ink for v1.

**Curved + simple builders** (`penpathcurvedbuilder.rs`, `penpathsimplebuilder.rs`) are useful as fallbacks if `ink-stroke-modeler-rs` ever misbehaves — the curved one does Catmull-Rom-ish cubic bezier interp without time/pressure. Worth knowing they exist; not adopting on day 1.

**Verdict.** Take the data shapes (`Element`, `Segment`, `PenEvent::Down`-repeating model), take `ink-stroke-modeler-rs` outright, leave the rest. Estimated saving vs the spec's hand-rolled math: a couple of weeks plus the prediction win.

---

### 3. `tauri-apps/plugins-workspace` (mobile plugins) — **the canonical scaffolding pattern**

Looked at `barcode-scanner` (most relevant — it injects a sibling view alongside the WebView) and `biometric` (most minimal — pure control plane).

**Standard plugin scaffold** (verbatim-able):

```
plugins/<name>/
  Cargo.toml
  build.rs                  # tauri_plugin::Builder::new(COMMANDS).android_path("android").ios_path("ios")
  src/
    lib.rs                  # #![cfg(mobile)] gated; pub fn init() -> TauriPlugin<R>
    mobile.rs               # optional — wraps PluginHandle::run_mobile_plugin calls
    models.rs error.rs
  android/
    build.gradle.kts settings.gradle
    src/main/AndroidManifest.xml
    src/main/java/<PluginName>Plugin.kt
  ios/ permissions/ guest-js/
```

The Rust-side bridge boilerplate (lifted from `barcode-scanner/src/lib.rs`):
```rust
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "app.tauri.drawing"; // match Kotlin package

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("drawing")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "DrawingPlugin")?;
            app.manage(Drawing(handle));
            Ok(())
        })
        .build()
}
```

**The barcode-scanner sibling-injection pattern is exactly our spec's Layer 1/Layer 2 model:**
```kotlin
val parent = webView.parent as ViewGroup
parent.addView(previewView)      // (or our SurfaceView)
parent.addView(graphicOverlay)
if (windowed) {
    webView.bringToFront()
    webViewBackground = webView.background
    webView.setBackgroundColor(Color.TRANSPARENT)
}
```
That's the whole architecture. `Plugin.load(webView: WebView)` is the override that runs when the plugin is wired up — perfect time to inject our `SurfaceView`.

**`@Command` is the wrong tool for the data plane.** `@Command fun foo(invoke: Invoke)` round-trips through Tauri's IPC: JSON-serialize → JS bridge → Rust deserialize. Fine for ~10 Hz control messages ("set pen color", "clear canvas", "save snapshot"). **Atrocious for 240 Hz pressure-bearing stylus samples.** We must not use it for the input data plane.

**Use raw JNI for the data plane — and the repo already has a working example.** See `src-tauri/gen/android/app/src/main/java/io/crates/keyring/Keyring.kt`:
```kotlin
class Keyring {
    companion object {
        init { System.loadLibrary("mindstream_notes_lib") }
        external fun initializeNdkContext(context: Context)
    }
}
```
The Rust side exports `Java_io_crates_keyring_Keyring_00024Companion_initializeNdkContext`. This is the pattern we replicate for `external fun pushMotionSample(...)` and `external fun setSurface(surface: Surface)`. No JSON, no IPC; a direct JNI call into the same `cdylib` Tauri already loads.

**Verdict.** Use the plugin-workspace pattern for control-plane scaffolding. Use the barcode-scanner sibling-view trick for layering. Use the Keyring raw-JNI pattern for input + surface handoff. None of these conflict — they're the three layers of one architecture.

---

## Architectural conclusions (deltas vs the spec)

| Spec said | Audit says |
|---|---|
| Crib `wry_plugin` injection from tauri-plugin-egui | That mechanism is desktop-only. On Android we inject a `SurfaceView` Kotlin-side, hand the surface to Rust over JNI, and create the wgpu surface from a raw `ANativeWindow` pointer. tauri-plugin-egui contributes only the wgpu/egui-wgpu setup code. |
| Path smoothing = moving average + B-spline; simplification = RDP | Use `ink-stroke-modeler-rs`. It's a Kalman-filter modeler with built-in prediction. Drop the hand-rolled chain; we'd be reimplementing a worse version of the same thing. |
| Lyon tessellates dynamic pressure-weighted paths | Still correct. Modeler emits smoothed `(pos, pressure)` samples → we build pressure-tapered triangle strips with `lyon` → upload to wgpu vertex buffers. The modeler doesn't replace lyon; it sits in front of it. |
| Plugin workspace split: `desktop.rs` / `mobile.rs` / `android/` | Confirmed canonical. Add `build.rs` calling `tauri_plugin::Builder::new(COMMANDS).android_path("android")`. Keep `#![cfg(mobile)]` at the top of `lib.rs` for the mobile entry. |
| 240 Hz input via `getHistorySize()` / `getHistoricalX/Y` | Confirmed. But the spec is silent on the transport — it must be **raw JNI**, not Tauri's `@Command` IPC. Reuse the Keyring.kt symbol-mangling pattern that's already proven in this repo. |
| `egui::Context` lives in `src/lib.rs`, agnostic to JNI vs winit | Correct goal. Concretely: one struct owns `(wgpu device/queue/surface, egui Context, egui_wgpu Renderer, ink_stroke_modeler::StrokeModeler, lyon tessellator)`. Surface and input come in via traits we implement once per platform. |

---

## Recommended dependency set (first cut)

For `src-tauri/Cargo.toml`, gated behind `[target.'cfg(target_os = "android")']` until Phase 2:

```toml
wgpu = "25"                 # match tauri-plugin-egui's pin; egui-wgpu 0.32 needs this
egui = "0.32"
egui-wgpu = "0.32"
lyon = "1"                  # geometry + tessellation
ink-stroke-modeler-rs = "*" # pin to whatever rnote is on; verify Android cross-compile
glam = "0.30"               # f32 vec/mat math, plays nicely with wgpu/lyon
raw-window-handle = "0.6"   # for handing the ANativeWindow to wgpu::Instance::create_surface_unsafe
ndk = "0.9"                 # ANativeWindow_fromSurface(env, jsurface)
jni = "0.21"                # already a transitive dep via ndk; explicit dep for our exports
```

`ndk-context` is already initialized by the Keyring plugin in `MainActivity.onCreate` — process-global, so our drawing JNI code can rely on it without re-initializing.

---

## Gotchas surfaced during the audit

Ordered roughly by how much pain they'll cause if ignored.

1. **`SurfaceView` z-order is not view-tree z-order.** A `SurfaceView` lives in its own `SurfaceFlinger`-managed window. By default (`setZOrderOnTop(false)`) it sits *behind* the app's window — which is exactly what we want: WebView (with `Color.TRANSPARENT` background) composites on top. But the moment someone calls `setZOrderOnTop(true)` or `setZOrderMediaOverlay(true)`, the SurfaceView punches through and the WebView is hidden. **Lock this down with a comment.** Alternative is `TextureView` — composites cleanly inside the view hierarchy at the cost of one extra GPU copy (~1 frame latency). For a stylus app, that frame matters; SurfaceView wins.

2. **`Surface` invalidation on Android lifecycle.** `SurfaceHolder.Callback.surfaceDestroyed` fires when the app is backgrounded, the device rotates, or the screen turns off. After that the wgpu surface is dead. The tauri-plugin-egui renderer does `surface.get_current_texture().expect(...)` — that panics on Android. We must catch `SurfaceError::Lost`/`Outdated` and rebuild the surface in `surfaceCreated`/`surfaceChanged`.

3. **WebView default background is opaque.** Setting `webView.setBackgroundColor(Color.TRANSPARENT)` is necessary (barcode-scanner does it) but not always sufficient — depending on `WebSettings`, the HTML body itself may render white. We need `<html>` and `<body>` (and the main app shell) to explicitly set `background: transparent` and `background-color: rgba(0,0,0,0)`. The frontend already exists, so this needs an audit pass.

4. **`ink-stroke-modeler-rs` cross-compile for Android is unverified.** The upstream `ink-stroke-modeler` is C++. The Rust crate wraps it via `cxx`. Cross-compiling C++ to `aarch64-linux-android` from Tauri's normal build chain *should* work (NDK clang handles it), but we should verify with `cargo check --target aarch64-linux-android` before depending on it structurally. If it doesn't compile, fallback is rnote's "curved" builder (Catmull-Rom, pure Rust, no prediction).

5. **`@Command`-IPC latency is not acceptable for stylus input.** Already covered above — flagging again because it's tempting to start with `@Command fun pushMotionEvent(invoke: Invoke)` since the scaffold is easier. Resist; we'd hit a wall at the first real-device test. Build the raw-JNI path first.

6. **`MotionEvent` timestamps are `uptimeMillis()`, not `Instant`.** The modeler wants `f64` seconds since stroke start. Conversion: capture one `Instant` and one `uptimeMillis()` at stroke `Down`, then for every subsequent sample compute `(eventTime - downEventTime) / 1000.0` as f64. Do NOT call `Instant::now()` on the Rust side for each sample — it adds jitter and loses the digitizer's actual timing.

7. **`event.getHistorySize()` only carries position + pressure + tilt — not all axes.** It's a separate buffered stream. Real-time code must iterate `0..historySize` for the buffered samples *then* read the "current" sample fields. Easy to drop the current sample by forgetting the final read; barcode-scanner doesn't show this pattern (it's not a stylus plugin).

8. **`Plugin.load(webView)` runs on the UI thread.** Anything we do there (view inflation, surface attachment) is fine on the UI thread but anything Rust-side that blocks (e.g. async wgpu init via `block_on`) will jank the UI. tauri-plugin-egui uses `tauri::async_runtime::block_on` for wgpu adapter request — on the Android UI thread that's a hazard. We should kick wgpu init onto a worker thread and signal back when ready.

9. **`egui::Context` is `!Send` in the obvious uses, requires careful threading.** tauri-plugin-egui papers over this with `unsafe impl Send`. We should keep all egui access on one render thread and pipe input/commands to it via a channel — cleaner and avoids the unsafe.

10. **Stylus eraser / barrel button detection via `getToolType()` is the right call**, but on many Android OEM stylus stacks `TOOL_TYPE_ERASER` reports inconsistently when the user flips the pen; the official cross-vendor signal is `event.getButtonState() & BUTTON_STYLUS_PRIMARY`. Plan to handle both.

11. **`crate-type = ["staticlib", "cdylib", "rlib"]` is already set** in our `src-tauri/Cargo.toml` — JNI symbols will end up in `libmindstream_notes_lib.so` as expected. One less wiring step.

12. **Package + class names are load-bearing JNI symbol fragments.** As the Keyring.kt comments document, the Rust `#[unsafe(no_mangle)] pub extern "system" fn Java_io_crates_keyring_Keyring_00024Companion_initializeNdkContext` symbol is built from the Kotlin package, class, `$Companion`, and method name. Renaming any of those four things breaks the link. We should pick package + class names for the drawing plugin up front and not bikeshed them later. Suggest `io.crates.drawing.Drawing` for parity with `io.crates.keyring.Keyring`.

---

## Open questions for the spec

These came up during the audit and need answers before the scaffolding step (#2):

- **Q1.** SurfaceView or TextureView? Audit recommends SurfaceView (lower latency); decision logged here, but worth a brief manual A/B once we have something rendering.
- **Q2.** Single-process JNI design — do we want one `libmindstream_notes_lib.so` carrying both the keyring JNI symbols and the drawing JNI symbols (current trajectory), or split the drawing layer into its own `.so`? Current trajectory is simpler and matches how Tauri expects things; flagging only because if we ever want to ship the drawing layer as a standalone crate to other Tauri apps, the single-`.so` choice complicates that.
- **Q3.** Does the drawing plugin need its own `Drawing.initializeNdkContext` call in `MainActivity.onCreate`, or is the Keyring init enough? `ndk-context` is process-global so Keyring's call covers us — but if someone ever removes the keyring crate, the drawing layer will silently lose its NDK context. Either (a) document the load-bearing dependency, or (b) defensively re-init in the drawing plugin (idempotent).
- **Q4.** Prediction window: how many ms ahead do we render via `stroke_modeler.predict()`? Too far and the predicted ink "wags" past the pen; too close and we don't hide the latency. Rnote doesn't pick a number — they render the prediction every frame as a separate visual layer. We should pick a target (e.g. 16–32 ms ahead) and validate on hardware.
- **Q5.** Pen-vs-finger: do we draw only on `TOOL_TYPE_STYLUS` events and ignore `TOOL_TYPE_FINGER`, or accept both with a setting? The existing freeform/tldraw layer has a "stylus pen-mode setting" — we likely want the same here for consistency.

---

## What the next step (#2 — scaffold) should produce

Concretely, after the audit, the scaffolding pass should land:

- `src-tauri/Cargo.toml` — add the dep block above behind `cfg(target_os = "android")`.
- `src-tauri/src/drawing/mod.rs` — `pub fn init() -> TauriPlugin<R>` following the barcode-scanner shape. `#![cfg(mobile)]` for now.
- `src-tauri/src/drawing/mobile.rs` — empty placeholder for the `run_mobile_plugin`–based control-plane commands.
- `src-tauri/src/drawing/jni.rs` — empty placeholder, will hold the raw `Java_io_crates_drawing_*` exports.
- `src-tauri/src/drawing/android/` — Kotlin sub-project with `build.gradle.kts`, `AndroidManifest.xml`, and a `DrawingPlugin.kt` that does nothing more than `override fun load(webView: WebView) { Log.d(...) }`.
- Wired up from `src-tauri/src/lib.rs::run()`'s `Builder::default()` chain.

No rendering, no input, no surface — just structural parity. Verify it builds for `aarch64-linux-android` and the app still launches with the existing functionality intact.
