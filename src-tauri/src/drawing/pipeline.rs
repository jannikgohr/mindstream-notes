//! wgpu pipeline + per-frame GPU work.
//!
//! Split into two structs:
//!
//!   * `PersistentGpu` — wgpu instance / adapter / device / queue,
//!     the line pipeline, and the egui-side wgpu renderer. Built
//!     once on the first surface attach and **kept alive for the
//!     process lifetime** — its Drop only runs at process exit,
//!     where it doesn't conflict with HWUI's EGL teardown (this is
//!     the fix for the FORTIFY pthread_mutex-on-destroyed-mutex
//!     crash on Activity finish).
//!
//!   * `SurfaceBoundState` — the wgpu `Surface`, the owning
//!     `AndroidWindow`, the surface `Configuration`, and the dynamic
//!     stroke vertex buffer. Rebuilt every time Android gives us a
//!     new `SurfaceView` (note open / rotate / back-from-background)
//!     and dropped on every `surfaceDestroyed`.
//!
//! `render_frame` is the per-frame GPU work: takes the UI output
//! (already-tessellated paint jobs + texture deltas, produced by
//! `crate::drawing::ui::CanvasUi`), encodes a single render pass
//! that draws strokes underneath + egui on top, submits, presents.

use bytemuck::{Pod, Zeroable};
// HasWindowHandle + HasDisplayHandle are supertraits of
// SurfaceSource. Imported here so the `window.window_handle()` /
// `.display_handle()` method calls on `Box<dyn SurfaceSource>`
// resolve (trait methods need the trait in scope at the call site,
// even when dispatched dynamically).
use raw_window_handle::{HasDisplayHandle, HasWindowHandle};

use super::page::{self, PageSize, ViewTransform};
use super::surface_source::SurfaceSource;
use super::ui::UiOutput;

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
pub struct Vertex {
    pub position: [f32; 2],
    /// Per-vertex RGBA bytes — interpreted as Unorm8x4, so the
    /// vertex shader sees `vec4<f32>` with components `byte / 255`
    /// (linear, no sRGB gamma). 4 bytes vs the 16 of `[f32; 4]`
    /// saves ~3 MB of GPU memory + per-frame upload on a busy ink
    /// note (~180k vertices for ~30k segments). Same flexibility
    /// for D5's gradient brushes — still per-vertex, just at
    /// 256-step quantisation, which is what every consumer ink
    /// editor ships.
    ///
    /// Byte layout in memory MUST be `[R, G, B, A]` for the
    /// `Unorm8x4` HW unpack to produce a shader-side vec4 in
    /// `(r, g, b, a)` order. See `render::pack_color_bytes` for
    /// the packed-u32 → bytes mapping.
    pub color: [u8; 4],
}

impl Vertex {
    const ATTRIBS: [wgpu::VertexAttribute; 2] =
        wgpu::vertex_attr_array![0 => Float32x2, 1 => Unorm8x4];

    fn layout() -> wgpu::VertexBufferLayout<'static> {
        wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<Self>() as wgpu::BufferAddress,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &Self::ATTRIBS,
        }
    }
}

/// Long-lived wgpu + egui state. See module header for why this
/// stays alive across surface destroys.
pub struct PersistentGpu {
    instance: wgpu::Instance,
    adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,
    /// Picked once based on the first surface's caps and pinned
    /// thereafter — `egui_renderer` is compiled against this format,
    /// changing it later would require rebuilding the renderer.
    surface_format: wgpu::TextureFormat,
    /// Bind group layout for the view uniform (group 0 of the line
    /// pipeline). Owned here because the pipeline references it; the
    /// matching bind group lives in SurfaceBoundState (it points at
    /// the per-surface uniform buffer).
    view_bind_group_layout: wgpu::BindGroupLayout,
    pipeline: wgpu::RenderPipeline,
    egui_renderer: egui_wgpu::Renderer,
}

