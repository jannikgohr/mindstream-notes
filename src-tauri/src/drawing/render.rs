//! wgpu line-rendering pipeline + egui toolbar for the POC.
//!
//! Architecture (per `mod.rs` header):
//!
//!   ┌── JNI thread (Kotlin → Rust) ──┐
//!   │  setSurface / clearSurface /   │
//!   │  pushPoint                     │
//!   │           ▼                    │
//!   │     mpsc::Sender ──────────────┼──► render thread
//!   └────────────────────────────────┘    (owns wgpu + egui state)
//!
//! All wgpu / egui state lives on the render thread. JNI callers only
//! push `Msg`s onto a sender stored in a global Mutex. The render
//! thread is spawned the first time `set_surface` runs and torn down
//! when the surface is dropped — for the POC we don't try to preserve
//! strokes across an app backgrounding cycle.
//!
//! Two rendering layers in one render pass:
//!   1. Black ink as PrimitiveTopology::LineList. Each ACTION_MOVE
//!      sample emits two vertices (prev, current).
//!   2. An egui top-bar drawn through egui_wgpu::Renderer with the
//!      back + clear buttons. The bar's pixel-height region is
//!      reserved at touch-routing time (see `stroke_suppressed`
//!      handling in `render_thread`) so a tap on a button doesn't
//!      also lay down an ink dot.
//!
//! Button clicks bubble out of `render()` as `RenderActions`; the
//! render thread responds by either clearing the segment buffer
//! (Clear) or calling back into Kotlin via JNI to dispatch a
//! window event the Svelte side listens for (Back).

use std::ptr::NonNull;
use std::sync::mpsc::{self, Sender, SyncSender, TryRecvError};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use bytemuck::{Pod, Zeroable};
use raw_window_handle::{
    AndroidDisplayHandle, AndroidNdkWindowHandle, DisplayHandle, HandleError, HasDisplayHandle,
    HasWindowHandle, RawDisplayHandle, RawWindowHandle, WindowHandle,
};

/// Android MotionEvent action constants we care about. Mirrors
/// `android.view.MotionEvent.ACTION_*` so the Kotlin side can forward
/// the raw int without translation.
const ACTION_DOWN: i32 = 0;
const ACTION_UP: i32 = 1;
const ACTION_MOVE: i32 = 2;
const ACTION_CANCEL: i32 = 3;

/// Pixels at the top of the surface that the system status bar
/// composites on top of (MainActivity calls `enableEdgeToEdge`, so our
/// SurfaceView extends under it). Anything we paint in y < this is
/// hidden behind the status bar text/icons. Conservative hardcode for
/// the POC — covers the Samsung S23+ (74px) plus mandatory system-
/// gesture inset (108px) with margin, plus an emulator's typically
/// taller status bar. Proper fix is task #19: read
/// `WindowInsetsCompat.systemBars().top` from Kotlin and pass it via
/// JNI so this can be device-specific.
const STATUS_BAR_INSET_PX: f32 = 144.0;

/// Visible portion of the toolbar — what's actually tap-target sized
/// below the status bar inset. Total panel painted = inset + this.
const TOOLBAR_HEIGHT_PX: f32 = 120.0;

/// Combined "egui owns this gesture, don't start a stroke" region —
/// status bar area plus the actual toolbar. A user can't really tap
/// in the status bar (the system bar grabs those gestures), but if a
/// MOVE drifts up there we don't want it secretly drawing under the
/// toolbar background either.
const TOOLBAR_TOTAL_PX: f32 = STATUS_BAR_INSET_PX + TOOLBAR_HEIGHT_PX;

/// Fixed scale factor we tell egui. We could query
/// `DisplayMetrics.density` from Kotlin and plumb it through, but
/// 2.5 is close enough to the typical phone density that egui's
/// default font sizes render at usable point sizes. Wire dynamic
/// scaling in when we add a settings hook for it.
const PIXELS_PER_POINT: f32 = 2.5;

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct Vertex {
    position: [f32; 2],
}

impl Vertex {
    const ATTRIBS: [wgpu::VertexAttribute; 1] = wgpu::vertex_attr_array![0 => Float32x2];

