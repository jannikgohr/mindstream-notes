//! egui-driven UI overlay for the drawing surface.
//!
//! `CanvasUi` owns the `egui::Context` and the per-frame UI logic;
//! the wgpu side (`drawing::pipeline`) owns the matching
//! `egui_wgpu::Renderer`. They communicate via `UiOutput`, which
//! carries the tessellated paint jobs + texture deltas that the
//! GPU pass needs.
//!
//! Module layout (grows as we add tools):
//!   - `toolbar.rs`     — current Back + Clear toolbar
//!   - `color_picker.rs`— TODO: D5
//!   - `eraser.rs`      — TODO: D3
//!   - `brush.rs`       — TODO: D5

pub mod toolbar;

/// Scale factor we tell egui to use. Pixels per logical point.
/// Roughly matches a typical phone density; a future improvement
/// is to read `DisplayMetrics.density` from Kotlin and plumb the
/// real value through.
pub const PIXELS_PER_POINT: f32 = 2.5;

/// What the egui UI decided this frame. Read by the render-thread
/// orchestrator after the GPU pass completes — `clear` wipes the
/// stroke buffer, `back` bounces through Kotlin to navigate away
/// from the ink note.
#[derive(Default, Debug, Clone, Copy)]
pub struct RenderActions {
    pub back: bool,
    pub clear: bool,
}

/// Everything pipeline.rs needs to draw the egui pass: tessellated
/// geometry, font/texture updates, and the scale factor used during
/// tessellation (must match the `ScreenDescriptor.pixels_per_point`
/// the GPU side passes to `egui_wgpu::Renderer::render`).
pub struct UiOutput {
    pub paint_jobs: Vec<egui::epaint::ClippedPrimitive>,
    pub textures_delta: egui::TexturesDelta,
    pub pixels_per_point: f32,
}

/// The UI side of the canvas. Owns the egui context so widget state
/// (hover, focus, future tool mode, …) persists across frames
/// without leaking into pipeline.rs.
pub struct CanvasUi {
    ctx: egui::Context,
}

impl CanvasUi {
    pub fn new() -> Self {
        let ctx = egui::Context::default();
        ctx.set_pixels_per_point(PIXELS_PER_POINT);
        Self { ctx }
    }

    /// Run one frame of the UI. Sets the egui screen rect from the
    /// surface size, drives the toolbar, tessellates, and returns
    /// the actions the user triggered + the GPU-ready output.
    pub fn run(
        &mut self,
        mut input: egui::RawInput,
        surface_size_px: (u32, u32),
    ) -> (RenderActions, UiOutput) {
        let surface_points = egui::Vec2::new(
            surface_size_px.0.max(1) as f32 / PIXELS_PER_POINT,
            surface_size_px.1.max(1) as f32 / PIXELS_PER_POINT,
        );
        input.screen_rect = Some(egui::Rect::from_min_size(egui::Pos2::ZERO, surface_points));

        let mut actions = RenderActions::default();
        let full_output = self.ctx.run(input, |ctx| {
            toolbar::show(ctx, PIXELS_PER_POINT, &mut actions);
        });
        let paint_jobs = self.ctx.tessellate(full_output.shapes, PIXELS_PER_POINT);
        let ui_output = UiOutput {
            paint_jobs,
            textures_delta: full_output.textures_delta,
            pixels_per_point: PIXELS_PER_POINT,
        };
        (actions, ui_output)
    }
}

impl Default for CanvasUi {
    fn default() -> Self {
        Self::new()
    }
}
