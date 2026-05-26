//! egui-driven UI overlay for the drawing surface.
//!
//! `CanvasUi` owns the `egui::Context` and the per-frame UI logic;
//! the wgpu side (`drawing::pipeline`) owns the matching
//! `egui_wgpu::Renderer`. They communicate via `UiOutput`, which
//! carries the tessellated paint jobs + texture deltas that the
//! GPU pass needs.
//!
//! Module layout (grows as we add tools):
//!   - `toolbar.rs`     — Pen / Eraser toggle, Undo, Redo, Clear
//!                        (no Back — the Svelte header above the
//!                        SurfaceView already owns navigation).
//!   - `theme.rs`       — shadcn-aligned colour tokens → `egui::Visuals`
//!                        applied to the context. Bridged from JS
//!                        via the (future) `drawing_set_theme` Tauri
//!                        command.
//!   - `color_picker.rs`— TODO: D5
//!   - `eraser.rs`      — folded into the tool toggle for now; the
//!                        eraser HIT-TEST lives in `render.rs` since
//!                        it needs access to the StrokesDoc. If the
//!                        eraser grows visual affordances (overlay
//!                        circle at the pointer, etc.) those would
//!                        graduate to a dedicated file.
//!   - `brush.rs`       — TODO: D5

pub mod brush;
pub mod color_picker;
pub mod theme;
pub mod toolbar;

pub use theme::DrawingTheme;

use egui_shadcn::Theme as ShadcnTheme;

/// Custom font family the toolbar references for icon glyphs. The
/// matching `FontData` lives in `lucide-icons`' bundled TTF and is
/// inserted into the egui context once in [`CanvasUi::new`].
pub const LUCIDE_FAMILY: &str = "lucide";

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
///
/// `current_color` / `current_width` drive D5's colour swatch and
/// brush-size slider — the toolbar shows them as the active
/// selection so the user can see what the next pen stroke will look
/// like.
#[derive(Copy, Clone, Debug)]
pub struct UiState {
    pub current_tool: ToolMode,
    pub can_undo: bool,
    pub can_redo: bool,
    pub current_color: u32,
    pub current_width: f32,
}

impl Default for UiState {
    fn default() -> Self {
        Self {
            current_tool: ToolMode::default(),
            can_undo: false,
            can_redo: false,
            current_color: crate::drawing::strokes_doc::DEFAULT_COLOR,
            current_width: crate::drawing::strokes_doc::DEFAULT_WIDTH,
        }
    }
}

/// What the egui UI decided this frame. Read by the render-thread
/// orchestrator after the GPU pass completes. Defaulted fields mean
/// "no action requested this frame" — the orchestrator only acts on
/// the truthy / `Some(_)` ones.
///
/// No `back` field: B1 removed the egui Back button (it duplicated
/// the Svelte mobile header's back arrow that sits above the
/// SurfaceView). The JNI surface — `platform::android::ui::call_back`
/// + `Drawing.backFromNative` — stays in place for a future re-wire
/// if needed.
#[derive(Default, Debug, Clone, Copy)]
pub struct RenderActions {
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
    /// `Some(packed_argb)` when the user picked a colour from the
    /// swatch popover; `None` otherwise. Render thread updates its
    /// `picked_color` state and re-pushes the live-ink overlay
    /// style so the next stroke uses the new colour.
    pub set_color: Option<u32>,
    /// `Some(width)` when the user moved the brush-size slider;
    /// `None` otherwise. Width is in page units (1 unit = 1/144 inch).
    /// Render thread updates `picked_width` and re-pushes the
    /// live-ink overlay style.
    pub set_width: Option<f32>,
}

/// Everything pipeline.rs needs to draw the egui pass: tessellated
/// geometry, font/texture updates, and the scale factor used during
/// tessellation (must match the `ScreenDescriptor.pixels_per_point`
/// the GPU side passes to `egui_wgpu::Renderer::render`).
///
/// `repaint_after` propagates egui's animation hint up to the
/// render-thread loop so it knows whether to schedule a follow-up
/// frame. Without honouring this, in-progress animations (the
/// popover fade-in, hover transitions, …) stall mid-way: the
/// render thread blocks on `rx.recv()` waiting for input and only
/// wakes when the user touches the screen, which is exactly the
/// symptom the user hit ("popover translucent until I touch
/// elsewhere"). `Duration::MAX` means "nothing animating".
pub struct UiOutput {
    pub paint_jobs: Vec<egui::epaint::ClippedPrimitive>,
    pub textures_delta: egui::TexturesDelta,
    pub pixels_per_point: f32,
    pub repaint_after: std::time::Duration,
}

/// Per-frame registry of egui UI surfaces that sit above the canvas
/// and must be protected from Android's front-buffer live-ink layer.
///
/// Widgets register themselves only while they are rendered. Because
/// [`CanvasUi::run`] creates a fresh registry every frame, popovers
/// and other transient controls unregister automatically as soon as
/// they vanish.
pub struct ActiveControlBounds {
    pixels_per_point: f32,
    rects_px: Vec<[f32; 4]>,
}

impl ActiveControlBounds {
    fn new(pixels_per_point: f32) -> Self {
        Self {
            pixels_per_point,
            rects_px: Vec::new(),
        }
    }

