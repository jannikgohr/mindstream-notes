//! D5 brush-size widget — slider popover anchored to the Pen button.
//!
//! Opens when the user taps the Pen button while Pen is already the
//! active tool (one extra tap on the already-selected tool is the
//! "open my settings" gesture, mirroring Procreate / Apple Notes
//! patterns).
//!
//! egui-shadcn's `popover` toggles itself on every trigger-click,
//! which would conflict with the "first tap = switch tool, second
//! tap = open popover" semantics we need on the Pen button. So this
//! module renders its own `egui::Area` styled to match the shadcn
//! popover container (rounded card, popover background, border,
//! drop shadow). Closing-on-outside-click + Escape are handled
//! manually below.

use egui::{
    Align2, Area, CornerRadius, Frame, Id, Margin, Order, Pos2, Rect, Sense, Slider, Stroke, Ui,
};
use egui_shadcn::Theme as ShadcnTheme;

use super::{color_picker, RenderActions};

/// Minimum brush base-width the slider exposes, in page units. Below
/// ~0.5 page units (≈0.09 mm at 144 DPI) the pressure-modulated
/// minimum collapses below a pixel on typical tablet DPIs and the
/// stroke becomes a flickery hairline.
pub const MIN_WIDTH: f32 = 0.5;

/// Maximum brush base-width the slider exposes. 12 page units
/// (≈2.1 mm) is the upper end of "bold marker" feel — enough for
/// highlight-style strokes without making the canvas unusable for
/// regular notes.
pub const MAX_WIDTH: f32 = 12.0;

/// Width of the popover content area, in egui points. Sized to fit
/// the slider plus a comfortable preview swatch + numeric readout.
const POPOVER_WIDTH: f32 = 240.0;

/// Vertical gap between the trigger button and the popover.
const POPOVER_GAP: f32 = 6.0;

/// Toggle the brush popover's open state. Called by the toolbar
/// when the user taps the already-active Pen button.
pub fn toggle_open(ctx: &egui::Context, id_source: Id) {
    let open_id = id_source.with("open");
    let cur = ctx.data(|d| d.get_temp::<bool>(open_id)).unwrap_or(false);
    ctx.data_mut(|d| d.insert_temp(open_id, !cur));
}

/// Force the brush popover closed — used when the user switches
/// tools or otherwise leaves the brush-size flow.
pub fn close(ctx: &egui::Context, id_source: Id) {
    let open_id = id_source.with("open");
    ctx.data_mut(|d| d.insert_temp(open_id, false));
}

/// Render the popover if it's open. Anchored below `trigger_rect`.
/// Slider value mutates `current_width`; on change, fires
/// `RenderActions::set_width`. Pointer-down outside the popover or
/// Escape closes it.
///
/// Takes `&egui::Context` directly (not `&mut Ui`) because the
/// popover renders inside its own top-level `Area` — there's no
/// parent ui-tree to attach to and threading an outer Ui in just to
/// reach `.ctx()` would force the caller to scaffold a dummy Area
/// purely for that reason.
pub fn show_if_open(
    ctx: &egui::Context,
    shadcn: &ShadcnTheme,
    id_source: Id,
    trigger_rect: Rect,
    current_width: f32,
    current_color: u32,
    actions: &mut RenderActions,
) {
    let open_id = id_source.with("open");
    let mut open = ctx.data(|d| d.get_temp::<bool>(open_id)).unwrap_or(false);
    if !open {
        return;
    }

    let palette = &shadcn.palette;
    let bg = palette.popover;
    let border = palette.border;
    let rounding = CornerRadius::same(shadcn.radius.r3.round() as u8);

    // Anchor below the trigger, horizontally centred. egui's `Area`
    // will clamp into the viewport for us, so a near-edge trigger
    // doesn't paint a partially-offscreen popover.
    let anchor_pos = Pos2::new(
        trigger_rect.center().x,
        trigger_rect.bottom() + POPOVER_GAP,
    );

    let popover_id = id_source.with("popover");
    let mut popover_rect = Rect::NOTHING;

    let _area_response = Area::new(popover_id)
        .order(Order::Tooltip)
        .interactable(true)
        .movable(false)
        // `pivot(CENTER_TOP)` makes `fixed_pos` set the area's
        // top-center — so the popover ends up horizontally centred
        // on the trigger and starts just below it.
        .pivot(Align2::CENTER_TOP)
        .fixed_pos(anchor_pos)
        .show(ctx, |ui| {
            let frame = Frame::popup(ui.style())
                .fill(bg)
                .stroke(Stroke::new(1.0, border))
                .corner_radius(rounding)
                .inner_margin(Margin::symmetric(14, 12));
            let resp = frame.show(ui, |ui| {
                ui.set_width(POPOVER_WIDTH);
                paint_popover_contents(
                    ui,
                    shadcn,
                    current_width,
                    current_color,
                    actions,
                );
            });
            popover_rect = resp.response.rect;
        });

    // Dismiss-on-outside-click: any pointer click whose position is
    // not inside the popover rect (and not inside the trigger —
    // tapping the trigger again toggles via toggle_open and should
    // win) closes us.
    let (pointer_click, pointer_pos) = ctx.input(|i| {
        (
            i.pointer.any_click(),
            i.pointer.interact_pos(),
        )
    });
    if pointer_click {
        let inside_popover = pointer_pos
            .map(|p| popover_rect.contains(p))
            .unwrap_or(false);
        let inside_trigger = pointer_pos
            .map(|p| trigger_rect.contains(p))
            .unwrap_or(false);
        if !inside_popover && !inside_trigger {
            open = false;
        }
    }
    // Escape also dismisses — matches the egui-shadcn popover's
    // behaviour so the two popovers feel consistent.
    if ctx.input(|i| i.key_pressed(egui::Key::Escape)) {
        open = false;
    }
    ctx.data_mut(|d| d.insert_temp(open_id, open));
}

