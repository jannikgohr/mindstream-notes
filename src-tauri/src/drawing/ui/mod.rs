//! egui-driven UI overlay for the drawing surface.
//!
//! `CanvasUi` owns the `egui::Context` and the per-frame UI logic;
//! the wgpu side (`drawing::pipeline`) owns the matching
//! `egui_wgpu::Renderer`. They communicate via `UiOutput`, which
//! carries the tessellated paint jobs + texture deltas that the
//! GPU pass needs.
//!
//! Module layout (grows as we add tools):
//!   - `toolbar.rs`     — Back / tool toggle / Undo / Redo / Clear
//!   - `color_picker.rs`— TODO: D5
//!   - `eraser.rs`      — folded into the tool toggle for now; the
//!                        eraser HIT-TEST lives in `render.rs` since
//!                        it needs access to the StrokesDoc. If the
//!                        eraser grows visual affordances (overlay
//!                        circle at the pointer, etc.) those would
//!                        graduate to a dedicated file.
//!   - `brush.rs`       — TODO: D5

pub mod toolbar;

/// Scale factor we tell egui to use. Pixels per logical point.
/// Roughly matches a typical phone density; a future improvement
/// is to read `DisplayMetrics.density` from Kotlin and plumb the
/// real value through.
pub const PIXELS_PER_POINT: f32 = 2.5;

/// User-selected drawing tool. Distinct from `input::ToolKind` —
/// `ToolKind` describes the input *device* (finger / stylus /
/// eraser-tip / …), `ToolMode` describes what the user wants their
/// gestures to *do* (draw a new stroke vs erase existing ones).
/// Set via the toolbar; held on the render thread as authoritative
/// state, mirrored into the UI each frame for the selectable
/// button's visual highlight.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub enum ToolMode {
    #[default]
    Pen,
    Eraser,
}

/// Per-frame state the render thread hands to the UI so the toolbar
/// can render the selected-tool highlight + grey out unavailable
/// undo/redo buttons. Kept tiny (Copy) so passing it by value is
/// trivial.
#[derive(Copy, Clone, Debug, Default)]
pub struct UiState {
    pub current_tool: ToolMode,
    pub can_undo: bool,
    pub can_redo: bool,
}

/// What the egui UI decided this frame. Read by the render-thread
/// orchestrator after the GPU pass completes. Defaulted fields mean
/// "no action requested this frame" — the orchestrator only acts on
/// the truthy / `Some(_)` ones.
#[derive(Default, Debug, Clone, Copy)]
pub struct RenderActions {
    /// Toolbar Back button or system-back gesture.
    pub back: bool,
    /// Toolbar Clear button — tombstones every visible stroke and
    /// pushes a single ClearAll op onto the undo stack.
    pub clear: bool,
    /// `Some(mode)` when the user picked a different tool; `None`
    /// otherwise. Render thread updates its `tool_mode` state.
    pub set_tool: Option<ToolMode>,
    /// Undo / redo button presses. Render thread pops from the
    /// matching stack and applies the inverse / re-applies.
    pub undo: bool,
    pub redo: bool,
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
    /// surface size, drives the toolbar (which reads `state` for
    /// button visual states), tessellates, and returns the actions
    /// the user triggered + the GPU-ready output.
    pub fn run(
        &mut self,
        mut input: egui::RawInput,
        surface_size_px: (u32, u32),
        state: UiState,
    ) -> (RenderActions, UiOutput) {
        let surface_points = egui::Vec2::new(
            surface_size_px.0.max(1) as f32 / PIXELS_PER_POINT,
            surface_size_px.1.max(1) as f32 / PIXELS_PER_POINT,
        );
        input.screen_rect = Some(egui::Rect::from_min_size(egui::Pos2::ZERO, surface_points));

        let mut actions = RenderActions::default();
        let full_output = self.ctx.run(input, |ctx| {
            toolbar::show(ctx, PIXELS_PER_POINT, state, &mut actions);
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
