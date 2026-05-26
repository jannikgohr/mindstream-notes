//! D5 colour-picker widget — shadcn-popover-anchored swatch grid.
//!
//! UX:
//!   - Toolbar shows a circular swatch button filled with the
//!     currently-picked colour. Tapping toggles a popover.
//!   - Popover contains an 8-colour quick-select grid (2 × 4) plus
//!     the current-selection chip. Tapping a swatch fires
//!     `RenderActions::set_color` and closes the popover.
//!
//! Quick-select palette is Tailwind-600 saturated colours plus
//! black/gray — a small inclusive set that covers most note-taking
//! needs without overwhelming the user. A future iteration can add
//! a custom HSL picker; this is the MVP.
//!
//! Styling: the popover frame is the standard egui-shadcn `popover`
//! container (rounded card with subtle border, drop shadow, popover
//! background). Swatches are circles with a 1px border in the
//! theme's `border` colour; the selected swatch gets a 2px ring in
//! the theme's `ring` colour matching the user's accent setting.

use egui::{
    Color32, CornerRadius, Id, Rect, Response, Sense, Stroke, StrokeKind, Ui, Vec2,
};
use egui_shadcn::popover::{popover, PopoverProps, PopoverSide};
use egui_shadcn::Theme as ShadcnTheme;

use super::RenderActions;

/// Diameter of each colour swatch inside the popover, in egui points.
const SWATCH_DIAMETER: f32 = 32.0;
/// Diameter of the trigger swatch on the toolbar.
const TRIGGER_DIAMETER: f32 = 32.0;
/// Visual padding around the swatch grid inside the popover.
const SWATCHES_PER_ROW: usize = 4;

/// Quick-select palette. ARGB packed; alpha is always opaque (0xFF).
/// Chosen for note-taking legibility on white backgrounds — Tailwind
/// 500/600 shades for the chromatic entries plus achromatic anchors.
pub const SWATCH_PALETTE: &[u32] = &[
    0xFF00_0000, // Black
    0xFF6B_7280, // Gray-500
    0xFFDC_2626, // Red-600
    0xFFEA_580C, // Orange-600
    0xFFF5_9E0B, // Amber-500
    0xFF16_A34A, // Green-600
    0xFF25_63EB, // Blue-600
    0xFF93_33EA, // Purple-600
];

/// Convert a packed 0xAARRGGBB into the `Color32` egui paints with.
pub fn unpack(argb: u32) -> Color32 {
    let a = ((argb >> 24) & 0xFF) as u8;
    let r = ((argb >> 16) & 0xFF) as u8;
    let g = ((argb >> 8) & 0xFF) as u8;
    let b = (argb & 0xFF) as u8;
    Color32::from_rgba_unmultiplied(r, g, b, a)
}

/// Render the colour-picker trigger swatch + its popover. Caller
/// passes the current colour for the swatch fill and the action sink
/// for `set_color`. Popover-open state lives in egui's `ctx.data`
/// keyed by `id_source` so it survives across frames without the
/// caller holding it.
pub fn show(
    ui: &mut Ui,
    shadcn: &ShadcnTheme,
    id_source: Id,
    current_color: u32,
    actions: &mut RenderActions,
) {
    // Load+save popover open state via context data so the caller
    // doesn't need a mutable bool. Same pattern is repeated in
    // brush.rs.
    let open_id = id_source.with("open");
    let mut open = ui
        .ctx()
        .data(|d| d.get_temp::<bool>(open_id))
        .unwrap_or(false);
    // The popover takes `&mut open` for its own click toggle. The
    // content closure can't *also* hold `&mut open` (E0499), so we
    // funnel "user picked a swatch → close me" through a separate
    // flag that the closure can borrow exclusively and we apply
    // after the popover function returns.
    let mut request_close = false;

    popover(
        ui,
        shadcn,
        PopoverProps::new(id_source, &mut open).side(PopoverSide::Bottom),
        |ui| paint_swatch_button(ui, current_color, shadcn, TRIGGER_DIAMETER),
        |ui| paint_palette_grid(ui, shadcn, current_color, actions, &mut request_close),
    );

    if request_close {
        open = false;
    }
    ui.ctx().data_mut(|d| d.insert_temp(open_id, open));
}