/// Per-surface state. Rebuilt each `SurfaceReady`, dropped each
/// `SurfaceLost`. Holds nothing that touches shared driver state on
/// Drop beyond `eglDestroySurface` + the platform-specific window
/// release (on Android, that's `ANativeWindow_release`).
pub struct SurfaceBoundState {
    // Drop order is field-declaration order in Rust — `surface` is
    // declared before `_window` so the wgpu surface is dropped first,
    // then the `SurfaceSource`'s `Drop` runs (e.g. on Android,
    // `AndroidWindow::drop → ANativeWindow_release`).
    surface: wgpu::Surface<'static>,
    _window: Box<dyn SurfaceSource>,
    config: wgpu::SurfaceConfiguration,
    vertex_buffer: Option<wgpu::Buffer>,
    vertex_capacity: u64,
    /// Number of *committed* vertices currently uploaded to the GPU
    /// vertex buffer. Drives `render_frame`'s partial-upload
    /// decision: if the new committed slice is append-only relative
    /// to this count (pen-drawing's hot path), upload just the new
    /// tail at the right byte offset instead of rewriting the whole
    /// buffer. Reset to 0 on buffer (re)allocation so the next
    /// render uploads from offset 0.
    ///
    /// Only tracks the *committed* prefix — D2 prediction segments
    /// (which always change each frame) get full-rewritten at the
    /// offset right after the committed tail every frame and do
    /// not participate in this watermark.
    last_uploaded_committed_count: u64,
    width: u32,
    height: u32,
    /// Page-coord ↔ surface-pixel mapping. Recomputed on every
    /// resize so rotations re-fit the page. Pan/zoom (D6) will
    /// stop deriving this from surface size and start mutating it
    /// directly from gesture events.
    view_transform: ViewTransform,
    /// GPU mirror of `view_transform`. Re-uploaded whenever
    /// `view_transform` changes.
    view_uniform_buffer: wgpu::Buffer,
    /// Binds `view_uniform_buffer` to group 0 of the line pipeline.
    view_bind_group: wgpu::BindGroup,
    /// Page size used for the current surface (per the page module's
    /// default). C1 makes this per-note.
    page: PageSize,
}

impl SurfaceBoundState {
    pub fn resize(&mut self, persistent: &PersistentGpu, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.width = width;
        self.height = height;
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(&persistent.device, &self.config);
        // Re-fit the page to the new surface size and push the
        // updated uniform to the GPU so the next render uses the
        // correct mapping.
        self.view_transform = ViewTransform::fit_in_surface(self.page, width as f32, height as f32);
        persistent.queue.write_buffer(
            &self.view_uniform_buffer,
            0,
            bytemuck::bytes_of(&self.view_transform.as_uniform()),
        );
    }

    /// Convert a surface-pixel touch coordinate into the page
    /// coordinate value we store in the vertex buffer. Inverse of
    /// the GPU transform applied in the line shader.
    pub fn surface_to_page(&self, x: f32, y: f32) -> [f32; 2] {
        self.view_transform.surface_to_page(x, y)
    }

    pub fn size_px(&self) -> (u32, u32) {
        (self.width, self.height)
    }
}

