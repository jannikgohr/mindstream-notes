//! The egui toolbar that lives at the top of the drawing surface.
//!
//! Current layout: Pen | Eraser | (sep) | Undo | Redo | (sep) | Clear.
//! Icons are Lucide glyphs from the bundled `lucide-icons` TTF (B1);
//! the panel + button palette comes from
//! [`super::DrawingTheme`] (B2) which bridges the app's shadcn
//! design tokens — see `src/app.css` — into `egui::Visuals`.
//!
//! No Back button: the Svelte mobile header above the SurfaceView
//! already provides navigation and the in-egui copy was redundant.
//! The JNI surface for it (`platform::android::ui::call_back` /
//! `Drawing.backFromNative`) stays in place for a future re-wire.
//!
//! As we add tools (color picker, brush size, page nav, …) each gets
//! its own submodule under `ui/` and is wired into the toolbar by
//! adding a call here.

use egui::{Color32, CornerRadius, FontFamily, Frame, Margin, RichText, TopBottomPanel};
use lucide_icons::Icon;

use super::{DrawingTheme, RenderActions, ToolMode, UiState, LUCIDE_FAMILY};

/// Visible height of the toolbar in pixels. Also used by the
/// render-thread touch routing to decide which gestures egui owns
/// (`y < TOOLBAR_HEIGHT_PX` → suppress stroke, drive egui only).
pub const TOOLBAR_HEIGHT_PX: f32 = 120.0;

/// Glyph point-size for the Lucide icons inside each toolbar
/// button. Toolbar is 120 px / 2.5 PPP = 48 logical points; minus
/// 8 pt of vertical margin per side that leaves ~32 pt for the
/// button's content — 22 pt icon + small padding centres nicely.
const ICON_PT: f32 = 22.0;

/// Inner padding (left+right, top+bottom) the egui button puts
/// around its text. Picked so the touch target stays comfortably
/// above the Android 48 dp minimum once you factor in the 2.5×
/// PPP we render at.
const BUTTON_PADDING: egui::Vec2 = egui::vec2(12.0, 6.0);

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
            // Keep some breathing room between buttons; egui's default
            // spacing is tight enough that icons read as crammed.
            ui.spacing_mut().item_spacing = egui::vec2(6.0, 0.0);
            ui.spacing_mut().button_padding = BUTTON_PADDING;

            ui.horizontal_centered(|ui| {
                // Pen / Eraser toggle. `picked` is a local copy so
                // `selectable_value` can mutate it; we diff against
                // the authoritative `state.current_tool` to decide
                // whether to surface a `set_tool` action this frame.
                let mut picked = state.current_tool;
                tool_toggle(ui, &mut picked, ToolMode::Pen, Icon::Pen, "Pen");
                tool_toggle(ui, &mut picked, ToolMode::Eraser, Icon::Eraser, "Erase");
                if picked != state.current_tool {
                    actions.set_tool = Some(picked);
                }

                ui.separator();

                // Undo / Redo. `add_enabled` greys out the button
                // when the corresponding stack is empty so the user
                // can see there's nothing to do.
                if icon_button(ui, Icon::Undo, state.can_undo, "Undo").clicked() {
                    actions.undo = true;
                }
                if icon_button(ui, Icon::Redo, state.can_redo, "Redo").clicked() {
                    actions.redo = true;
                }

                ui.separator();

                // Clear uses the destructive `--destructive` token
                // from the theme (matches shadcn's red trash buttons
                // in the rest of the app).
                if destructive_icon_button(ui, theme, Icon::Trash2, "Clear all").clicked() {
                    actions.clear = true;
                }
            });
        });
}

/// A `selectable_label` rendered as a single Lucide glyph. When
/// `*current == target`, egui paints it with `selection.bg_fill`
/// (= the accent colour set in `DrawingTheme::to_visuals`).
fn tool_toggle(
    ui: &mut egui::Ui,
    current: &mut ToolMode,
    target: ToolMode,
    icon: Icon,
    tooltip: &str,
) {
    let selected = *current == target;
    let resp = ui
        .selectable_label(selected, icon_text(icon))
        .on_hover_text(tooltip);
    if resp.clicked() {
        *current = target;
    }
}

/// A standard (non-toggle) icon button. `enabled = false` greys it
/// out via egui's `add_enabled` so the user can see at a glance
/// that there's nothing to do (e.g. empty undo stack).
fn icon_button(
    ui: &mut egui::Ui,
    icon: Icon,
    enabled: bool,
    tooltip: &str,
) -> egui::Response {
    ui.add_enabled(enabled, egui::Button::new(icon_text(icon)))
        .on_hover_text(tooltip)
}

/// Icon button rendered with the theme's destructive (red) accent.
/// Used for Clear so it visually flags "this destroys data" — same
/// affordance shadcn's red ghost buttons have on the markdown side.
fn destructive_icon_button(
    ui: &mut egui::Ui,
    theme: &DrawingTheme,
    icon: Icon,
    tooltip: &str,
) -> egui::Response {
    // Approximate `--destructive` from `src/app.css`: light mode
    // `oklch(0.577 0.245 27.325)` ≈ #d4183d; dark mode
    // `oklch(0.396 0.141 25.723)` ≈ #7f1d1d. Both read as a
    // recognisable red without clashing with the Lucide icon.
    let bg = if theme.dark {
        Color32::from_rgb(127, 29, 29)
    } else {
        Color32::from_rgb(212, 24, 61)
    };
    let fg = Color32::from_rgb(250, 250, 250);
    let btn = egui::Button::new(icon_text(icon).color(fg))
        .fill(bg)
        .corner_radius(CornerRadius::same(6));
    ui.add(btn).on_hover_text(tooltip)
}

/// Build the `RichText` egui needs to render a Lucide icon: the
/// character at the icon's private-use unicode codepoint, styled
/// with the `LUCIDE_FAMILY` font family we loaded in `CanvasUi::new`.
fn icon_text(icon: Icon) -> RichText {
    RichText::new(char::from(icon).to_string())
        .family(FontFamily::Name(LUCIDE_FAMILY.into()))
        .size(ICON_PT)
}