/// Render the slider + size-preview swatch inside the popover frame.
fn paint_popover_contents(
    ui: &mut Ui,
    shadcn: &ShadcnTheme,
    current_width: f32,
    current_color: u32,
    actions: &mut RenderActions,
) {
    let palette = &shadcn.palette;

    // Header label — "Brush size" with the numeric value on the right.
    ui.horizontal(|ui| {
        ui.label(
            egui::RichText::new("Brush size")
                .color(palette.popover_foreground)
                .size(13.0),
        );
        ui.with_layout(
            egui::Layout::right_to_left(egui::Align::Center),
            |ui| {
                ui.label(
                    egui::RichText::new(format!("{:.1}", current_width))
                        .color(palette.muted_foreground)
                        .size(12.0),
                );
            },
        );
    });

    ui.add_space(8.0);

    // Live preview: a horizontal pill whose height matches the
    // current brush width. Same fill colour the next stroke will
    // commit, so the user sees "this is what my pen looks like".
    paint_preview(ui, current_width, current_color, palette);

    ui.add_space(10.0);

    // Tweak slider visuals to match the rest of the toolbar — drop
    // egui's default 0.5-px hairline frame so the slider track sits
    // on the popover background cleanly.
    let mut width_value = current_width;
    let response = ui.add(
        Slider::new(&mut width_value, MIN_WIDTH..=MAX_WIDTH)
            .show_value(false)
            .smart_aim(false),
    );
    if response.changed() {
        actions.set_width = Some(width_value);
    }
}

/// Paint a stroke preview at the current brush width + colour. The
/// pill is sized to the popover content width so the user gets a
/// real visual signal: "this is roughly how thick my next stroke
/// will be on the canvas." Height matches the slider's max so the
/// preview never collapses on tiny brush sizes.
fn paint_preview(
    ui: &mut Ui,
    width_pu: f32,
    color: u32,
    palette: &egui_shadcn::tokens::ColorPalette,
) {
    // Reserve a fixed-height slot so the preview's vertical bounds
    // stay stable regardless of brush size. Visual line height
    // tracks the brush width directly (page-unit ≈ egui-point
    // roughly enough at our pixels_per_point).
    let slot_height = MAX_WIDTH + 6.0;
    let (rect, _resp) =
        ui.allocate_exact_size(egui::Vec2::new(POPOVER_WIDTH, slot_height), Sense::hover());
    let painter = ui.painter_at(rect);
    // Subtle muted background so the preview swatch is visible even
    // when the user picks a colour that matches the popover bg
    // (e.g. near-black on dark mode).
    painter.rect_filled(
        rect,
        CornerRadius::same(6),
        palette.muted.linear_multiply(0.6),
    );
    // Preview pill: rounded horizontal capsule, height = brush width.
    let line_h = width_pu.clamp(MIN_WIDTH, MAX_WIDTH);
    let line_rect = Rect::from_center_size(
        rect.center(),
        egui::Vec2::new(rect.width() - 28.0, line_h.max(1.0)),
    );
    let line_radius = (line_h * 0.5).max(1.0);
    painter.rect_filled(
        line_rect,
        CornerRadius::same(line_radius.round() as u8),
        color_picker::unpack(color),
    );
}