/// Hardcoded surface format for prewarmed `PersistentGpu`. Android
/// GL adapters (Adreno, Mali, …) consistently expose `Rgba8Unorm`
/// as their primary non-sRGB format, so picking it ahead of having
/// a Surface to query is safe in practice. `build_surface_bound`
/// double-checks the actual surface caps and warns (rather than
/// silently miscolouring) if a device ever turns up that doesn't
/// support it.
///
/// Why hardcode at all: `egui_wgpu::Renderer::new` + the line
/// pipeline both bake the surface format into compiled state — if
/// we deferred picking until the first Surface attach, those two
/// (≈45 ms combined) would stay on the critical path, defeating
/// half the prewarm benefit.
const PREWARM_SURFACE_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// Build the surface-independent half of `PersistentGpu` —
/// everything we can construct without an `ANativeWindow` /
/// `SurfaceSource`. Called from `drawing::render::prewarm()` at
/// app startup so by the time the user opens an ink note the
/// 150–200 ms of adapter / device / pipeline / egui-renderer
/// negotiation has already happened in the background.
///
/// The lazy fallback in the render-thread `Msg::SurfaceReady`
/// handler calls this if prewarm didn't run (or hasn't completed)
/// before the first surface arrives — worst case = today's
/// "blocking init on first open" behaviour.
pub async fn build_persistent() -> Result<PersistentGpu, String> {
    let t_total = std::time::Instant::now();

    let t_phase = std::time::Instant::now();
    // GL only — Mesa Vulkan on the emulator returns null handles
    // that wgpu's Vulkan path then deref-crashes; GLES works
    // everywhere we've tested.
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::GL,
        ..Default::default()
    });
    let t_instance = t_phase.elapsed();

    let t_phase = std::time::Instant::now();
    // `compatible_surface: None` — we don't have one yet. On
    // Android there's typically one GL adapter and it'll match
    // any GL surface we later build, so this is safe. If we ever
    // ship a multi-adapter platform via this path we'd need to
    // revisit (and probably re-pick at SurfaceReady time).
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: None,
            force_fallback_adapter: false,
        })
        .await
        .map_err(|e| format!("request_adapter: {e:?}"))?;
    let t_adapter = t_phase.elapsed();
    let info = adapter.get_info();
    log::info!(
        "[drawing] wgpu adapter: name={} backend={:?} type={:?} driver={}",
        info.name,
        info.backend,
        info.device_type,
        info.driver
    );

    let t_phase = std::time::Instant::now();
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
    let t_device = t_phase.elapsed();

    let surface_format = PREWARM_SURFACE_FORMAT;
    log::info!("[drawing] surface format (prewarm assumed): {surface_format:?}");

    let t_phase = std::time::Instant::now();
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("drawing-shader"),
        source: wgpu::ShaderSource::Wgsl(include_str!("line.wgsl").into()),
    });
    let t_shader = t_phase.elapsed();

    let t_phase = std::time::Instant::now();
    let view_bind_group_layout = create_view_bind_group_layout(&device);
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("drawing-pipeline-layout"),
        bind_group_layouts: &[&view_bind_group_layout],
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
            // TriangleList — the render thread expands each pen
            // segment into a 6-vertex quad (2 triangles) on the CPU
            // so width can vary per endpoint with pressure. Front
            // face / cull-mode are irrelevant because we don't cull
            // (a stroke quad's winding flips with stroke direction).
            topology: wgpu::PrimitiveTopology::TriangleList,
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
    let t_pipeline = t_phase.elapsed();

    let t_phase = std::time::Instant::now();
    // 5-arg constructor matches egui-wgpu 0.32: device, output
    // color format, optional depth format, msaa samples, dithering.
    let egui_renderer = egui_wgpu::Renderer::new(&device, surface_format, None, 1, false);
    let t_egui = t_phase.elapsed();

    log::info!(
        "[drawing.perf] build_persistent TOTAL={:?} instance={:?} adapter={:?} device={:?} shader={:?} pipeline={:?} egui={:?}",
        t_total.elapsed(),
        t_instance,
        t_adapter,
        t_device,
        t_shader,
        t_pipeline,
        t_egui,
    );

    Ok(PersistentGpu {
        instance,
        adapter,
        device,
        queue,
        surface_format,
        view_bind_group_layout,
        pipeline,
        egui_renderer,
    })
}

