//! wgpu line-rendering pipeline + egui toolbar for the POC.
//!
//! Architecture (per `mod.rs` header):
//!
//!   ┌── JNI thread (Kotlin → Rust) ──┐
//!   │  setSurface / clearSurface /   │
//!   │  pushPoint / setInsets         │
//!   │           ▼                    │
//!   │     mpsc::Sender ──────────────┼──► render thread
//!   └────────────────────────────────┘    (owns wgpu + egui state)
//!
//! State is split in two:
//!
//!   * `PersistentGpu` — wgpu instance / adapter / device / queue,
//!     the line pipeline, and the egui Context + Renderer. Built
//!     once on first surface attach, **kept alive for the process
//!     lifetime**. Its Drop only ever runs at process exit, where
//!     it doesn't matter.
//!
//!   * `SurfaceBoundState` — the wgpu `Surface`, the owning
//!     `AndroidWindow`, the surface `Configuration`, and the
//!     dynamic stroke vertex buffer. Rebuilt every time Android
//!     gives us a new `SurfaceView` (note open / rotate / back
//!     from background) and dropped on every `surfaceDestroyed`.
//!
//! Why split? When `Device` / `Queue` Drop runs on Android's shared
//! EGL display, it tears down driver mutex state that HWUI's
//! `RenderThread` is still using during the activity's own
//! `destroyHardwareResources` step a few hundred ms later. HWUI
//! then tries to lock a now-destroyed mutex and the process aborts
//! with FORTIFY. Keeping `Device` etc. alive means our Drop never
//! fires while HWUI is still up. We only ever drop the cheap
//! `Surface` (eglDestroySurface) — that doesn't touch shared
//! display state.
//!
//! Two rendering layers in one render pass:
//!   1. Black ink as PrimitiveTopology::LineList. Each ACTION_MOVE
//!      sample emits two vertices (prev, current).
//!   2. An egui top-bar drawn through egui_wgpu::Renderer with the
//!      back + clear buttons.
//!
//! Button clicks bubble out of `render_frame()` as `RenderActions`;
//! the render thread responds by either clearing the segment buffer
//! (Clear) or calling back into Kotlin via JNI to dispatch a window
//! event the Svelte side listens for (Back).

use std::ptr::NonNull;
use std::sync::atomic::{AtomicU32, Ordering};
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

/// Initial fallback for the top safe-area inset, in pixels. Used
/// before the first `setInsets` JNI call arrives from Kotlin's
/// `OnApplyWindowInsetsListener`.
const FALLBACK_TOP_INSET_PX: u32 = 144;

/// Dynamic top safe-area inset in pixels, updated by Kotlin via
/// `setInsets`. Read each frame by both the toolbar layout and the
/// touch-routing region check.
static TOP_INSET_PX: AtomicU32 = AtomicU32::new(FALLBACK_TOP_INSET_PX);

fn top_inset_px() -> f32 {
    TOP_INSET_PX.load(Ordering::Relaxed) as f32
}

/// Visible portion of the toolbar — what's actually tap-target sized
/// below the status bar inset. Total panel painted = inset + this.
const TOOLBAR_HEIGHT_PX: f32 = 120.0;

/// Combined "egui owns this gesture, don't start a stroke" region.
fn toolbar_total_px() -> f32 {
    top_inset_px() + TOOLBAR_HEIGHT_PX
}

/// Fixed scale factor we tell egui. We could query
/// `DisplayMetrics.density` from Kotlin and plumb it through, but
/// 2.5 is close enough to the typical phone density that egui's
/// default font sizes render at usable point sizes.
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

/// What the egui UI decided this frame. Bubbled out of `render_frame()`
/// so the render thread can react (clear segments / call back into
/// Kotlin) outside of the immediate-mode closure.
#[derive(Default, Debug, Clone, Copy)]
struct RenderActions {
    back: bool,
    clear: bool,
}