    fn layout() -> wgpu::VertexBufferLayout<'static> {
        wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<Self>() as wgpu::BufferAddress,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &Self::ATTRIBS,
        }
    }
}

/// What the egui UI decided this frame. Bubbled out of `render()`
/// so the render thread can react (clear segments / call back into
/// Kotlin) outside of the immediate-mode closure.
#[derive(Default, Debug, Clone, Copy)]
struct RenderActions {
    back: bool,
    clear: bool,
}

/// Messages the render thread accepts.
enum Msg {
    /// New `Surface` arrived from the SurfaceHolder.surfaceCreated
    /// callback. `native_window` is an owned ref (already had
    /// `ANativeWindow_acquire` called or came from
    /// `ANativeWindow_fromSurface`, which acquires). The render thread
    /// is responsible for releasing it via `Drop`.
    SurfaceReady {
        native_window: NonNull<ndk_sys::ANativeWindow>,
        width: u32,
        height: u32,
    },
    /// The hosting SurfaceView was resized (rotation, IME, etc.).
    Resize { width: u32, height: u32 },
    /// `SurfaceHolder.Callback.surfaceDestroyed` fired — the underlying
    /// `ANativeWindow` is about to become invalid. Drop the wgpu
    /// surface immediately so a stray render call doesn't touch a
    /// dangling handle. The render thread keeps running so the next
    /// `SurfaceReady` can rebuild without a thread restart.
    ///
    /// The optional reply slot is what makes `clear_surface()` block:
    /// the JNI thread holds the SurfaceHolder callback open for as
    /// long as it doesn't return, and Android only invalidates the
    /// ANativeWindow after we return. By acking once the GpuState
    /// is dropped we keep the wgpu Surface destruction inside the
    /// window where the underlying handle is still valid — the
    /// alternative produces FORTIFY mutex-after-destroy crashes when
    /// wgpu's swap-chain teardown chases a dangling EGL context.
    SurfaceLost { reply: Option<SyncSender<()>> },
    /// Forwarded stylus / touch sample. `x`/`y` are in surface pixel
    /// coordinates with the origin top-left.
    Sample { x: f32, y: f32, action: i32 },
    /// Wipe all accumulated geometry.
    Clear,
}

unsafe impl Send for Msg {}

/// Owns an `ANativeWindow*` and implements the raw-handle traits wgpu
/// needs to build a Surface. Drop releases the window reference.
///
/// `NonNull` keeps us honest at compile time; we only ever build this
/// from a pointer we just acquired in `SurfaceReady`, so the
/// non-null invariant is upheld at the JNI boundary.
struct AndroidWindow {
    inner: NonNull<ndk_sys::ANativeWindow>,
}

// The pointer is `Send` once we own the reference — wgpu shuttles the
// surface across threads internally even though we only touch it from
// the render thread.
unsafe impl Send for AndroidWindow {}
unsafe impl Sync for AndroidWindow {}

impl HasWindowHandle for AndroidWindow {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let raw = RawWindowHandle::AndroidNdk(AndroidNdkWindowHandle::new(self.inner.cast()));
        // SAFETY: `self.inner` is a valid ANativeWindow* held alive by
        // this struct (released only in `Drop`), so the borrow is valid
        // for as long as `&self` is.
        Ok(unsafe { WindowHandle::borrow_raw(raw) })
    }
}

impl HasDisplayHandle for AndroidWindow {
    fn display_handle(&self) -> Result<DisplayHandle<'_>, HandleError> {
        let raw = RawDisplayHandle::Android(AndroidDisplayHandle::new());
        // SAFETY: Android's display handle is unit / has no associated
        // resource, so any lifetime is sound.
        Ok(unsafe { DisplayHandle::borrow_raw(raw) })
    }
}

impl Drop for AndroidWindow {
    fn drop(&mut self) {
        // SAFETY: `inner` was obtained via `ANativeWindow_fromSurface`
        // (or its equivalent) which acquires a reference; releasing
        // exactly once balances that acquire.
        unsafe { ndk_sys::ANativeWindow_release(self.inner.as_ptr()) };
    }
}

/// The render-thread sender. Set on first surface attach, cleared on
/// shutdown. Per-process singleton — there is exactly one drawing
/// surface for the whole app at a time.
static SENDER: OnceLock<Mutex<Option<Sender<Msg>>>> = OnceLock::new();