/// Build the per-surface half of the renderer state: wgpu `Surface`,
/// surface configuration, and the view transform / uniform buffer /
/// bind group. Takes an already-built [`PersistentGpu`] (typically
/// from `build_persistent` at app startup) and a freshly-handed
/// [`SurfaceSource`].
///
/// Hot path for every ink-note open (first or subsequent): the
/// `Surface` itself is per-window, so this can't be prewarmed. But
/// it's also fast — typically <10 ms on real hardware.
pub async fn build_surface_bound(
    persistent: &PersistentGpu,
    window: Box<dyn SurfaceSource>,
    width: u32,
    height: u32,
) -> Result<SurfaceBoundState, String> {
    let t_total = std::time::Instant::now();

    let t_phase = std::time::Instant::now();
    // SAFETY: `window` is owned by us (boxed) and moves into the
    // returned SurfaceBoundState, so its raw handle stays valid
    // for the surface's lifetime. The window's `Drop` runs only
    // after the wgpu surface has been torn down (drop order in
    // SurfaceBoundState is `surface` then `_window`).
    let surface = unsafe {
        persistent
            .instance
            .create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
                raw_display_handle: window.display_handle().unwrap().as_raw(),
                raw_window_handle: window.window_handle().unwrap().as_raw(),
            })
            .map_err(|e| format!("create_surface_unsafe: {e}"))?
    };
    let t_surface = t_phase.elapsed();

    let t_phase = std::time::Instant::now();
    let caps = surface.get_capabilities(&persistent.adapter);
    // Sanity-check the prewarm-assumed format actually appears in
    // this surface's caps. If a device ever turns up that lacks
    // Rgba8Unorm we don't have a quick recovery (the egui_renderer
    // + pipeline were baked against the assumed format), but a
    // loud warning beats silent miscolouring.
    if !caps.formats.contains(&persistent.surface_format) {
        log::warn!(
            "[drawing] surface caps don't include prewarm format {:?} — available: {:?}",
            persistent.surface_format,
            caps.formats,
        );
    }
    let alpha_mode = caps
        .alpha_modes
        .iter()
        .copied()
        .find(|m| *m != wgpu::CompositeAlphaMode::Opaque)
        .unwrap_or(caps.alpha_modes[0]);
    // Prefer the lowest-latency present mode the device exposes.
    // `[drawing.perf.lag]` analysis on a Tab S7 FE showed
    // `frame.present()` (= eglSwapBuffers on the GL backend) was
    // blocking ~10 ms per frame waiting for vsync under the default
    // FIFO mode. Picking Immediate / Mailbox where available drops
    // that wait to ~0:
    //
    //   - Immediate: eglSwapBuffers with swap_interval=0. Tearing
    //     is theoretically possible but ink updates are local and
    //     small, so it's invisible in practice. Lowest latency.
    //   - Mailbox: render at unlimited rate; compositor picks the
    //     newest queued frame at each vsync. No tearing; still
    //     displays at 60 Hz, but always the freshest frame we
    //     submitted before vsync.
    //   - FifoRelaxed: like Fifo but allows tearing when behind
    //     schedule. Treated as a Fifo upgrade.
    //   - Fifo: the floor. What we'd get without any preference.
    //
    // Log the full list so future debugging doesn't have to guess
    // what the device offered.
    log::info!(
        "[drawing] surface present_modes available: {:?}",
        caps.present_modes
    );
    let chosen_present_mode = pick_present_mode(&caps.present_modes);
    log::info!(
        "[drawing] surface present_mode chosen: {:?}",
        chosen_present_mode
    );
    let config = wgpu::SurfaceConfiguration {
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        format: persistent.surface_format,
        width: width.max(1),
        height: height.max(1),
        present_mode: chosen_present_mode,
        alpha_mode,
        view_formats: vec![],
        // 1 rather than the wgpu default of 2: with two frames in
        // flight, a sample arriving just after vsync waits the full
        // remainder of *two* frames before becoming visible (~33 ms
        // on 60 Hz). For ink-style input the lower-latency tradeoff
        // beats the throughput buffering — we render in short
        // bursts triggered by pen samples, not in a steady stream
        // where a GPU stall would cost more than the latency win.
        // If a single frame ever takes >16 ms the next get_current_texture
        // call briefly stalls; that's acceptable for a drawing surface.
        desired_maximum_frame_latency: 1,
    };
    surface.configure(&persistent.device, &config);
    let t_configure = t_phase.elapsed();
    log::info!(
        "[drawing.perf] build_surface_bound TOTAL={:?} surface={:?} configure={:?}",
        t_total.elapsed(),
        t_surface,
        t_configure,
    );

    let page = page::DEFAULT_PAGE;
    let view_transform =
        ViewTransform::fit_in_surface(page, width.max(1) as f32, height.max(1) as f32);
    let view_uniform_buffer = create_view_uniform_buffer(&persistent.device, &view_transform);
    let view_bind_group = create_view_bind_group(
        &persistent.device,
        &persistent.view_bind_group_layout,
        &view_uniform_buffer,
    );

    Ok(SurfaceBoundState {
        surface,
        _window: window,
        config,
        vertex_buffer: None,
        vertex_capacity: 0,
        last_uploaded_committed_count: 0,
        width,
        height,
        view_transform,
        view_uniform_buffer,
        view_bind_group,
        page,
    })
}

// ---------- view-uniform / bind-group helpers ----------

fn create_view_bind_group_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("drawing-view-bind-group-layout"),
        entries: &[wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::VERTEX,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        }],
    })
}

fn create_view_uniform_buffer(
    device: &wgpu::Device,
    view_transform: &ViewTransform,
) -> wgpu::Buffer {
    use wgpu::util::DeviceExt;
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("drawing-view-uniform"),
        contents: bytemuck::bytes_of(&view_transform.as_uniform()),
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    })
}

fn create_view_bind_group(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    buffer: &wgpu::Buffer,
) -> wgpu::BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("drawing-view-bind-group"),
        layout,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: buffer.as_entire_binding(),
        }],
    })
}