/// Messages the render thread accepts.
enum Msg {
    SurfaceReady {
        native_window: NonNull<ndk_sys::ANativeWindow>,
        width: u32,
        height: u32,
    },
    Resize {
        width: u32,
        height: u32,
    },
    /// `surfaceDestroyed` fired. The optional reply slot is what makes
    /// `clear_surface()` block until the render thread acks that the
    /// `SurfaceBoundState` has been dropped — see clear_surface for
    /// the lifecycle-ordering rationale. After this fix, the drop is
    /// just `eglDestroySurface` + `ANativeWindow_release`; the heavy
    /// wgpu state stays alive in `PersistentGpu`.
    SurfaceLost {
        reply: Option<SyncSender<()>>,
    },
    Sample {
        x: f32,
        y: f32,
        action: i32,
    },
    Clear,
    InsetChanged,
}

unsafe impl Send for Msg {}

/// Owns an `ANativeWindow*` and implements the raw-handle traits wgpu
/// needs to build a Surface. Drop releases the window reference.
struct AndroidWindow {
    inner: NonNull<ndk_sys::ANativeWindow>,
}

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
        // which acquires a reference; releasing exactly once balances
        // that acquire.
        unsafe { ndk_sys::ANativeWindow_release(self.inner.as_ptr()) };
    }
}

// ---------- channel plumbing ----------

static SENDER: OnceLock<Mutex<Option<Sender<Msg>>>> = OnceLock::new();

fn sender_slot() -> &'static Mutex<Option<Sender<Msg>>> {
    SENDER.get_or_init(|| Mutex::new(None))
}

