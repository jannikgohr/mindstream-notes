//! The egui toolbar that lives at the top of the drawing surface.
//!
//! Current layout: Back | Pen | Eraser | (sep) | Undo | Redo | Clear.
//! Text labels for now — B1 in the roadmap swaps them for Lucide-
//! style icons via `egui::include_image!`. As we add tools (color
//! picker, brush size, page nav, …) each gets its own submodule
//! under `ui/` and is wired into the toolbar by adding a call here.

use egui::{Color32, Frame, Margin, TopBottomPanel};

use super::{RenderActions, ToolMode, UiState};

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
    state: UiState,
    actions: &mut RenderActions,
) {
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

                ui.separator();

                // Pen / Eraser toggle. `selectable_value` mutates
                // the local copy on click; we diff against the
                // authoritative `state.current_tool` to decide
                // whether to surface a `set_tool` action. (Avoids
                // emitting `set_tool` on every frame the active
                // tool is selected.)
                let mut picked = state.current_tool;
                ui.selectable_value(&mut picked, ToolMode::Pen, "Pen");
                ui.selectable_value(&mut picked, ToolMode::Eraser, "Erase");
                if picked != state.current_tool {
                    actions.set_tool = Some(picked);
                }

                ui.separator();

                // Undo / Redo. `add_enabled` greys out the button
                // when the corresponding stack is empty so the user
                // can see there's nothing to do.
                if ui
                    .add_enabled(state.can_undo, egui::Button::new("Undo"))
                    .clicked()
                {
                    actions.undo = true;
                }
                if ui
                    .add_enabled(state.can_redo, egui::Button::new("Redo"))
                    .clicked()
                {
                    actions.redo = true;
                }

                ui.separator();

                if ui.button("Clear").clicked() {
                    actions.clear = true;
                }
            });
        });
}