/// Pick the lowest-latency `PresentMode` from what the device offers.
///
/// Preference order:
///   1. **Immediate**   — `eglSwapBuffers(swap_interval=0)` on the GL
///                        backend. No vsync wait. Tearing in theory,
///                        invisible for ink in practice (small,
///                        localised updates).
///   2. **Mailbox**     — drop old frames, present newest at vsync.
///                        No tearing, but still vsync-paced display.
///   3. **FifoRelaxed** — like FIFO but allows tearing when running
///                        late. Mild improvement over FIFO.
///   4. **Fifo**        — strict vsync. The floor.
///
/// We fall back to whatever the platform exposes first if none of
/// the above match — wgpu guarantees `Fifo` is always present, so
/// this only triggers if the caps list is somehow malformed.
fn pick_present_mode(modes: &[wgpu::PresentMode]) -> wgpu::PresentMode {
    use wgpu::PresentMode::*;
    for preferred in [Immediate, Mailbox, FifoRelaxed, Fifo] {
        if modes.contains(&preferred) {
            return preferred;
        }
    }
    modes.first().copied().unwrap_or(Fifo)
}

/// One frame of GPU work: upload egui texture deltas, write the
/// stroke vertex buffer, encode a single render pass that draws
/// strokes then egui on top, submit, present.
///
/// Vertex buffer layout each frame (three contiguous zones, single
/// draw call):
///
/// ```text
/// [ committed smoothed ][ raw head ][ predicted lead ]
///   0..C                  C..C+R     C+R..C+R+P
/// ```
///
/// - **Committed** uses the P1 partial-upload optimization —
///   append-only writes when the slice grew (pen-drawing's hot
///   path), full rewrite when it shrank (eraser tombstone,
///   retessellate).
/// - **Raw head** is the two-zone bridge between the smoothed body
///   and the pen tip. Always full-rewritten at offset `C * vsz`
///   because both its content and length change every MOVE.
/// - **Predicted lead** is the future zone-3 forward extrapolation;
///   today this slice is always empty. The pipeline still accepts
///   it as a slot so re-enabling prediction doesn't need a
///   signature change. Same full-rewrite treatment as the raw head.
///
/// Stale bytes past the draw range are harmless — the draw call's
/// vertex range stops exactly at `C + R + P`.
///
/// UI is already tessellated by `CanvasUi::run`; this function
/// doesn't run egui itself.
pub fn render_frame(
    persistent: &mut PersistentGpu,
    surface_state: &mut SurfaceBoundState,
    committed: &[Vertex],
    raw_head: &[Vertex],
    prediction: &[Vertex],
    ui_output: UiOutput,
) -> Result<(), wgpu::SurfaceError> {
    let t_render_start = std::time::Instant::now();
    // Push egui texture updates before any rendering — the font
    // atlas ships this way. Free on the same frame is OK because
    // the GPU work hasn't been submitted yet.
    for (id, image_delta) in &ui_output.textures_delta.set {
        persistent
            .egui_renderer
            .update_texture(&persistent.device, &persistent.queue, *id, image_delta);
    }
    for id in &ui_output.textures_delta.free {
        persistent.egui_renderer.free_texture(id);
    }

    // Stroke vertex buffer — grow geometrically. On grow we
    // allocate a fresh buffer; the GPU's old contents are gone, so
    // the next upload must rewrite from offset 0.
    let vertex_size = std::mem::size_of::<Vertex>() as u64;
    let total_vertices = committed.len() + raw_head.len() + prediction.len();
    let needed = (total_vertices as u64) * vertex_size;
    if needed > surface_state.vertex_capacity {
        let new_capacity = needed.max(surface_state.vertex_capacity * 3 / 2).max(1024);
        surface_state.vertex_buffer = Some(persistent.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("drawing-vbuf"),
            size: new_capacity,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        }));
        surface_state.vertex_capacity = new_capacity;
        // Reset the upload watermark — fresh buffer has no
        // committed contents.
        surface_state.last_uploaded_committed_count = 0;
    }
    // Committed-prefix upload — partial-upload decision (P1):
    //   - Pen-mode append (new_len > last_uploaded): upload just the
    //     new tail at the right byte offset. Per-sample upload cost
    //     drops from ~2 MB rewrite to ~72 bytes for one segment quad.
    //   - Eraser shrink / retess-rebuild (new_len <= last): the
    //     content of the prefix may have shifted, so full re-upload
    //     of the committed slice.
    if !committed.is_empty() {
        let new_len = committed.len() as u64;
        let last = surface_state.last_uploaded_committed_count;
        let vbuf = surface_state.vertex_buffer.as_ref().unwrap();
        if new_len > last {
            let tail_offset = last * vertex_size;
            let tail = &committed[last as usize..];
            persistent
                .queue
                .write_buffer(vbuf, tail_offset, bytemuck::cast_slice(tail));
        } else {
            persistent
                .queue
                .write_buffer(vbuf, 0, bytemuck::cast_slice(committed));
        }
        surface_state.last_uploaded_committed_count = new_len;
    } else {
        // Empty committed: nothing to upload for the prefix. The
        // prediction (if any) writes at offset 0 below. Reset
        // watermark so the next committed append starts from
        // offset 0.
        surface_state.last_uploaded_committed_count = 0;
    }
    // Raw-head upload — always full rewrite at
    // `committed.len() * vertex_size`. The head changes every MOVE
    // (new cursor or new raw input position) and is at most one
    // quad's worth of vertices, so the trivial overwrite is far
    // cheaper than tracking content equality.
    if !raw_head.is_empty() {
        let head_offset = (committed.len() as u64) * vertex_size;
        let vbuf = surface_state.vertex_buffer.as_ref().unwrap();
        persistent
            .queue
            .write_buffer(vbuf, head_offset, bytemuck::cast_slice(raw_head));
    }
    // Prediction-suffix upload — full rewrite at
    // `(committed.len() + raw_head.len()) * vertex_size`. Today
    // this slice is always empty; kept here so the slot exists for
    // when we wire zone-3 forward extrapolation back up.
    if !prediction.is_empty() {
        let pred_offset =
            ((committed.len() + raw_head.len()) as u64) * vertex_size;
        let vbuf = surface_state.vertex_buffer.as_ref().unwrap();
        persistent
            .queue
            .write_buffer(vbuf, pred_offset, bytemuck::cast_slice(prediction));
    }
    let t_upload_done = std::time::Instant::now();

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
    let t_acquire_done = std::time::Instant::now();
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
        pixels_per_point: ui_output.pixels_per_point,
    };
    persistent.egui_renderer.update_buffers(
        &persistent.device,
        &persistent.queue,
        &mut encoder,
        &ui_output.paint_jobs,
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
        // background on top, so any stroke vertices that happen to
        // fall inside the toolbar region are covered visually. The
        // committed strokes and the D2 prediction live contiguously
        // in the same vertex buffer (committed first, prediction
        // appended right after), drawn in a single pass to keep
        // state-change cost flat.
        if let Some(vbuf) = surface_state.vertex_buffer.as_ref() {
            if total_vertices > 0 {
                pass.set_pipeline(&persistent.pipeline);
                // Bind the view uniform (page → screen → NDC) so the
                // line shader can transform our page-coordinate
                // vertices. Vertex data itself stays constant
                // across rotations / re-attaches.
                pass.set_bind_group(0, &surface_state.view_bind_group, &[]);
                pass.set_vertex_buffer(0, vbuf.slice(..));
                pass.draw(0..total_vertices as u32, 0..1);
            }
        }

        // egui's render expects a 'static-lifetime RenderPass —
        // `forget_lifetime` is the documented escape hatch (same
        // pattern tauri-plugin-egui uses). The original `pass`
        // binding is shadowed by the consumed self; the new
        // static-lifetime pass drops at the end of this block.
        persistent.egui_renderer.render(
            &mut pass.forget_lifetime(),
            &ui_output.paint_jobs,
            &screen_descriptor,
        );
    }
    let t_encode_done = std::time::Instant::now();
    persistent.queue.submit(std::iter::once(encoder.finish()));
    let t_submit_done = std::time::Instant::now();
    frame.present();
    let t_present_done = std::time::Instant::now();

    // Sub-breakdown of the [drawing.perf.lag] `gpu` field. If a
    // pen-driven render is reporting gpu≈14-16ms on a 60Hz panel,
    // this log will show the time is in `acquire` (= the swap-chain
    // wait for `get_current_texture` to return a free buffer = one
    // vsync on FIFO). Encode + submit + present are all
    // sub-millisecond on this workload (~few thousand vertices,
    // one draw call). Tagged with the same `[drawing.perf.lag]`
    // prefix as the outer breakdown so a single grep gets both.
    log::info!(
        "[drawing.perf.lag] gpu_split upload={:.1}ms acquire={:.1}ms encode={:.1}ms submit={:.1}ms present={:.1}ms",
        t_upload_done.duration_since(t_render_start).as_secs_f64() * 1000.0,
        t_acquire_done.duration_since(t_upload_done).as_secs_f64() * 1000.0,
        t_encode_done.duration_since(t_acquire_done).as_secs_f64() * 1000.0,
        t_submit_done.duration_since(t_encode_done).as_secs_f64() * 1000.0,
        t_present_done.duration_since(t_submit_done).as_secs_f64() * 1000.0,
    );

    Ok(())
}