/// Paint a circular colour-swatch button. Returns the click `Response`
/// the popover anchors to (and uses for click-toggle).
fn paint_swatch_button(
    ui: &mut Ui,
    color: u32,
    shadcn: &ShadcnTheme,
    diameter: f32,
) -> Response {
    let size = Vec2::splat(diameter);
    let (rect, response) = ui.allocate_exact_size(size, Sense::click());
    let palette = &shadcn.palette;
    let centre = rect.center();
    let radius = diameter * 0.5;
    let painter = ui.painter();
    // 1px border + colour fill. Hover/active bumps the border to the
    // accent ring so the trigger feels alive — matches shadcn's
    // button hover treatment.
    let border = if response.hovered() || response.is_pointer_button_down_on() {
        palette.ring
    } else {
        palette.border
    };
    painter.circle_filled(centre, radius - 1.0, unpack(color));
    painter.circle_stroke(centre, radius - 1.0, Stroke::new(1.0, border));
    response.on_hover_text("Pen colour")
}

/// Lay out the 8-colour grid inside the popover. Selected colour
/// gets a 2px ring; others get a 1px border. Tapping a swatch fires
/// `set_color` and sets `request_close` — the caller above (which
/// owns the popover's `open` bool) applies the close after the
/// popover function returns, sidestepping the double-mutable-borrow
/// otherwise required to share `&mut open` here.
fn paint_palette_grid(
    ui: &mut Ui,
    shadcn: &ShadcnTheme,
    current_color: u32,
    actions: &mut RenderActions,
    request_close: &mut bool,
) {
    let rows = SWATCH_PALETTE.len().div_ceil(SWATCHES_PER_ROW);
    let palette = &shadcn.palette;

    ui.spacing_mut().item_spacing = egui::vec2(8.0, 8.0);
    for row_idx in 0..rows {
        ui.horizontal(|ui| {
            for col_idx in 0..SWATCHES_PER_ROW {
                let i = row_idx * SWATCHES_PER_ROW + col_idx;
                let Some(&color) = SWATCH_PALETTE.get(i) else {
                    break;
                };
                let selected = color == current_color;
                let response = paint_palette_swatch(ui, color, selected, palette);
                if response.clicked() {
                    actions.set_color = Some(color);
                    *request_close = true;
                }
            }
        });
    }
}

/// One swatch inside the grid. Same circular look as the trigger,
/// but with a selected-state ring drawn outside the swatch (so the
/// fill stays the user's colour, not occluded by the ring).
fn paint_palette_swatch(
    ui: &mut Ui,
    color: u32,
    selected: bool,
    palette: &egui_shadcn::tokens::ColorPalette,
) -> Response {
    let size = Vec2::splat(SWATCH_DIAMETER);
    let (rect, response) = ui.allocate_exact_size(size, Sense::click());
    let painter = ui.painter();
    let centre = rect.center();
    let radius = SWATCH_DIAMETER * 0.5;
    let fill_radius = radius - 2.0;
    painter.circle_filled(centre, fill_radius, unpack(color));
    // Inner border so every swatch (incl. near-white ones) is
    // clearly delimited from the popover background.
    painter.circle_stroke(
        centre,
        fill_radius,
        Stroke::new(1.0, palette.border),
    );
    if selected {
        // Outer ring marks the active selection. Slightly larger
        // radius so it sits OUTSIDE the swatch fill, leaving a thin
        // popover-bg gap between the swatch and ring — same visual
        // affordance shadcn's web `select` uses.
        let outer_rect =
            Rect::from_center_size(centre, Vec2::splat(SWATCH_DIAMETER + 4.0));
        painter.rect_stroke(
            outer_rect,
            CornerRadius::same((SWATCH_DIAMETER / 2.0 + 2.0).round() as u8),
            Stroke::new(2.0, palette.ring),
            StrokeKind::Inside,
        );
    }
    if response.hovered() {
        // Subtle hover halo — matches the trigger's hover treatment.
        let hover_rect =
            Rect::from_center_size(centre, Vec2::splat(SWATCH_DIAMETER + 2.0));
        painter.rect_stroke(
            hover_rect,
            CornerRadius::same((SWATCH_DIAMETER / 2.0 + 1.0).round() as u8),
            Stroke::new(1.0, palette.ring.linear_multiply(0.5)),
            StrokeKind::Inside,
        );
    }
    response
}
