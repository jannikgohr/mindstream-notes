//! The egui toolbar that lives at the top of the drawing surface.
//!
//! Current layout: Pen | Eraser | (sep) | Undo | Redo | (sep) | Clear.
//! Built on `egui-shadcn` for the actual button widgets (Radix/shadcn
//! variants, sizes, hover/focus animation) and on `lucide-icons` for
//! the glyphs (loaded as a custom font family by `CanvasUi::new`).
//!
//! No Back button: the Svelte mobile header above the SurfaceView
//! already provides navigation and the in-egui copy was redundant.
//! The JNI surface (`platform::android::ui::call_back` /
//! `Drawing.backFromNative`) stays in place for a future re-wire.
//!
//! As we add tools (color picker, brush size, page nav, …) each gets
//! its own submodule under `ui/` and is wired into the toolbar by
//! adding a call here. Sliders + color picker can drop in via
//! `egui_shadcn::slider` / `egui_shadcn::popover` when D5 lands.

use egui::{FontFamily, Frame, Margin, RichText, TopBottomPanel, WidgetText};
use egui_shadcn::tokens::{ControlSize, ControlVariant};
use egui_shadcn::{button, Theme as ShadcnTheme};
use lucide_icons::Icon;

use super::{DrawingTheme, RenderActions, ToolMode, UiState, LUCIDE_FAMILY};

/// Visible height of the toolbar in pixels. Also used by the
/// render-thread touch routing to decide which gestures egui owns
/// (`y < TOOLBAR_HEIGHT_PX` → suppress stroke, drive egui only).
pub const TOOLBAR_HEIGHT_PX: f32 = 120.0;

/// Glyph point-size for the Lucide icons inside each toolbar
/// button. Toolbar is 120 px / 2.5 PPP = 48 logical points; minus
/// 8 pt of vertical margin per side that leaves ~32 pt for the
/// button's content — 22 pt icon sits centred with comfortable
/// padding above and below.
const ICON_PT: f32 = 22.0;

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
                // Pen / Eraser are mutually exclusive — render as
                // pair of icon buttons, highlight the selected one
                // with shadcn's `Primary` variant and leave the
                // other on `Ghost`. Click switches.
                tool_button(
                    ui,
                    &shadcn,
                    Icon::Pen,
                    "Pen",
                    state.current_tool == ToolMode::Pen,
                    || actions.set_tool = Some(ToolMode::Pen),
                );
                tool_button(
                    ui,
                    &shadcn,
                    Icon::Eraser,
                    "Erase",
                    state.current_tool == ToolMode::Eraser,
                    || actions.set_tool = Some(ToolMode::Eraser),
                );

                ui.separator();

                // Undo / Redo greyed-out when the matching stack is
                // empty — egui-shadcn's `enabled` flag does the
                // visual treatment automatically.
                if shadcn_icon_button(
                    ui,
                    &shadcn,
                    Icon::Undo,
                    "Undo",
                    ControlVariant::Ghost,
                    state.can_undo,
                ) {
                    actions.undo = true;
                }
                if shadcn_icon_button(
                    ui,
                    &shadcn,
                    Icon::Redo,
                    "Redo",
                    ControlVariant::Ghost,
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
                    Icon::Trash2,
                    "Clear all",
                    ControlVariant::Destructive,
                    true,
                ) {
                    actions.clear = true;
                }
            });
        });
}

/// A Pen/Eraser-style toggle button: rendered as a shadcn `Primary`
/// when active, `Ghost` when not. Fires `on_pick` only when the
/// user clicks while it is *not* already selected, mirroring the
/// pre-shadcn `selectable_value` behaviour. Tooltip on hover comes
/// from `tooltip` — the icon itself is unlabeled.
fn tool_button(
    ui: &mut egui::Ui,
    theme: &ShadcnTheme,
    icon: Icon,
    tooltip: &str,
    active: bool,
    on_pick: impl FnOnce(),
) {
    let variant = if active {
        ControlVariant::Primary
    } else {
        ControlVariant::Ghost
    };
    let resp = button(
        ui,
        theme,
        icon_text(icon),
        variant,
        ControlSize::Icon,
        true,
    )
    .on_hover_text(tooltip);
    if resp.clicked() && !active {
        on_pick();
    }
}

/// Plain shadcn icon button — returns `true` on the frame the user
/// clicked it. Wraps egui-shadcn's `button()` with a hover tooltip
/// and the LUCIDE_FAMILY text styling so callers stay one-liners.
fn shadcn_icon_button(
    ui: &mut egui::Ui,
    theme: &ShadcnTheme,
    icon: Icon,
    tooltip: &str,
    variant: ControlVariant,
    enabled: bool,
) -> bool {
    button(
        ui,
        theme,
        icon_text(icon),
        variant,
        ControlSize::Icon,
        enabled,
    )
    .on_hover_text(tooltip)
    .clicked()
}

/// Build the `WidgetText` egui needs to render a Lucide icon: the
/// character at the icon's private-use unicode codepoint, styled
/// with the `LUCIDE_FAMILY` font family registered in
/// `CanvasUi::new`. The size is `ICON_PT` regardless of the
/// shadcn button size — `ControlSize::Icon` controls padding and
/// the surrounding box, not the inner glyph.
///
/// Uses `Icon::unicode()` rather than `char::from(icon)` because
/// the latter `From` impl only landed in `lucide-icons 0.557+`;
/// our 0.555 pin (matching egui-shadcn 0.3.1's transitive) still
/// exposes the codepoint through the method.
fn icon_text(icon: Icon) -> WidgetText {
    RichText::new(icon.unicode().to_string())
        .family(FontFamily::Name(LUCIDE_FAMILY.into()))
        .size(ICON_PT)
        .into()
}
