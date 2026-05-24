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

use std::ptr::NonNull;

use bytemuck::{Pod, Zeroable};
use raw_window_handle::{HasDisplayHandle, HasWindowHandle};

use super::page::{self, PageSize, ViewTransform};
use super::surface::AndroidWindow;
use super::ui::UiOutput;

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
pub struct Vertex {
    pub position: [f32; 2],
    /// Per-vertex linear RGBA in 0..1. Uniform across a single
    /// stroke today (renderer bakes the stroke's packed colour at
    /// tessellation time), but per-vertex storage means D5's
    /// gradient brushes / per-sample colour interpolation just
    /// drops in.
    pub color: [f32; 4],
}

impl Vertex {
    const ATTRIBS: [wgpu::VertexAttribute; 2] =
        wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x4];

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
/// Drop beyond `eglDestroySurface` + `ANativeWindow_release`.
pub struct SurfaceBoundState {
    // Drop order is field-declaration order in Rust — `surface` is
    // declared before `_window` so the wgpu surface is dropped first,
    // then `AndroidWindow::drop` runs `ANativeWindow_release`.
    surface: wgpu::Surface<'static>,
    _window: Box<AndroidWindow>,
    config: wgpu::SurfaceConfiguration,
    vertex_buffer: Option<wgpu::Buffer>,
    vertex_capacity: u64,
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

/// First-time init: builds both halves at once. Returns the
/// persistent state + the first surface bound to it.
pub async fn build_first_time(
    native_window: NonNull<ndk_sys::ANativeWindow>,
    width: u32,
    height: u32,
) -> Result<(PersistentGpu, SurfaceBoundState), String> {
    let window = Box::new(AndroidWindow::new(native_window));

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
    // assumes a linear render target — sRGB formats produce washed-
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

    // 5-arg constructor matches egui-wgpu 0.32: device, output
    // color format, optional depth format, msaa samples, dithering.
    let egui_renderer = egui_wgpu::Renderer::new(&device, surface_format, None, 1, false);

    // Initial page + view transform. Resize() will rebuild the
    // transform whenever the surface changes size.
    let page = page::DEFAULT_PAGE;
    let view_transform =
        ViewTransform::fit_in_surface(page, width.max(1) as f32, height.max(1) as f32);
    let view_uniform_buffer = create_view_uniform_buffer(&device, &view_transform);
    let view_bind_group = create_view_bind_group(
        &device,
        &view_bind_group_layout,
        &view_uniform_buffer,
    );

    let persistent = PersistentGpu {
        instance,
        adapter,
        device,
        queue,
        surface_format,
        view_bind_group_layout,
        pipeline,
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
        view_transform,
        view_uniform_buffer,
        view_bind_group,
        page,
    };
    Ok((persistent, surface_state))
}

/// Subsequent attaches: reuse the existing persistent state, just
/// build a new `Surface` against the new ANativeWindow and configure
/// it with the pinned format / cached caps.
pub async fn build_surface_only(
    persistent: &PersistentGpu,
    native_window: NonNull<ndk_sys::ANativeWindow>,
    width: u32,
    height: u32,
) -> Result<SurfaceBoundState, String> {
    let window = Box::new(AndroidWindow::new(native_window));

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

/// One frame of GPU work: upload egui texture deltas, write the
/// stroke vertex buffer, encode a single render pass that draws
/// strokes then egui on top, submit, present.
///
/// UI is already tessellated by `CanvasUi::run`; this function
/// doesn't run egui itself.
pub fn render_frame(
    persistent: &mut PersistentGpu,
    surface_state: &mut SurfaceBoundState,
    segments: &[Vertex],
    ui_output: UiOutput,
) -> Result<(), wgpu::SurfaceError> {
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
        // fall inside the toolbar region are covered visually.
        if let Some(vbuf) = surface_state.vertex_buffer.as_ref() {
            if !segments.is_empty() {
                pass.set_pipeline(&persistent.pipeline);
                // Bind the view uniform (page → screen → NDC) so the
                // line shader can transform our page-coordinate
                // vertices. Vertex data itself stays constant
                // across rotations / re-attaches.
                pass.set_bind_group(0, &surface_state.view_bind_group, &[]);
                pass.set_vertex_buffer(0, vbuf.slice(..));
                pass.draw(0..segments.len() as u32, 0..1);
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
    persistent.queue.submit(std::iter::once(encoder.finish()));
    frame.present();

    Ok(())
}
