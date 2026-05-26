//! The egui toolbar that lives at the top of the drawing surface.
//!
//! Current layout: Pen | Eraser | (sep) | Undo | Redo | (sep) | Clear.
//! Built on `egui-shadcn` for the button widgets (Radix/shadcn
//! variants, sizes, hover/focus animation) and on `lucide-icons` for
//! the glyphs (loaded as a custom font family by `CanvasUi::new`).
//!
//! egui-shadcn's `button()` extracts a plain `&str` from any
//! `WidgetText` it receives and re-renders it with its own theme
//! `FontId` — RichText family/size hints get dropped on the floor.
//! For Lucide glyphs we therefore go through the lower-level
//! `Button::icon(&painter_fn).show(...)` path instead, where we get
//! a raw `egui::Painter` and full control over the FontId used to
//! lay out the glyph. The label string is left empty so shadcn's
//! built-in text path doesn't paint the `.notdef` box.
//!
//! No Back button: the Svelte mobile header above the SurfaceView
//! already provides navigation and the in-egui copy was redundant.
//! The JNI surface (`platform::android::ui::call_back` /
//! `Drawing.backFromNative`) stays in place for a future re-wire.

use egui::{pos2, Color32, FontFamily, FontId, Frame, Margin, Painter, Pos2, TopBottomPanel};
use egui_shadcn::button::{Button, ButtonSize, ButtonVariant};
use egui_shadcn::Theme as ShadcnTheme;
use lucide_icons::Icon;

use super::{DrawingTheme, RenderActions, ToolMode, UiState, LUCIDE_FAMILY};

/// Visible height of the toolbar in pixels. Also used by the
/// render-thread touch routing to decide which gestures egui owns
/// (`y < TOOLBAR_HEIGHT_PX` → suppress stroke, drive egui only).
pub const TOOLBAR_HEIGHT_PX: f32 = 120.0;

/// Render the toolbar inside the supplied egui context. Reads
/// `state` for the selected-tool highlight + the undo/redo
/// availability; mutates `actions` so the render-thread orchestrator
/// can act on what the user picked this frame.
pub fn show(
    ctx: &egui::Context,
    pixels_per_point: f32,
    theme: &DrawingTheme,
    state: UiState,
    actions: &mut RenderActions,
) {
    let panel_height_pts = TOOLBAR_HEIGHT_PX / pixels_per_point;
    let shadcn = theme.shadcn_theme();
    TopBottomPanel::top("drawing-toolbar")
        .exact_height(panel_height_pts)
        .frame(
            Frame::default()
                .fill(theme.background())
                .inner_margin(Margin {
                    left: 12,
                    right: 12,
                    top: 8,
                    bottom: 8,
                }),
        )
        .show(ctx, |ui| {
            // Tight gap between buttons; egui's default item spacing
            // reads as crammed once the buttons themselves get
            // shadcn's internal padding.
            ui.spacing_mut().item_spacing = egui::vec2(6.0, 0.0);

            ui.horizontal_centered(|ui| {
                // Painter closures live for the duration of this
                // closure — that's all the Button::icon lifetime
                // bound requires (`&'a dyn Fn(...)` where 'a is
                // bounded by the Button's `.show()` call).
                let paint_pen = lucide_painter(Icon::Pen);
                let paint_eraser = lucide_painter(Icon::Eraser);
                let paint_undo = lucide_painter(Icon::Undo);
                let paint_redo = lucide_painter(Icon::Redo);
                let paint_trash = lucide_painter(Icon::Trash2);

                // Pen / Eraser are mutually exclusive — render as a
                // pair of icon buttons, highlight the selected one
                // with shadcn's `Default` variant (the styled
                // primary look) and leave the other on `Ghost`.
                let pen_active = state.current_tool == ToolMode::Pen;
                if shadcn_icon_button(ui, &shadcn, &paint_pen, "Pen", variant_for(pen_active), true)
                    && !pen_active
                {
                    actions.set_tool = Some(ToolMode::Pen);
                }
                let eraser_active = state.current_tool == ToolMode::Eraser;
                if shadcn_icon_button(
                    ui,
                    &shadcn,
                    &paint_eraser,
                    "Erase",
                    variant_for(eraser_active),
                    true,
                ) && !eraser_active
                {
                    actions.set_tool = Some(ToolMode::Eraser);
                }

                ui.separator();

                // Undo / Redo greyed-out when the matching stack is
                // empty — egui-shadcn's `enabled` flag does the
                // visual treatment automatically.
                if shadcn_icon_button(
                    ui,
                    &shadcn,
                    &paint_undo,
                    "Undo",
                    ButtonVariant::Ghost,
                    state.can_undo,
                ) {
                    actions.undo = true;
                }
                if shadcn_icon_button(
                    ui,
                    &shadcn,
                    &paint_redo,
                    "Redo",
                    ButtonVariant::Ghost,
                    state.can_redo,
                ) {
                    actions.redo = true;
                }

                ui.separator();

                // Clear uses shadcn's destructive variant — red
                // background that flags "this destroys data",
                // matching the destructive ghost-buttons elsewhere
                // in the app.
                if shadcn_icon_button(
                    ui,
                    &shadcn,
                    &paint_trash,
                    "Clear all",
                    ButtonVariant::Destructive,
                    true,
                ) {
                    actions.clear = true;
                }
            });
        });
}

/// Map an "is this the active tool?" bool onto a shadcn button
/// variant. Selected gets the styled `Default` (shadcn's primary
/// solid look); unselected stays on `Ghost` so the inactive button
/// blends into the toolbar background.
fn variant_for(active: bool) -> ButtonVariant {
    if active {
        ButtonVariant::Default
    } else {
        ButtonVariant::Ghost
    }
}

/// Render a shadcn icon button whose glyph comes from a Lucide
/// painter closure. Returns `true` on the frame the user clicks
/// (and the button is enabled). Tooltip text shows on hover.
///
/// The empty `Button::new("")` label is intentional — see the
/// module docstring; we paint the icon ourselves through
/// `Button::icon` so the lookup goes through the LUCIDE font family
/// rather than shadcn's default text FontId.
fn shadcn_icon_button(
    ui: &mut egui::Ui,
    theme: &ShadcnTheme,
    painter: &dyn Fn(&Painter, Pos2, f32, Color32),
    tooltip: &str,
    variant: ButtonVariant,
    enabled: bool,
) -> bool {
    Button::new("")
        .variant(variant)
        .size(ButtonSize::Icon)
        .enabled(enabled)
        .icon(painter)
        .show(ui, theme)
        .on_hover_text(tooltip)
        .clicked()
}

/// Build a `Button::icon` closure that paints `icon`'s Lucide glyph
/// at the requested centre / size / colour. The FontId pins the
/// `LUCIDE_FAMILY` family that `CanvasUi::new` registered against
/// the bundled TTF — the only path that survives egui-shadcn's
/// "extract `.text()` and re-render" handling of `WidgetText`.
///
/// `move` so the closure owns its `Icon` copy; the resulting `Fn`
/// is callable any number of times by `Button::show`.
fn lucide_painter(icon: Icon) -> impl Fn(&Painter, Pos2, f32, Color32) {
    move |painter, center, size, color| {
        let font_id = FontId::new(size, FontFamily::Name(LUCIDE_FAMILY.into()));
        let galley =
            painter.layout_no_wrap(icon.unicode().to_string(), font_id, color);
        let pos = pos2(
            center.x - galley.rect.width() / 2.0,
            center.y - galley.rect.height() / 2.0,
        );
        painter.galley(pos, galley, color);
    }
}