fn sender_slot() -> &'static Mutex<Option<Sender<Msg>>> {
    SENDER.get_or_init(|| Mutex::new(None))
}

fn send(msg: Msg) {
    if let Ok(slot) = sender_slot().lock() {
        if let Some(tx) = slot.as_ref() {
            // best-effort: if the render thread has died, dropping the
            // message is the safe move — it'll be re-driven on the
            // next SurfaceReady.
            let _ = tx.send(msg);
        }
    }
}

/// JNI entrypoint: hand a freshly-acquired ANativeWindow over to the
/// render thread, spawning it lazily on first call.
pub fn set_surface(native_window: NonNull<ndk_sys::ANativeWindow>, width: u32, height: u32) {
    let mut slot = match sender_slot().lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if slot.is_none() {
        let (tx, rx) = mpsc::channel();
        thread::Builder::new()
            .name("mindstream-drawing".into())
            .spawn(move || {
                // catch_unwind so a panic inside wgpu (or our own
                // code) surfaces in logcat with a backtrace instead
                // of disappearing into a bare SIGSEGV in libc. The
                // hook fires before catch_unwind unwinds, so the
                // payload itself is just for the "thread X panicked"
                // line in logs.
                if let Err(payload) =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| render_thread(rx)))
                {
                    let msg = if let Some(s) = payload.downcast_ref::<&str>() {
                        (*s).to_string()
                    } else if let Some(s) = payload.downcast_ref::<String>() {
                        s.clone()
                    } else {
                        "unknown panic payload".to_string()
                    };
                    log::error!("[drawing] render thread panicked: {msg}");
                }
            })
            .expect("spawn drawing render thread");
        *slot = Some(tx);
    }
    if let Some(tx) = slot.as_ref() {
        let _ = tx.send(Msg::SurfaceReady {
            native_window,
            width,
            height,
        });
    }
}

pub fn resize_surface(width: u32, height: u32) {
    send(Msg::Resize { width, height });
}

/// Synchronously drop the wgpu surface — blocks the JNI caller until
/// the render thread acks. This must run before the JNI thread
/// returns from `SurfaceHolder.Callback.surfaceDestroyed`, otherwise
/// Android invalidates the ANativeWindow under wgpu's feet and the
/// swap-chain teardown races into a destroyed EGL context (FORTIFY
/// pthread_mutex_lock-on-destroyed-mutex SIGABRT).
///
/// Bounded wait: a stuck render thread shouldn't hang Android's
/// surface lifecycle indefinitely. 500ms is generous for "drop a
/// device + queue" and matches the order of magnitude Android
/// gives lifecycle callbacks before ANR.
pub fn clear_surface() {
    let render_thread_present = sender_slot()
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false);
    log::info!(
        "[drawing] clear_surface: entering sync wait (render thread alive = {render_thread_present})"
    );
    let (tx, rx) = mpsc::sync_channel::<()>(1);
    send(Msg::SurfaceLost { reply: Some(tx) });
    match rx.recv_timeout(Duration::from_millis(500)) {
        Ok(()) => log::info!("[drawing] clear_surface: render thread acked drop"),
        Err(_) => log::warn!("[drawing] clear_surface: ack timed out — proceeding anyway"),
    }
}

pub fn push_sample(x: f32, y: f32, action: i32) {
    // debug! rather than trace! so the per-sample stream is visible
    // under default logcat filters during POC bring-up. Drop back to
    // trace! once the input pipeline is fully verified — at ~240Hz
    // this will spam under any real drawing.
    log::debug!("[drawing] push_sample x={x:.1} y={y:.1} action={action}");
    send(Msg::Sample { x, y, action });
}

pub fn clear_strokes() {
    send(Msg::Clear);
}

/// Translate a pixel coordinate (origin top-left) into the egui
/// "point" space we tell the Context lives in. egui internally works
/// in points; ScreenDescriptor handles the points→pixels mapping for
/// the GPU side at tessellate / render time.
fn px_to_egui(x: f32, y: f32) -> egui::Pos2 {
    egui::Pos2::new(x / PIXELS_PER_POINT, y / PIXELS_PER_POINT)
}