    pub fn register_rect(&mut self, rect: egui::Rect) {
        if !rect.is_positive() {
            return;
        }
        self.rects_px.push([
            rect.min.x * self.pixels_per_point,
            rect.min.y * self.pixels_per_point,
            rect.max.x * self.pixels_per_point,
            rect.max.y * self.pixels_per_point,
        ]);
    }

    fn into_rects(self) -> Vec<[f32; 4]> {
        self.rects_px
    }
}

/// The UI side of the canvas. Owns the egui context so widget state
/// (hover, focus, future tool mode, …) persists across frames
/// without leaking into pipeline.rs. Also holds the active theme so
/// `set_theme` can re-apply visuals without rebuilding the whole
/// context.
///
/// `shadcn` is the cached `egui_shadcn::Theme` derived from `theme`.
/// We cache it because `ShadcnTheme::new()` emits an `info!`-level
/// log on every call, and the toolbar reads the theme each frame —
/// without caching the log spammed once per drawn frame. Rebuilt
/// only when `set_theme` is called (rare; driven by user-level
/// appearance / accent setting changes from JS).
pub struct CanvasUi {
    ctx: egui::Context,
    theme: DrawingTheme,
    shadcn: ShadcnTheme,
    active_control_bounds: Vec<[f32; 4]>,
}

impl CanvasUi {
    pub fn new() -> Self {
        let ctx = egui::Context::default();
        ctx.set_pixels_per_point(PIXELS_PER_POINT);

        // Register the bundled Lucide TTF as a custom font family
        // (`LUCIDE_FAMILY`) so the toolbar can render icons via
        // `RichText::new(char::from(Icon::X).to_string())
        //     .family(FontFamily::Name(LUCIDE_FAMILY.into()))`.
        // egui-shadcn doesn't auto-register the font even though it
        // depends on lucide-icons — we still own the font loading.
        // We don't add Lucide to the proportional / monospace
        // fallback chains; only widgets that explicitly opt in
        // (the toolbar) render glyphs, so regular text isn't
        // affected by the icon font's missing letter coverage.
        let mut fonts = egui::FontDefinitions::default();
        fonts.font_data.insert(
            LUCIDE_FAMILY.into(),
            egui::FontData::from_static(lucide_icons::LUCIDE_FONT_BYTES).into(),
        );
        fonts.families.insert(
            egui::FontFamily::Name(LUCIDE_FAMILY.into()),
            vec![LUCIDE_FAMILY.into()],
        );
        ctx.set_fonts(fonts);

        // No `set_visuals` call here — egui-shadcn manages per-widget
        // visuals through its own scoped `Theme` (see `toolbar::show`).
        // The default egui Visuals stay underneath for anything
        // shadcn doesn't paint (e.g. the panel Frame's borderless
        // background, which the toolbar fills explicitly).
        let theme = DrawingTheme::default();
        let shadcn = theme.shadcn_theme();
        Self {
            ctx,
            theme,
            shadcn,
            active_control_bounds: Vec::new(),
        }
    }

    /// Swap the toolbar theme — driven by the `drawing_set_theme`
    /// Tauri command whenever JS observes a change in the app's
    /// dark-mode + accent settings. Rebuilds the cached
    /// `egui_shadcn::Theme` here so the per-frame toolbar path can
    /// just read `self.shadcn` instead of re-running `Theme::new`
    /// (which logs on every call — see the `CanvasUi` doc).
    pub fn set_theme(&mut self, theme: DrawingTheme) {
        self.theme = theme;
        self.shadcn = theme.shadcn_theme();
        // Force a repaint so the new palette shows up immediately
        // rather than waiting for the next input event.
        self.ctx.request_repaint();
    }

    /// Read-only access for the toolbar, which needs the panel
    /// background colour for the egui `Frame::fill`.
    pub fn theme(&self) -> &DrawingTheme {
        &self.theme
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
        let theme = self.theme;
        let shadcn = &self.shadcn;
        let mut active_control_bounds = ActiveControlBounds::new(PIXELS_PER_POINT);
        let full_output = self.ctx.run(input, |ctx| {
            toolbar::show(
                ctx,
                PIXELS_PER_POINT,
                &theme,
                shadcn,
                state,
                &mut actions,
                &mut active_control_bounds,
            );
        });
        self.active_control_bounds = active_control_bounds.into_rects();
        // egui tracks per-viewport repaint delays — we have a
        // single embedded viewport, but iterate defensively in case
        // a future popover-in-window grows that count. The minimum
        // is what the render thread needs to honour to keep
        // animations smooth.
        let repaint_after = full_output
            .viewport_output
            .values()
            .map(|v| v.repaint_delay)
            .min()
            .unwrap_or(std::time::Duration::MAX);
        let paint_jobs = self.ctx.tessellate(full_output.shapes, PIXELS_PER_POINT);
        let ui_output = UiOutput {
            paint_jobs,
            textures_delta: full_output.textures_delta,
            pixels_per_point: PIXELS_PER_POINT,
            repaint_after,
        };
        (actions, ui_output)
    }

    /// Get the physical screen-pixel coordinates of all active
    /// transient UI rects (e.g. popovers).
    pub fn get_active_control_bounds(&self) -> Vec<[f32; 4]> {
        self.active_control_bounds.clone()
    }
}

impl Default for CanvasUi {
    fn default() -> Self {
        Self::new()
    }
}