fn send(msg: Msg) {
    if let Ok(slot) = sender_slot().lock() {
        if let Some(tx) = slot.as_ref() {
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
/// Android invalidates the ANativeWindow under wgpu's feet.
///
/// After the persistent-split refactor, "drop the surface" is much
/// cheaper than it used to be: only `Surface` + `AndroidWindow` go
/// away. The Device/Queue/pipeline/egui_renderer stay alive in
/// `PersistentGpu` for the next attach.
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
    log::debug!("[drawing] push_sample x={x:.1} y={y:.1} action={action}");
    send(Msg::Sample { x, y, action });
}

pub fn clear_strokes() {
    send(Msg::Clear);
}

/// Update the top safe-area inset and request a re-render. Called
/// from the JNI `setInsets` export, which Kotlin triggers via the
/// SurfaceView's `OnApplyWindowInsetsListener`.
pub fn set_top_inset(top_px: u32) {
    let old = TOP_INSET_PX.swap(top_px, Ordering::Relaxed);
    if old != top_px {
        log::info!("[drawing] top inset updated: {old} -> {top_px}");
        send(Msg::InsetChanged);
    }
}

/// Translate a pixel coordinate (origin top-left) into the egui
/// "point" space we tell the Context lives in.
fn px_to_egui(x: f32, y: f32) -> egui::Pos2 {
    egui::Pos2::new(x / PIXELS_PER_POINT, y / PIXELS_PER_POINT)
}

// ---------- GPU state ----------

/// Long-lived wgpu + egui state. Built once on the first
/// `SurfaceReady`, kept alive for the rest of the process. Never
/// dropped while the app is running — this is what dodges the
/// EGL / HWUI mutex teardown crash documented in the module header.
struct PersistentGpu {
    instance: wgpu::Instance,
    adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,
    /// Picked once based on the first surface's caps and pinned
    /// thereafter. egui_renderer is compiled against this format so
    /// changing it later would require rebuilding the renderer; the
    /// underlying display doesn't change so this is fine.
    surface_format: wgpu::TextureFormat,
    pipeline: wgpu::RenderPipeline,
    egui_ctx: egui::Context,
    egui_renderer: egui_wgpu::Renderer,
}

/// Per-surface state. Rebuilt each `SurfaceReady`, dropped each
/// `SurfaceLost`. Holds nothing that touches shared driver state on
/// Drop beyond `eglDestroySurface` + `ANativeWindow_release`.
struct SurfaceBoundState {
    // Drop order is field-declaration order in Rust — `surface` is
    // declared before `_window` so the wgpu surface is dropped first,
    // then the ANativeWindow_release in AndroidWindow::drop runs.
    surface: wgpu::Surface<'static>,
    _window: Box<AndroidWindow>,
    config: wgpu::SurfaceConfiguration,
    vertex_buffer: Option<wgpu::Buffer>,
    vertex_capacity: u64,
    width: u32,
    height: u32,
}

impl SurfaceBoundState {
    fn resize(&mut self, persistent: &PersistentGpu, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.width = width;
        self.height = height;
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(&persistent.device, &self.config);
    }

    /// Convert a pixel coordinate on the surface to wgpu NDC space
    /// (origin centre, Y up, [-1, 1]).
    fn to_ndc(&self, x: f32, y: f32) -> [f32; 2] {
        let w = self.width.max(1) as f32;
        let h = self.height.max(1) as f32;
        [(x / w) * 2.0 - 1.0, 1.0 - (y / h) * 2.0]
    }
}

/// First-time init: builds both halves at once. Subsequent surface
/// attaches go through `build_surface_only` which reuses persistent.
async fn build_first_time(
    native_window: NonNull<ndk_sys::ANativeWindow>,
    width: u32,
    height: u32,
) -> Result<(PersistentGpu, SurfaceBoundState), String> {
    let window = Box::new(AndroidWindow {
        inner: native_window,
    });

    // GL only — Mesa Vulkan on the emulator returns null handles
    // that wgpu's Vulkan path then deref-crashes; GLES works
    // everywhere we've tested.
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::GL,
        ..Default::default()
    });

    // SAFETY: `window` lives at a stable address (boxed) and is
    // owned by the returned SurfaceBoundState. The raw handle's
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
            required_limits: wgpu::Limits::downlevel_defaults().using_resolution(adapter.limits()),
            memory_hints: wgpu::MemoryHints::default(),
            trace: wgpu::Trace::default(),
        })
        .await
        .map_err(|e| format!("request_device: {e:?}"))?;

    let caps = surface.get_capabilities(&adapter);
    // egui_wgpu does its own colour conversion in the shader and
    // assumes a linear render target — sRGB formats produce washed
    // out colours.
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
    let egui_renderer = egui_wgpu::Renderer::new(&device, surface_format, None, 1, false);

    let persistent = PersistentGpu {
        instance,
        adapter,
        device,
        queue,
        surface_format,
        pipeline,
        egui_ctx,
        egui_renderer,
    };
    let surface_state = SurfaceBoundState {
        surface,
        _window: window,
        config,
        vertex_buffer: None,
        vertex_capacity: 0,
        width,
        height,
    };
    Ok((persistent, surface_state))
}

/// Subsequent attaches: reuse the existing persistent state. Just
/// build a new `Surface` against the new ANativeWindow and configure
/// it with the pinned format / cached caps.
async fn build_surface_only(
    persistent: &PersistentGpu,
    native_window: NonNull<ndk_sys::ANativeWindow>,
    width: u32,
    height: u32,
) -> Result<SurfaceBoundState, String> {
    let window = Box::new(AndroidWindow {
        inner: native_window,
    });

    // SAFETY: as in build_first_time — `window` is boxed for stable
    // address and owned by the returned SurfaceBoundState.
    let surface = unsafe {
        persistent
            .instance
            .create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
                raw_display_handle: window.display_handle().unwrap().as_raw(),
                raw_window_handle: window.window_handle().unwrap().as_raw(),
            })
            .map_err(|e| format!("create_surface_unsafe: {e}"))?
    };

    let caps = surface.get_capabilities(&persistent.adapter);
    let alpha_mode = caps
        .alpha_modes
        .iter()
        .copied()
        .find(|m| *m != wgpu::CompositeAlphaMode::Opaque)
        .unwrap_or(caps.alpha_modes[0]);
    let config = wgpu::SurfaceConfiguration {
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        format: persistent.surface_format,
        width: width.max(1),
        height: height.max(1),
        present_mode: caps.present_modes[0],
        alpha_mode,
        view_formats: vec![],
        desired_maximum_frame_latency: 2,
    };
    surface.configure(&persistent.device, &config);

    Ok(SurfaceBoundState {
        surface,
        _window: window,
        config,
        vertex_buffer: None,
        vertex_capacity: 0,
        width,
        height,
    })
}

