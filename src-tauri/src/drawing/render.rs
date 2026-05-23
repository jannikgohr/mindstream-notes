//! wgpu line-rendering pipeline for the POC.
//!
//! Architecture (per `mod.rs` header):
//!
//!   ┌── JNI thread (Kotlin → Rust) ──┐
//!   │  setSurface / clearSurface /   │
//!   │  pushPoint                     │
//!   │           ▼                    │
//!   │     mpsc::Sender ──────────────┼──► render thread
//!   └────────────────────────────────┘    (owns wgpu state)
//!
//! All wgpu state lives on the render thread. JNI callers only push
//! `Msg`s onto a sender stored in a global Mutex. The render thread is
//! spawned the first time `set_surface` runs and torn down when the
//! surface is dropped — for the POC we don't try to preserve strokes
//! across an app backgrounding cycle.
//!
//! Geometry: one flat vertex buffer in `PrimitiveTopology::LineList`.
//! Each `MotionEvent.ACTION_MOVE` emits two vertices (prev, current).
//! `ACTION_DOWN` just records the starting point; `ACTION_UP` /
//! `ACTION_CANCEL` clear it. This keeps the entire scene as one draw
//! call regardless of stroke count and avoids per-stroke buffer
//! bookkeeping. Lines are 1-pixel — Vulkan's portable guarantee. Wider
//! / pressure-tapered strokes wait for the lyon pass in a follow-up.

use std::ptr::NonNull;
use std::sync::mpsc::{self, Sender, TryRecvError};
use std::sync::{Mutex, OnceLock};
use std::thread;

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
    SurfaceLost,
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
            .spawn(move || render_thread(rx))
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

pub fn clear_surface() {
    send(Msg::SurfaceLost);
}

pub fn push_sample(x: f32, y: f32, action: i32) {
    send(Msg::Sample { x, y, action });
}

pub fn clear_strokes() {
    send(Msg::Clear);
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
                Msg::SurfaceLost => {
                    gpu = None;
                }
                Msg::Sample { x, y, action } => {
                    match action {
                        ACTION_DOWN => {
                            last_point = Some((x, y));
                        }
                        ACTION_MOVE => {
                            if let (Some((px, py)), Some(state)) = (last_point, gpu.as_ref()) {
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
                        ACTION_UP | ACTION_CANCEL => {
                            last_point = None;
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
                if let Err(e) = state.render(&segments) {
                    log::warn!("[drawing] render failed: {e:?}");
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

        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::VULKAN | wgpu::Backends::GL,
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
        // Pick any sRGB-or-not format the surface offers; egui isn't
        // in the loop yet so we don't need the non-sRGB constraint
        // tauri-plugin-egui applies.
        let surface_format = caps.formats[0];
        // Prefer a non-opaque composite mode so the WebView shows
        // through where we haven't drawn. Falls back to whatever the
        // device gives us if nothing transparent is offered.
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
        [
            (x / w) * 2.0 - 1.0,
            1.0 - (y / h) * 2.0,
        ]
    }

    fn render(&mut self, segments: &[Vertex]) -> Result<(), wgpu::SurfaceError> {
        // Make sure the vertex buffer is big enough. Geometric growth
        // (1.5×) keeps reallocs amortised even as the user keeps
        // drawing without lifting the pen.
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
            // The unwrap is sound: the `needed > capacity` branch above
            // guarantees `vertex_buffer` is `Some` whenever we have any
            // segments to draw. With zero segments we skip the write
            // entirely and just clear the surface below.
            self.queue
                .write_buffer(self.vertex_buffer.as_ref().unwrap(), 0, bytemuck::cast_slice(segments));
        }

        let frame = match self.surface.get_current_texture() {
            Ok(f) => f,
            Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                // Reconfigure and try once more — Android backgrounds
                // the app and the surface comes back stale.
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
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("drawing-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            if let Some(vbuf) = self.vertex_buffer.as_ref() {
                if !segments.is_empty() {
                    pass.set_pipeline(&self.pipeline);
                    pass.set_vertex_buffer(0, vbuf.slice(..));
                    pass.draw(0..segments.len() as u32, 0..1);
                }
            }
        }
        self.queue.submit(std::iter::once(encoder.finish()));
        frame.present();
        Ok(())
    }
}