/// Long-running render thread. Maintains an `Option<GpuState>` so a
/// SurfaceLost / SurfaceReady cycle can rebuild without a thread
/// restart, and keeps the accumulated `segments` vector alive across
/// frames so successive samples don't need to re-upload prior strokes.
fn render_thread(rx: mpsc::Receiver<Msg>) {
    let mut gpu: Option<GpuState> = None;
    // Flat list: pairs of vertices, each pair a line segment. See the
    // module header for why this beats per-stroke draw calls for the
    // POC's needs.
    let mut segments: Vec<Vertex> = Vec::new();
    // The most-recent sample's surface coordinates, used to anchor the
    // *next* MOVE sample's starting vertex. None between strokes.
    let mut last_point: Option<(f32, f32)> = None;
    // True while the in-progress gesture started inside the toolbar
    // region — we mirror the gesture to egui (so its button hover /
    // press states drive correctly) but skip the line pipeline.
    let mut stroke_suppressed = false;
    // Per-frame input batch handed to egui. Drained on each render
    // via std::mem::take so we don't double-process.
    let mut egui_input = egui::RawInput::default();

    loop {
        // Block until at least one message arrives, then drain any
        // backlog so a burst of high-frequency samples is rendered as
        // one frame rather than one frame per sample.
        let first = match rx.recv() {
            Ok(m) => m,
            Err(_) => return,
        };
        let mut messages = vec![first];
        loop {
            match rx.try_recv() {
                Ok(m) => messages.push(m),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return,
            }
        }

        let mut dirty = false;
        let mut needs_rebuild = false;
        for msg in messages {
            match msg {
                Msg::SurfaceReady {
                    native_window,
                    width,
                    height,
                } => {
                    // Drop any prior state first so the old surface
                    // and its ANativeWindow ref are released before we
                    // build the new one.
                    gpu = None;
                    match pollster::block_on(GpuState::new(native_window, width, height)) {
                        Ok(state) => {
                            gpu = Some(state);
                            needs_rebuild = true;
                        }
                        Err(e) => {
                            log::error!("[drawing] GpuState::new failed: {e:?}");
                        }
                    }
                }
                Msg::Resize { width, height } => {
                    if let Some(state) = gpu.as_mut() {
                        state.resize(width, height);
                        dirty = true;
                    }
                }
                Msg::SurfaceLost { reply } => {
                    // The lifecycle ordering — drop GpuState (which
                    // drops Surface, Device, Queue) BEFORE the JNI
                    // thread returns from surfaceDestroyed — is what
                    // keeps the EGL context alive long enough for
                    // wgpu's swap-chain teardown. The reply ack
                    // below is the synchronisation primitive that
                    // enforces it; wgpu's own Drop drains in-flight
                    // submissions, so no explicit poll is needed.
                    gpu = None;
                    if let Some(tx) = reply {
                        let _ = tx.send(());
                    }
                }
                Msg::Sample { x, y, action } => {
                    let pos = px_to_egui(x, y);
                    match action {
                        ACTION_DOWN => {
                            // egui needs a PointerMoved *before* the
                            // button press so hit-testing knows where
                            // the press happened. Mirror both whether
                            // or not the gesture ends up suppressed —
                            // suppressed gestures still drive egui
                            // (the toolbar buttons rely on this).
                            egui_input.events.push(egui::Event::PointerMoved(pos));
                            egui_input.events.push(egui::Event::PointerButton {
                                pos,
                                button: egui::PointerButton::Primary,
                                pressed: true,
                                modifiers: egui::Modifiers::NONE,
                            });
                            if y < TOOLBAR_TOTAL_PX {
                                stroke_suppressed = true;
                            } else {
                                stroke_suppressed = false;
                                last_point = Some((x, y));
                            }
                            dirty = true;
                        }
                        ACTION_MOVE => {
                            egui_input.events.push(egui::Event::PointerMoved(pos));
                            if !stroke_suppressed {
                                if let (Some((px, py)), Some(state)) =
                                    (last_point, gpu.as_ref())
                                {
                                    segments.push(Vertex {
                                        position: state.to_ndc(px, py),
                                    });
                                    segments.push(Vertex {
                                        position: state.to_ndc(x, y),
                                    });
                                    dirty = true;
                                }
                                last_point = Some((x, y));
                            }
                        }
                        ACTION_UP | ACTION_CANCEL => {
                            egui_input.events.push(egui::Event::PointerButton {
                                pos,
                                button: egui::PointerButton::Primary,
                                pressed: false,
                                modifiers: egui::Modifiers::NONE,
                            });
                            last_point = None;
                            stroke_suppressed = false;
                            dirty = true;
                        }
                        _ => {}
                    }
                }
                Msg::Clear => {
                    segments.clear();
                    last_point = None;
                    dirty = true;
                }
            }
        }

        if let Some(state) = gpu.as_mut() {
            if needs_rebuild || dirty {
                let input = std::mem::take(&mut egui_input);
                match state.render(&segments, input) {
                    Ok(actions) => {
                        if actions.clear {
                            segments.clear();
                            last_point = None;
                            // Re-render so the user sees the cleared
                            // canvas without waiting for the next
                            // input sample. Pass a fresh RawInput
                            // because we've already drained the
                            // batch above.
                            let _ = state.render(&segments, egui::RawInput::default());
                        }
                        if actions.back {
                            // Bounce to Kotlin → JS → Svelte to
                            // unmount the editor. The unmount path
                            // calls drawingHide which eventually
                            // hits SurfaceLost here.
                            if let Err(e) = crate::drawing::jni::ui::call_back() {
                                log::warn!("[drawing] call_back failed: {e}");
                            }
                        }
                    }
                    Err(e) => log::warn!("[drawing] render failed: {e:?}"),
                }
            }
        }
    }
}

