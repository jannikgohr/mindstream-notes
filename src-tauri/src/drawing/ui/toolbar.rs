//! The egui toolbar that lives at the top of the drawing surface.
//!
//! For now this is just Back + Clear buttons. As we add tools
//! (color picker, brush size, eraser, undo, page nav, …) each gets
//! its own submodule under `ui/` and is wired into the toolbar by
//! adding a call here.

use egui::{Color32, Frame, Margin, TopBottomPanel};

use super::RenderActions;

/// Visible height of the toolbar in pixels. Also used by the
/// render-thread touch routing to decide which gestures egui owns
/// (`y < TOOLBAR_HEIGHT_PX` → suppress stroke, drive egui only).
pub const TOOLBAR_HEIGHT_PX: f32 = 120.0;

/// Render the toolbar inside the supplied egui context. Mutates
/// `actions` rather than returning a value so future toolbar items
/// can append to the same struct without rewiring callers.
pub fn show(ctx: &egui::Context, pixels_per_point: f32, actions: &mut RenderActions) {
    let panel_height_pts = TOOLBAR_HEIGHT_PX / pixels_per_point;
    TopBottomPanel::top("drawing-toolbar")
        .exact_height(panel_height_pts)
        .frame(
            Frame::default()
                .fill(Color32::from_rgb(32, 32, 36))
                .inner_margin(Margin {
                    left: 12,
                    right: 12,
                    top: 8,
                    bottom: 8,
                }),
        )
        .show(ctx, |ui| {
            ui.horizontal(|ui| {
                if ui.button("← Back").clicked() {
                    actions.back = true;
                }
                if ui.button("Clear").clicked() {
                    actions.clear = true;
                }
            });
        });
}
