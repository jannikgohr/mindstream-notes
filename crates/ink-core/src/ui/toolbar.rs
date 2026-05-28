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

use egui::{
    pos2, Color32, FontFamily, FontId, Frame, Id, Margin, Painter, Pos2, Rect, Response,
    TopBottomPanel,
};
use egui_shadcn::button::{Button, ButtonSize, ButtonVariant};
use egui_shadcn::Theme as ShadcnTheme;
use lucide_icons::Icon;

use super::{
    brush, color_picker, ActiveControlBounds, DrawingTheme, InkPageThemeMode, RenderActions,
    ToolMode, UiState, LUCIDE_FAMILY,
};

/// Visible height of the toolbar in pixels. Also used by the
/// render-thread touch routing to decide which gestures egui owns
/// (`y < TOOLBAR_HEIGHT_PX` → suppress stroke, drive egui only).
pub const TOOLBAR_HEIGHT_PX: f32 = 120.0;

/// Render the toolbar inside the supplied egui context. Reads
/// `state` for the selected-tool highlight + the undo/redo
/// availability; mutates `actions` so the render-thread orchestrator
/// can act on what the user picked this frame.
///
/// `shadcn` is the per-frame `egui_shadcn::Theme` reference — owned
/// and cached by [`super::CanvasUi`] so we don't pay
/// `ShadcnTheme::new`'s `info!` log + token-defaults setup on every
/// frame.
pub fn show(
    ctx: &egui::Context,
    pixels_per_point: f32,
    theme: &DrawingTheme,
    shadcn: &ShadcnTheme,
    state: UiState,
    actions: &mut RenderActions,
    active_control_bounds: &mut ActiveControlBounds,
) {
    let panel_height_pts = TOOLBAR_HEIGHT_PX / pixels_per_point;
    let brush_popover_id = Id::new("drawing-brush-popover");
    let color_popover_id = Id::new("drawing-color-popover");
    let mut pen_button_rect: Rect = Rect::NOTHING;

    TopBottomPanel::top("drawing-toolbar")
        .exact_height(panel_height_pts)
        .show_separator_line(false)
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
                let paint_pointer = lucide_painter(Icon::Pointer);
                let paint_pointer_off = lucide_painter(Icon::PointerOff);
                let paint_light_page = lucide_painter(Icon::Sun);
                let paint_system_page = lucide_painter(Icon::SunMoon);
                let paint_undo = lucide_painter(Icon::Undo);
                let paint_redo = lucide_painter(Icon::Redo);
                let paint_trash = lucide_painter(Icon::Trash2);

                // Pen / Eraser are mutually exclusive — render as a
                // pair of icon buttons, highlight the selected one
                // with shadcn's `Default` variant (the styled
                // primary look) and leave the other on `Ghost`.
                //
                // Pen has D5's "click-when-already-active opens the
                // brush-size popover" semantics. Capture the
                // Response (not just `.clicked()`) so we can both
                // branch on tool state AND anchor the popover to
                // the button's rect after the toolbar closure exits.
                let pen_active = state.current_tool == ToolMode::Pen;
                let pen_response = shadcn_icon_button_response(
                    ui,
                    shadcn,
                    &paint_pen,
                    "Pen",
                    variant_for(pen_active),
                    true,
                );
                pen_button_rect = pen_response.rect;
                if pen_response.clicked() {
                    if pen_active {
                        // Already on Pen → toggle the brush popover.
                        brush::toggle_open(ui.ctx(), brush_popover_id);
                    } else {
                        // First tap switches tools. Make sure no
                        // stale brush popover from a previous Pen
                        // session is left open.
                        actions.set_tool = Some(ToolMode::Pen);
                        brush::close(ui.ctx(), brush_popover_id);
                    }
                }

                let eraser_active = state.current_tool == ToolMode::Eraser;
                let eraser_response = shadcn_icon_button_response(
                    ui,
                    shadcn,
                    &paint_eraser,
                    "Erase",
                    variant_for(eraser_active),
                    true,
                );
                if eraser_response.clicked() && !eraser_active {
                    actions.set_tool = Some(ToolMode::Eraser);
                    // Switching to Eraser also dismisses the
                    // brush-size popover — its slider is
                    // pen-specific.
                    brush::close(ui.ctx(), brush_popover_id);
                }

                let finger_response = shadcn_icon_button_response(
                    ui,
                    shadcn,
                    if state.finger_drawing_allowed {
                        &paint_pointer
                    } else {
                        &paint_pointer_off
                    },
                    if state.finger_drawing_allowed {
                        "Finger drawing on"
                    } else {
                        "Finger drawing off"
                    },
                    variant_for(state.finger_drawing_allowed),
                    true,
                );
                if finger_response.clicked() {
                    actions.set_finger_drawing_allowed = Some(!state.finger_drawing_allowed);
                }

                if theme.dark {
                    let system_pages = state.page_theme_mode == InkPageThemeMode::System;
                    let page_theme_response = shadcn_icon_button_response(
                        ui,
                        shadcn,
                        if system_pages {
                            &paint_system_page
                        } else {
                            &paint_light_page
                        },
                        if system_pages {
                            "Ink pages follow system theme"
                        } else {
                            "Ink pages always light"
                        },
                        variant_for(system_pages),
                        true,
                    );
                    if page_theme_response.clicked() {
                        actions.set_page_theme_mode = Some(if system_pages {
                            InkPageThemeMode::Light
                        } else {
                            InkPageThemeMode::System
                        });
                    }
                }

                ui.separator();

                // Colour swatch — shadcn-popover anchored quick-
                // select grid. Lives between the tool buttons and
                // the action group to keep the "pen settings"
                // cluster visually grouped.
                color_picker::show(
                    ui,
                    shadcn,
                    color_popover_id,
                    state.current_color,
                    actions,
                    active_control_bounds,
                );

                ui.separator();

                // Undo / Redo greyed-out when the matching stack is
                // empty — egui-shadcn's `enabled` flag does the
                // visual treatment automatically.
                if shadcn_icon_button(
                    ui,
                    shadcn,
                    &paint_undo,
                    "Undo",
                    ButtonVariant::Ghost,
                    state.can_undo,
                ) {
                    actions.undo = true;
                }
                if shadcn_icon_button(
                    ui,
                    shadcn,
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
                    shadcn,
                    &paint_trash,
                    "Clear all",
                    ButtonVariant::Destructive,
                    true,
                ) {
                    actions.clear = true;
                }
            });
        });

    // Brush-size popover renders in its own top-level Area so it
    // can paint past the toolbar panel's clip rect. Anchored to the
    // Pen button's rect captured above. No-op when closed.
    brush::show_if_open(
        ctx,
        shadcn,
        brush::BrushPopover {
            id_source: brush_popover_id,
            trigger_rect: pen_button_rect,
            current_width: state.current_width,
            current_color: state.current_color,
            actions,
            active_control_bounds,
        },
    );
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
    shadcn_icon_button_response(ui, theme, painter, tooltip, variant, enabled).clicked()
}

/// Same as [`shadcn_icon_button`] but returns the raw `Response` so
/// the caller can inspect the button's rect (e.g. to anchor a
/// popover below it) and apply custom click logic (e.g. Pen's
/// "click-when-already-active opens brush picker" branch).
fn shadcn_icon_button_response(
    ui: &mut egui::Ui,
    theme: &ShadcnTheme,
    painter: &dyn Fn(&Painter, Pos2, f32, Color32),
    tooltip: &str,
    variant: ButtonVariant,
    enabled: bool,
) -> Response {
    Button::new("")
        .variant(variant)
        .size(ButtonSize::Icon)
        .enabled(enabled)
        .icon(painter)
        .show(ui, theme)
        .on_hover_text(tooltip)
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
        let galley = painter.layout_no_wrap(icon.unicode().to_string(), font_id, color);
        let pos = pos2(
            center.x - galley.rect.width() / 2.0,
            center.y - galley.rect.height() / 2.0,
        );
        painter.galley(pos, galley, color);
    }
}