struct GpuState {
    // Keep the window alive as long as the surface references it. Drop
    // order is field-declaration order in Rust — `surface` is declared
    // before `_window` so the wgpu surface is dropped first, then the
    // ANativeWindow_release in AndroidWindow::drop runs.
    surface: wgpu::Surface<'static>,
    _window: Box<AndroidWindow>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    pipeline: wgpu::RenderPipeline,
    /// Resized lazily when the segment count grows past it.
    vertex_buffer: Option<wgpu::Buffer>,
    vertex_capacity: u64,
    width: u32,
    height: u32,
    /// Immediate-mode UI context. Persists across frames; egui
    /// remembers hover / press state internally.
    egui_ctx: egui::Context,
    /// Tessellates egui shape output into wgpu draw calls. Tied to
    /// the device + surface format; recreated on SurfaceReady.
    egui_renderer: egui_wgpu::Renderer,
}

impl GpuState {
    async fn new(
        native_window: NonNull<ndk_sys::ANativeWindow>,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        // Box so the wgpu surface (which holds a raw pointer borrowed
        // from this struct) gets a stable address even if GpuState
        // itself moves.
        let window = Box::new(AndroidWindow {
            inner: native_window,
        });

        // Backend choice: GL only.
        //
        // The first device we tested this on (an emulator with Mesa's
        // host-passthrough Vulkan) crashed with a null-pointer deref
        // inside wgpu's Vulkan path the moment we hit it — Mesa's
        // logs show "Failed to open rendernode" and then wgpu
        // dereferences a handle Mesa returned without setting an
        // error. Forcing GLES sidesteps that entire stack and works
        // on emulator + real devices alike at a perf cost we don't
        // care about for thin POC lines.
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::GL,
            ..Default::default()
        });

        // SAFETY: `window` lives at a stable address inside `Self` and
        // is dropped after `surface` (field order). The raw handle's
        // ANativeWindow ref is owned by `window` and released on its
        // Drop, after the wgpu surface has been torn down.
        let surface = unsafe {
            instance
                .create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
                    raw_display_handle: window.display_handle().unwrap().as_raw(),
                    raw_window_handle: window.window_handle().unwrap().as_raw(),
                })
                .map_err(|e| format!("create_surface_unsafe: {e}"))?
        };

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
            })
            .await
            .map_err(|e| format!("request_adapter: {e:?}"))?;
        let info = adapter.get_info();
        log::info!(
            "[drawing] wgpu adapter: name={} backend={:?} type={:?} driver={}",
            info.name,
            info.backend,
            info.device_type,
            info.driver
        );

        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("drawing-device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::downlevel_defaults()
                    .using_resolution(adapter.limits()),
                memory_hints: wgpu::MemoryHints::default(),
                trace: wgpu::Trace::default(),
            })
            .await
            .map_err(|e| format!("request_device: {e:?}"))?;

        let caps = surface.get_capabilities(&adapter);
        // Prefer a non-sRGB format: egui_wgpu does its own colour
        // conversion in the shader and assumes a linear render
        // target. Picking an sRGB format makes egui's colours look
        // washed out. Fall back to whatever the surface offers if
        // nothing linear is available.
        let surface_format = caps
            .formats
            .iter()
            .copied()
            .find(|f| !f.is_srgb())
            .unwrap_or(caps.formats[0]);
        log::info!("[drawing] surface format: {surface_format:?}");
        let alpha_mode = caps
            .alpha_modes
            .iter()
            .copied()
            .find(|m| *m != wgpu::CompositeAlphaMode::Opaque)
            .unwrap_or(caps.alpha_modes[0]);

        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: surface_format,
            width: width.max(1),
            height: height.max(1),
            present_mode: caps.present_modes[0],
            alpha_mode,
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("drawing-shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("line.wgsl").into()),
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("drawing-pipeline-layout"),
            bind_group_layouts: &[],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("drawing-pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[Vertex::layout()],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::LineList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                polygon_mode: wgpu::PolygonMode::Fill,
                unclipped_depth: false,
                conservative: false,
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        let egui_ctx = egui::Context::default();
        egui_ctx.set_pixels_per_point(PIXELS_PER_POINT);
        // 5-arg constructor matches egui-wgpu 0.32 (tauri-plugin-egui
        // pattern): device, output color format, optional depth
        // format, msaa samples, dithering enabled.
        let egui_renderer = egui_wgpu::Renderer::new(&device, surface_format, None, 1, false);

        Ok(Self {
            surface,
            _window: window,
            device,
            queue,
            config,
            pipeline,
            vertex_buffer: None,
            vertex_capacity: 0,
            width,
            height,
            egui_ctx,
            egui_renderer,
        })
    }

    fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.width = width;
        self.height = height;
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(&self.device, &self.config);
    }

    /// Convert a pixel coordinate on the surface (origin top-left) to
    /// the wgpu NDC space (origin centre, Y up, [-1, 1]).
    fn to_ndc(&self, x: f32, y: f32) -> [f32; 2] {
        let w = self.width.max(1) as f32;
        let h = self.height.max(1) as f32;
        [(x / w) * 2.0 - 1.0, 1.0 - (y / h) * 2.0]
    }

    /// Run one frame: drive egui with the accumulated input, then
    /// emit two draw layers (strokes + egui toolbar) into a single
    /// render pass.
    fn render(
        &mut self,
        segments: &[Vertex],
        mut egui_input: egui::RawInput,
    ) -> Result<RenderActions, wgpu::SurfaceError> {
        // Tell egui the screen size every frame — egui doesn't track
        // it across frames itself, and the user can resize at any
        // point (rotation, IME show/hide).
        egui_input.screen_rect = Some(egui::Rect::from_min_size(
            egui::Pos2::ZERO,
            egui::Vec2::new(
                self.width as f32 / PIXELS_PER_POINT,
                self.height as f32 / PIXELS_PER_POINT,
            ),
        ));

        // Capture button clicks via mutable booleans the closure
        // writes; we can't return them directly because ctx.run is
        // FnMut and Rust closure lifetimes don't let us push out a
        // result that easily. The bools live on the outer stack
        // and outlive the closure call.
        let mut actions = RenderActions::default();
        // top inner-margin in points = status-bar inset in points. The
        // panel's BACKGROUND still paints from y=0 (under the status
        // bar text/icons; cosmetic, the system bar overlays it), but
        // the BUTTONS sit below the inset so they're tappable.
        let top_margin_pts = (STATUS_BAR_INSET_PX / PIXELS_PER_POINT).round() as i8;
        let panel_height_pts = TOOLBAR_TOTAL_PX / PIXELS_PER_POINT;
        let full_output = self.egui_ctx.run(egui_input, |ctx| {
            egui::TopBottomPanel::top("drawing-toolbar")
                .exact_height(panel_height_pts)
                .frame(
                    egui::Frame::default()
                        // Deliberately loud — once we confirm the
                        // toolbar is reaching the surface we'll tone
                        // it down to the audit-spec dark grey.
                        .fill(egui::Color32::from_rgb(180, 30, 30))
                        .inner_margin(egui::Margin {
                            left: 12,
                            right: 12,
                            top: top_margin_pts,
                            bottom: 8,
                        }),
                )
                .show(ctx, |ui| {
                    ui.horizontal(|ui| {
                        if ui.button("← Back").clicked() {
                            actions.back = true;
                        }
                        if ui.button("Clear").clicked() {
                            actions.clear = true;
                        }
                    });
                });
        });

        let paint_jobs = self
            .egui_ctx
            .tessellate(full_output.shapes, PIXELS_PER_POINT);
        log::info!(
            "[drawing] egui frame: paint_jobs={} tex_set={} tex_free={}",
            paint_jobs.len(),
            full_output.textures_delta.set.len(),
            full_output.textures_delta.free.len(),
        );

        // Push texture updates before any rendering — egui ships
        // its font atlas this way. Free on the same frame is OK
        // because the GPU work hasn't been submitted yet.
        for (id, image_delta) in &full_output.textures_delta.set {
            self.egui_renderer
                .update_texture(&self.device, &self.queue, *id, image_delta);
        }
        for id in &full_output.textures_delta.free {
            self.egui_renderer.free_texture(id);
        }

        // Stroke vertex buffer — grow geometrically so reallocs stay
        // amortised even when the user keeps drawing without lifting.
        let needed = (segments.len() as u64) * std::mem::size_of::<Vertex>() as u64;
        if needed > self.vertex_capacity {
            let new_capacity = needed.max(self.vertex_capacity * 3 / 2).max(1024);
            self.vertex_buffer = Some(self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("drawing-vbuf"),
                size: new_capacity,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }));
            self.vertex_capacity = new_capacity;
        }
        if !segments.is_empty() {
            self.queue.write_buffer(
                self.vertex_buffer.as_ref().unwrap(),
                0,
                bytemuck::cast_slice(segments),
            );
        }

        let frame = match self.surface.get_current_texture() {
            Ok(f) => f,
            Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                self.surface.configure(&self.device, &self.config);
                self.surface.get_current_texture()?
            }
            Err(e) => return Err(e),
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("drawing-encoder"),
            });

        let screen_descriptor = egui_wgpu::ScreenDescriptor {
            size_in_pixels: [self.width.max(1), self.height.max(1)],
            pixels_per_point: PIXELS_PER_POINT,
        };
        // update_buffers writes into the encoder *before* the render
        // pass begins, so the data is live by the time egui's render
        // call samples it.
        self.egui_renderer.update_buffers(
            &self.device,
            &self.queue,
            &mut encoder,
            &paint_jobs,
            &screen_descriptor,
        );

        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("drawing-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::WHITE),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            // Strokes underneath the toolbar — egui paints its panel
            // background on top, so any stroke vertices that happen
            // to fall inside the toolbar region are covered visually.
            if let Some(vbuf) = self.vertex_buffer.as_ref() {
                if !segments.is_empty() {
                    pass.set_pipeline(&self.pipeline);
                    pass.set_vertex_buffer(0, vbuf.slice(..));
                    pass.draw(0..segments.len() as u32, 0..1);
                }
            }

            // egui's render expects a 'static-lifetime RenderPass;
            // forget_lifetime is the documented escape hatch (same
            // pattern tauri-plugin-egui uses). The original `pass`
            // binding is shadowed by the consumed self — the new
            // static-lifetime pass drops at the end of this block.
            self.egui_renderer.render(
                &mut pass.forget_lifetime(),
                &paint_jobs,
                &screen_descriptor,
            );
        }
        self.queue.submit(std::iter::once(encoder.finish()));
        frame.present();

        // Drop egui's per-frame closures + commands ourselves to
        // avoid carrying them across frames in `full_output`.
        let _ = full_output.platform_output;
        let _ = full_output.viewport_output;

        Ok(actions)
    }
}