/// Run one frame: drive egui with the accumulated input, then emit
/// two draw layers (strokes + egui toolbar) into a single render
/// pass.
fn render_frame(
    persistent: &mut PersistentGpu,
    surface_state: &mut SurfaceBoundState,
    segments: &[Vertex],
    mut egui_input: egui::RawInput,
) -> Result<RenderActions, wgpu::SurfaceError> {
    egui_input.screen_rect = Some(egui::Rect::from_min_size(
        egui::Pos2::ZERO,
        egui::Vec2::new(
            surface_state.width as f32 / PIXELS_PER_POINT,
            surface_state.height as f32 / PIXELS_PER_POINT,
        ),
    ));

    let mut actions = RenderActions::default();
    let top_inset = top_inset_px();
    let top_margin_pts = (top_inset / PIXELS_PER_POINT).round().clamp(0.0, 127.0) as i8;
    let panel_height_pts = (top_inset + TOOLBAR_HEIGHT_PX) / PIXELS_PER_POINT;
    let full_output = persistent.egui_ctx.run(egui_input, |ctx| {
        egui::TopBottomPanel::top("drawing-toolbar")
            .exact_height(panel_height_pts)
            .frame(
                egui::Frame::default()
                    .fill(egui::Color32::from_rgb(32, 32, 36))
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

    let paint_jobs = persistent
        .egui_ctx
        .tessellate(full_output.shapes, PIXELS_PER_POINT);

    for (id, image_delta) in &full_output.textures_delta.set {
        persistent
            .egui_renderer
            .update_texture(&persistent.device, &persistent.queue, *id, image_delta);
    }
    for id in &full_output.textures_delta.free {
        persistent.egui_renderer.free_texture(id);
    }

    // Stroke vertex buffer — grow geometrically.
    let needed = (segments.len() as u64) * std::mem::size_of::<Vertex>() as u64;
    if needed > surface_state.vertex_capacity {
        let new_capacity = needed.max(surface_state.vertex_capacity * 3 / 2).max(1024);
        surface_state.vertex_buffer = Some(persistent.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("drawing-vbuf"),
            size: new_capacity,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        }));
        surface_state.vertex_capacity = new_capacity;
    }
    if !segments.is_empty() {
        persistent.queue.write_buffer(
            surface_state.vertex_buffer.as_ref().unwrap(),
            0,
            bytemuck::cast_slice(segments),
        );
    }

    let frame = match surface_state.surface.get_current_texture() {
        Ok(f) => f,
        Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
            surface_state
                .surface
                .configure(&persistent.device, &surface_state.config);
            surface_state.surface.get_current_texture()?
        }
        Err(e) => return Err(e),
    };
    let view = frame
        .texture
        .create_view(&wgpu::TextureViewDescriptor::default());

    let mut encoder = persistent
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("drawing-encoder"),
        });

    let screen_descriptor = egui_wgpu::ScreenDescriptor {
        size_in_pixels: [surface_state.width.max(1), surface_state.height.max(1)],
        pixels_per_point: PIXELS_PER_POINT,
    };
    persistent.egui_renderer.update_buffers(
        &persistent.device,
        &persistent.queue,
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

        if let Some(vbuf) = surface_state.vertex_buffer.as_ref() {
            if !segments.is_empty() {
                pass.set_pipeline(&persistent.pipeline);
                pass.set_vertex_buffer(0, vbuf.slice(..));
                pass.draw(0..segments.len() as u32, 0..1);
            }
        }

        persistent.egui_renderer.render(
            &mut pass.forget_lifetime(),
            &paint_jobs,
            &screen_descriptor,
        );
    }
    persistent.queue.submit(std::iter::once(encoder.finish()));
    frame.present();

    let _ = full_output.platform_output;
    let _ = full_output.viewport_output;

    Ok(actions)
}

// ---------- render thread ----------

fn render_thread(rx: mpsc::Receiver<Msg>) {
    let mut persistent: Option<PersistentGpu> = None;
    let mut surface_state: Option<SurfaceBoundState> = None;
    let mut segments: Vec<Vertex> = Vec::new();
    let mut last_point: Option<(f32, f32)> = None;
    let mut stroke_suppressed = false;
    let mut egui_input = egui::RawInput::default();

    loop {
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
                    // Drop any prior surface state first — must run
                    // before we build a new one so the old
                    // ANativeWindow_release happens before we ack
                    // any in-flight clear_surface call.
                    surface_state = None;

                    if persistent.is_none() {
                        // First attach ever: build both halves.
                        match pollster::block_on(build_first_time(native_window, width, height)) {
                            Ok((p, s)) => {
                                persistent = Some(p);
                                surface_state = Some(s);
                                needs_rebuild = true;
                            }
                            Err(e) => log::error!("[drawing] build_first_time failed: {e:?}"),
                        }
                    } else {
                        // Reattach: reuse persistent, build only a
                        // new Surface against the new ANativeWindow.
                        let p = persistent.as_ref().unwrap();
                        match pollster::block_on(build_surface_only(p, native_window, width, height))
                        {
                            Ok(s) => {
                                surface_state = Some(s);
                                needs_rebuild = true;
                            }
                            Err(e) => log::error!("[drawing] build_surface_only failed: {e:?}"),
                        }
                    }
                }
                Msg::Resize { width, height } => {
                    if let (Some(p), Some(s)) = (persistent.as_ref(), surface_state.as_mut()) {
                        s.resize(p, width, height);
                        dirty = true;
                    }
                }
                Msg::SurfaceLost { reply } => {
                    // Drop ONLY the surface state. Persistent
                    // (device/queue/pipeline/egui_renderer) stays
                    // alive — its Drop is what conflicts with
                    // HWUI's EGL teardown on the activity finish
                    // path, so we never run it mid-app.
                    surface_state = None;
                    if let Some(tx) = reply {
                        let _ = tx.send(());
                    }
                }
                Msg::Sample { x, y, action } => {
                    let pos = px_to_egui(x, y);
                    match action {
                        ACTION_DOWN => {
                            egui_input.events.push(egui::Event::PointerMoved(pos));
                            egui_input.events.push(egui::Event::PointerButton {
                                pos,
                                button: egui::PointerButton::Primary,
                                pressed: true,
                                modifiers: egui::Modifiers::NONE,
                            });
                            if y < toolbar_total_px() {
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
                                if let (Some((px, py)), Some(s)) =
                                    (last_point, surface_state.as_ref())
                                {
                                    segments.push(Vertex {
                                        position: s.to_ndc(px, py),
                                    });
                                    segments.push(Vertex {
                                        position: s.to_ndc(x, y),
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
                Msg::InsetChanged => {
                    dirty = true;
                }
            }
        }

        if let (Some(p), Some(s)) = (persistent.as_mut(), surface_state.as_mut()) {
            if needs_rebuild || dirty {
                let input = std::mem::take(&mut egui_input);
                match render_frame(p, s, &segments, input) {
                    Ok(actions) => {
                        if actions.clear {
                            segments.clear();
                            last_point = None;
                            // Re-render so the user sees the cleared
                            // canvas immediately.
                            let _ = render_frame(p, s, &segments, egui::RawInput::default());
                        }
                        if actions.back {
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
