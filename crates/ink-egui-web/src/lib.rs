use std::collections::HashSet;

use eframe::egui;
use ink_core::page::{DocumentLayout, MIN_PAGE_COUNT};
use ink_core::strokes_doc::{StrokesDoc, DEFAULT_COLOR, DEFAULT_WIDTH};
use ink_core::ui::{CanvasUi, DrawingTheme, InkPageThemeMode, ToolMode, UiState};
use js_sys::{Function, Object, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;

const PAGE_FILL_COLOR: u32 = 0xFFFF_FFFF;
const PAGE_BACKGROUND_COLOR: u32 = 0xFFF1_F2F4;
const PAGE_BORDER_COLOR: u32 = 0xFFE5_E7EB;
const PAGE_SHADOW_COLOR: u32 = 0x2200_0000;
const PAGE_DARK_SHADOW_COLOR: u32 = 0x33FF_FFFF;
const KEYBOARD_PAN_STEP: f32 = 80.0;
const KEYBOARD_PAN_STEP_LARGE: f32 = 320.0;
const ZOOM_STEP: f32 = 1.2;

#[wasm_bindgen]
#[derive(Clone)]
pub struct WebInkHandle {
    runner: eframe::WebRunner,
}

#[wasm_bindgen]
impl WebInkHandle {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        eframe::WebLogger::init(log::LevelFilter::Debug).ok();
        Self {
            runner: eframe::WebRunner::new(),
        }
    }

    #[wasm_bindgen]
    pub async fn start(
        &self,
        canvas: web_sys::HtmlCanvasElement,
        initial_state: Vec<u8>,
        initial_toolbar_settings: JsValue,
        on_change: Function,
        on_toolbar_settings: Function,
        on_collab_update: Function,
    ) -> Result<(), JsValue> {
        let toolbar_settings = ToolbarSettings::from_js(&initial_toolbar_settings);
        self.runner
            .start(
                canvas,
                eframe::WebOptions::default(),
                Box::new(move |cc| {
                    Ok(Box::new(InkWebApp::new(
                        initial_state.clone(),
                        toolbar_settings,
                        on_change.clone(),
                        on_toolbar_settings.clone(),
                        on_collab_update.clone(),
                        &cc.egui_ctx,
                    )))
                }),
            )
            .await
    }

    #[wasm_bindgen]
    pub fn destroy(&self) {
        self.runner.destroy();
    }

    #[wasm_bindgen]
    pub fn encode_state_vector(&self) -> Vec<u8> {
        self.runner
            .app_mut::<InkWebApp>()
            .map(|app| app.doc.encode_state_vector())
            .unwrap_or_default()
    }

    #[wasm_bindgen]
    pub fn encode_diff_for_state_vector(&self, state_vector: Vec<u8>) -> Vec<u8> {
        self.runner
            .app_mut::<InkWebApp>()
            .and_then(|app| app.doc.encode_diff_for_state_vector(&state_vector))
            .unwrap_or_default()
    }

    #[wasm_bindgen]
    pub fn apply_remote_update(&self, update: Vec<u8>) -> bool {
        self.runner
            .app_mut::<InkWebApp>()
            .is_some_and(|mut app| app.apply_remote_update(&update))
    }
}

impl Default for WebInkHandle {
    fn default() -> Self {
        Self::new()
    }
}

struct InkWebApp {
    doc: StrokesDoc,
    strokes: Vec<Stroke>,
    view: View,
    canvas_ui: CanvasUi,
    drawing_theme: DrawingTheme,
    tool: ToolMode,
    finger_drawing_allowed: bool,
    page_theme_mode: InkPageThemeMode,
    color: u32,
    width: f32,
    in_flight: Vec<egui::Pos2>,
    drawing: bool,
    eraser_drag_hits: HashSet<String>,
    eraser_drag_active: bool,
    desktop_pan_active: bool,
    touch_view_active: bool,
    undo: Vec<UndoOp>,
    redo: Vec<UndoOp>,
    on_change: Function,
    on_toolbar_settings: Function,
    on_collab_update: Function,
    egui_ctx: egui::Context,
}

impl InkWebApp {
    fn new(
        initial_state: Vec<u8>,
        toolbar_settings: ToolbarSettings,
        on_change: Function,
        on_toolbar_settings: Function,
        on_collab_update: Function,
        egui_ctx: &egui::Context,
    ) -> Self {
        let doc = StrokesDoc::from_bytes(&initial_state);
        let strokes = visible_strokes(&doc);
        let page_count = page_count_for_strokes(&strokes);
        let mut canvas_ui = CanvasUi::new();
        canvas_ui.prepare_embedded(egui_ctx);
        Self {
            doc,
            strokes,
            view: View::new(page_count),
            canvas_ui,
            drawing_theme: DrawingTheme::dark(),
            tool: toolbar_settings.tool,
            finger_drawing_allowed: toolbar_settings.finger_drawing_allowed,
            page_theme_mode: toolbar_settings.page_theme_mode,
            color: toolbar_settings.color,
            width: toolbar_settings.width,
            in_flight: Vec::new(),
            drawing: false,
            eraser_drag_hits: HashSet::new(),
            eraser_drag_active: false,
            desktop_pan_active: false,
            touch_view_active: false,
            undo: Vec::new(),
            redo: Vec::new(),
            on_change,
            on_toolbar_settings,
            on_collab_update,
            egui_ctx: egui_ctx.clone(),
        }
    }

    fn refresh_strokes(&mut self) {
        self.strokes = visible_strokes(&self.doc);
        self.view
            .set_page_count(page_count_for_strokes(&self.strokes));
    }

    fn emit_change(&self) {
        let bytes = self.doc.encode();
        let array = Uint8Array::from(bytes.as_slice());
        let _ = self.on_change.call1(&JsValue::NULL, &array);
    }

    fn emit_collab_update(&self, update: Option<Vec<u8>>) {
        let Some(update) = update.filter(|update| !update.is_empty()) else {
            return;
        };
        let array = Uint8Array::from(update.as_slice());
        let _ = self.on_collab_update.call1(&JsValue::NULL, &array);
    }

    fn apply_remote_update(&mut self, update: &[u8]) -> bool {
        if !self.doc.apply_update(update) {
            return false;
        }
        self.refresh_strokes();
        self.cancel_in_flight_stroke();
        self.finish_eraser_drag(false);
        self.emit_change();
        self.egui_ctx.request_repaint();
        true
    }

    fn emit_toolbar_settings(&self) {
        let payload = Object::new();
        let _ = Reflect::set(
            &payload,
            &JsValue::from_str("tool"),
            &JsValue::from_str(tool_to_setting(self.tool)),
        );
        let _ = Reflect::set(
            &payload,
            &JsValue::from_str("colorArgb"),
            &JsValue::from_f64(self.color as f64),
        );
        let _ = Reflect::set(
            &payload,
            &JsValue::from_str("width"),
            &JsValue::from_f64(self.width as f64),
        );
        let _ = Reflect::set(
            &payload,
            &JsValue::from_str("fingerDrawingAllowed"),
            &JsValue::from_bool(self.finger_drawing_allowed),
        );
        let _ = Reflect::set(
            &payload,
            &JsValue::from_str("pageThemeMode"),
            &JsValue::from_str(page_theme_to_setting(self.page_theme_mode)),
        );
        let _ = self
            .on_toolbar_settings
            .call1(&JsValue::NULL, payload.as_ref());
    }

    fn show_toolbar(&mut self, ctx: &egui::Context) {
        let actions = self.canvas_ui.show_embedded(
            ctx,
            UiState {
                current_tool: self.tool,
                finger_drawing_allowed: self.finger_drawing_allowed,
                page_theme_mode: self.page_theme_mode,
                can_undo: !self.undo.is_empty(),
                can_redo: !self.redo.is_empty(),
                current_color: self.color,
                current_width: self.width,
            },
        );
        self.apply_toolbar_actions(actions);
    }

    fn apply_toolbar_actions(&mut self, actions: ink_core::ui::RenderActions) {
        let mut doc_changed = false;
        let mut toolbar_changed = false;
        if let Some(tool) = actions.set_tool {
            if self.tool != tool {
                self.tool = tool;
                toolbar_changed = true;
            }
        }
        if let Some(allowed) = actions.set_finger_drawing_allowed {
            if self.finger_drawing_allowed != allowed {
                self.finger_drawing_allowed = allowed;
                toolbar_changed = true;
            }
        }
        if let Some(mode) = actions.set_page_theme_mode {
            if self.page_theme_mode != mode {
                self.page_theme_mode = mode;
                toolbar_changed = true;
            }
        }
        if let Some(color) = actions.set_color {
            if self.color != color {
                self.color = color;
                toolbar_changed = true;
            }
        }
        if let Some(width) = actions.set_width {
            if (self.width - width).abs() > f32::EPSILON {
                self.width = width;
                toolbar_changed = true;
            }
        }
        if actions.clear {
            let cleared: Vec<String> = self
                .strokes
                .iter()
                .map(|stroke| stroke.id.clone())
                .collect();
            let (_, update) = self
                .doc
                .transact_local_update(|strokes| strokes.tombstone_all());
            self.refresh_strokes();
            self.cancel_in_flight_stroke();
            self.finish_eraser_drag(false);
            if !cleared.is_empty() {
                self.record_op(UndoOp::ClearAll(cleared));
            }
            self.emit_collab_update(update);
            doc_changed = true;
        }
        if actions.undo {
            doc_changed |= self.undo();
        }
        if actions.redo {
            doc_changed |= self.redo();
        }
        if toolbar_changed {
            self.emit_toolbar_settings();
        }
        if doc_changed {
            self.emit_change();
        }
    }

    fn handle_canvas_input(&mut self, response: &egui::Response, ctx: &egui::Context) {
        self.handle_keyboard_navigation(ctx);

        if self.handle_touch_view_gesture(response, ctx) {
            return;
        }

        self.handle_scroll_navigation(response, ctx);

        if self.handle_desktop_drag_pan(response, ctx) {
            return;
        }

        let pointer_down = ctx.input(|i| i.pointer.primary_down());
        let Some(pos) = response.interact_pointer_pos() else {
            if self.drawing && !pointer_down {
                self.finish_stroke();
            }
            if self.eraser_drag_active && !pointer_down {
                self.finish_eraser_drag(true);
            }
            return;
        };

        if self.tool == ToolMode::Eraser {
            if pointer_down && response.drag_started() {
                self.begin_eraser_drag();
            }
            if pointer_down && (response.dragged() || response.drag_started()) {
                if let Some(page_pos) = self.view.screen_to_page(pos) {
                    let erased = self.erase_at(page_pos, 10.0);
                    if !erased.is_empty() {
                        self.eraser_drag_hits.extend(erased);
                        self.refresh_strokes();
                        self.emit_change();
                    }
                }
            }
            if self.eraser_drag_active && !pointer_down {
                self.finish_eraser_drag(true);
            }
            return;
        }

        if self.tool != ToolMode::Pen {
            return;
        }

        if pointer_down && response.drag_started() {
            self.begin_stroke(pos);
        } else if pointer_down && self.drawing {
            self.push_stroke_point(pos);
        } else if self.drawing && !pointer_down {
            self.finish_stroke();
        }
    }

    fn handle_keyboard_navigation(&mut self, ctx: &egui::Context) {
        let command_action = ctx.input(|i| {
            if !i.modifiers.command {
                return None;
            }
            if i.key_pressed(egui::Key::Plus) || i.key_pressed(egui::Key::Equals) {
                Some(CommandAction::ZoomIn)
            } else if i.key_pressed(egui::Key::Minus) {
                Some(CommandAction::ZoomOut)
            } else if i.key_pressed(egui::Key::Num0) {
                Some(CommandAction::FitWidth)
            } else if i.key_pressed(egui::Key::Num1) {
                Some(CommandAction::Zoom100)
            } else {
                None
            }
        });

        if let Some(action) = command_action {
            self.cancel_in_flight_stroke();
            self.finish_eraser_drag(true);
            match action {
                CommandAction::ZoomIn => self.view.zoom_around(self.view.center(), ZOOM_STEP),
                CommandAction::ZoomOut => {
                    self.view.zoom_around(self.view.center(), 1.0 / ZOOM_STEP)
                }
                CommandAction::FitWidth => self.view.fit_page_width(),
                CommandAction::Zoom100 => self.view.set_zoom_100(),
            }
        }

        let (pan, jump) = ctx.input(|i| {
            let step = if i.modifiers.shift {
                KEYBOARD_PAN_STEP_LARGE
            } else {
                KEYBOARD_PAN_STEP
            };
            let mut pan = egui::Vec2::ZERO;
            if i.key_pressed(egui::Key::ArrowLeft) {
                pan.x += step;
            }
            if i.key_pressed(egui::Key::ArrowRight) {
                pan.x -= step;
            }
            if i.key_pressed(egui::Key::ArrowUp) {
                pan.y += step;
            }
            if i.key_pressed(egui::Key::ArrowDown) {
                pan.y -= step;
            }
            if i.key_pressed(egui::Key::PageUp) {
                pan.y += self.view.surface.y * 0.85;
            }
            if i.key_pressed(egui::Key::PageDown) {
                pan.y -= self.view.surface.y * 0.85;
            }

            let jump = if i.key_pressed(egui::Key::Home) {
                Some(DocumentJump::Top)
            } else if i.key_pressed(egui::Key::End) {
                Some(DocumentJump::Bottom)
            } else {
                None
            };
            (pan, jump)
        });

        if pan != egui::Vec2::ZERO {
            self.cancel_in_flight_stroke();
            self.finish_eraser_drag(true);
            self.view.pan_by(pan.x, pan.y);
        }
        if let Some(jump) = jump {
            self.cancel_in_flight_stroke();
            self.finish_eraser_drag(true);
            match jump {
                DocumentJump::Top => self.view.scroll_to_top(),
                DocumentJump::Bottom => self.view.scroll_to_bottom(),
            }
        }
    }

    fn handle_scroll_navigation(&mut self, response: &egui::Response, ctx: &egui::Context) {
        let (scroll, modifiers, hover_pos, zoom_delta) = ctx.input(|i| {
            (
                i.smooth_scroll_delta,
                i.modifiers,
                i.pointer.hover_pos(),
                i.zoom_delta(),
            )
        });
        let Some(hover_pos) = hover_pos.filter(|pos| response.rect.contains(*pos)) else {
            return;
        };

        if zoom_delta.is_finite() && zoom_delta > 0.0 && (zoom_delta - 1.0).abs() > 0.001 {
            self.cancel_in_flight_stroke();
            self.finish_eraser_drag(true);
            self.view.zoom_around(hover_pos, zoom_delta);
            return;
        }

        if scroll == egui::Vec2::ZERO || !vec2_is_finite(scroll) {
            return;
        }

        self.cancel_in_flight_stroke();
        self.finish_eraser_drag(true);
        if modifiers.command || modifiers.ctrl {
            let factor = (1.0_f32 + scroll.y * 0.001).clamp(0.75, 1.25);
            self.view.zoom_around(hover_pos, factor);
        } else if modifiers.shift {
            self.view.pan_by(scroll.x + scroll.y, 0.0);
        } else {
            self.view.pan_by(scroll.x, scroll.y);
        }
    }

    fn handle_desktop_drag_pan(&mut self, response: &egui::Response, ctx: &egui::Context) -> bool {
        let (middle_down, primary_down, space_down, pointer_pos, hover_pos, delta) =
            ctx.input(|i| {
                (
                    i.pointer.button_down(egui::PointerButton::Middle),
                    i.pointer.primary_down(),
                    i.key_down(egui::Key::Space),
                    i.pointer.interact_pos(),
                    i.pointer.hover_pos(),
                    i.pointer.delta(),
                )
            });
        let pan_down = middle_down || (space_down && primary_down);
        let pointer_on_canvas = pointer_pos
            .or(hover_pos)
            .is_some_and(|pos| response.rect.contains(pos));
        if pan_down && (self.desktop_pan_active || pointer_on_canvas) {
            self.desktop_pan_active = true;
            self.cancel_in_flight_stroke();
            self.finish_eraser_drag(true);
            if delta != egui::Vec2::ZERO && vec2_is_finite(delta) {
                self.view.pan_by(delta.x, delta.y);
            }
            return true;
        }
        self.desktop_pan_active = false;
        false
    }

    fn handle_touch_view_gesture(
        &mut self,
        response: &egui::Response,
        ctx: &egui::Context,
    ) -> bool {
        let has_touch_input = ctx.input(|i| {
            i.any_touches()
                || i.events
                    .iter()
                    .any(|event| matches!(event, egui::Event::Touch { .. }))
        });
        if !has_touch_input {
            self.touch_view_active = false;
            return false;
        }

        let multi_touch = ctx.input(|i| i.multi_touch());
        if let Some(touch) = multi_touch {
            if response.rect.contains(touch.center_pos) || response.rect.contains(touch.start_pos) {
                self.touch_view_active = true;
                self.cancel_in_flight_stroke();
                self.finish_eraser_drag(true);
                if touch.translation_delta != egui::Vec2::ZERO
                    && vec2_is_finite(touch.translation_delta)
                {
                    self.view
                        .pan_by(touch.translation_delta.x, touch.translation_delta.y);
                }
                if touch.zoom_delta.is_finite()
                    && touch.zoom_delta > 0.0
                    && (touch.zoom_delta - 1.0).abs() > 0.001
                {
                    self.view.zoom_around(touch.center_pos, touch.zoom_delta);
                }
                return true;
            }
        }

        let (touch_pan, delta) = ctx.input(|i| {
            let delta = i.pointer.delta();
            (
                (self.touch_view_active
                    || i.pointer
                        .interact_pos()
                        .is_some_and(|pos| response.rect.contains(pos)))
                    && i.any_touches()
                    && !self.finger_drawing_allowed
                    && i.pointer.primary_down()
                    && delta != egui::Vec2::ZERO,
                delta,
            )
        });
        if touch_pan {
            self.touch_view_active = true;
            self.cancel_in_flight_stroke();
            self.finish_eraser_drag(true);
            if vec2_is_finite(delta) {
                self.view.pan_by(delta.x, delta.y);
            }
            return true;
        }

        self.touch_view_active = false;
        false
    }

    fn begin_stroke(&mut self, pos: egui::Pos2) {
        let Some(page_pos) = self.view.screen_to_page(pos) else {
            return;
        };
        self.doc.begin_stroke(self.color, self.width);
        self.doc.push_point(page_pos.x, page_pos.y, 1.0);
        self.in_flight.clear();
        self.in_flight.push(page_pos);
        self.drawing = true;
    }

    fn push_stroke_point(&mut self, pos: egui::Pos2) {
        let Some(page_pos) = self.view.screen_to_page(pos) else {
            return;
        };
        if self
            .in_flight
            .last()
            .is_some_and(|last| last.distance(page_pos) < 1.5)
        {
            return;
        }
        self.doc.push_point(page_pos.x, page_pos.y, 1.0);
        self.in_flight.push(page_pos);
    }

    fn finish_stroke(&mut self) {
        self.drawing = false;
        self.in_flight.clear();
        let (id, update) = self
            .doc
            .transact_local_update(|strokes| strokes.end_stroke());
        if let Some(id) = id {
            self.record_op(UndoOp::StrokeAdded(id));
            self.refresh_strokes();
            self.emit_collab_update(update);
            self.emit_change();
        }
    }

    fn cancel_in_flight_stroke(&mut self) {
        self.drawing = false;
        self.in_flight.clear();
        self.doc.cancel_stroke();
    }

    fn begin_eraser_drag(&mut self) {
        self.eraser_drag_hits.clear();
        self.eraser_drag_active = true;
    }

    fn finish_eraser_drag(&mut self, record: bool) {
        if record && !self.eraser_drag_hits.is_empty() {
            let mut ids: Vec<String> = self.eraser_drag_hits.iter().cloned().collect();
            ids.sort();
            self.record_op(UndoOp::EraserDrag(ids));
        }
        self.eraser_drag_hits.clear();
        self.eraser_drag_active = false;
    }

    fn record_op(&mut self, op: UndoOp) {
        self.undo.push(op);
        self.redo.clear();
    }

    fn undo(&mut self) -> bool {
        let Some(op) = self.undo.pop() else {
            return false;
        };
        let update = self.apply_undo_op(&op);
        self.redo.push(op);
        self.emit_collab_update(update);
        true
    }

    fn redo(&mut self) -> bool {
        let Some(op) = self.redo.pop() else {
            return false;
        };
        let update = self.apply_redo_op(&op);
        self.undo.push(op);
        self.emit_collab_update(update);
        true
    }

    fn apply_undo_op(&mut self, op: &UndoOp) -> Option<Vec<u8>> {
        let (_, update) = self.doc.transact_local_update(|doc| match op {
            UndoOp::StrokeAdded(id) => {
                doc.set_stroke_tombstoned(id, true);
            }
            UndoOp::EraserDrag(ids) | UndoOp::ClearAll(ids) => {
                for id in ids {
                    doc.set_stroke_tombstoned(id, false);
                }
            }
        });
        self.refresh_strokes();
        self.cancel_in_flight_stroke();
        self.finish_eraser_drag(false);
        update
    }

    fn apply_redo_op(&mut self, op: &UndoOp) -> Option<Vec<u8>> {
        let (_, update) = self.doc.transact_local_update(|doc| match op {
            UndoOp::StrokeAdded(id) => {
                doc.set_stroke_tombstoned(id, false);
            }
            UndoOp::EraserDrag(ids) | UndoOp::ClearAll(ids) => {
                for id in ids {
                    doc.set_stroke_tombstoned(id, true);
                }
            }
        });
        self.refresh_strokes();
        self.cancel_in_flight_stroke();
        self.finish_eraser_drag(false);
        update
    }

    fn erase_at(&mut self, page_pos: egui::Pos2, radius: f32) -> Vec<String> {
        let ids: HashSet<String> = self
            .strokes
            .iter()
            .filter(|stroke| stroke_hits(stroke, page_pos, radius))
            .map(|stroke| stroke.id.clone())
            .collect();
        let (count, update) = self
            .doc
            .transact_local_update(|doc| doc.tombstone_strokes(&ids));
        if count > 0 {
            self.emit_collab_update(update);
            ids.into_iter().collect()
        } else {
            Vec::new()
        }
    }

    fn paint_canvas(&self, painter: &egui::Painter, rect: egui::Rect) {
        let page_dark = self.page_dark();
        painter.rect_filled(
            rect,
            0.0,
            color32_from_argb(display_color_argb(PAGE_BACKGROUND_COLOR, page_dark)),
        );
        for page in 0..self.view.layout.page_count {
            let Some([left, top, right, bottom]) = self.view.layout.page_rect(page) else {
                continue;
            };
            let min = self.view.page_to_screen(egui::pos2(left, top));
            let max = self.view.page_to_screen(egui::pos2(right, bottom));
            let page_rect = egui::Rect::from_min_max(min, max);
            painter.rect_filled(
                page_rect.translate(egui::vec2(0.0, 2.0)),
                2.0,
                color32_from_argb(if page_dark {
                    PAGE_DARK_SHADOW_COLOR
                } else {
                    PAGE_SHADOW_COLOR
                }),
            );
            painter.rect_filled(
                page_rect,
                2.0,
                color32_from_argb(display_color_argb(PAGE_FILL_COLOR, page_dark)),
            );
            painter.rect_stroke(
                page_rect,
                2.0,
                egui::Stroke::new(
                    1.0,
                    color32_from_argb(display_color_argb(PAGE_BORDER_COLOR, page_dark)),
                ),
                egui::StrokeKind::Outside,
            );
        }

        for stroke in &self.strokes {
            paint_polyline(
                painter,
                &self.view,
                &stroke.points,
                display_color_argb(stroke.color, page_dark),
                stroke.width,
            );
        }
        paint_polyline(
            painter,
            &self.view,
            &self.in_flight,
            display_color_argb(self.color, page_dark),
            self.width,
        );
    }

    fn page_dark(&self) -> bool {
        matches!(self.page_theme_mode, InkPageThemeMode::System) && self.drawing_theme.dark
    }
}

impl eframe::App for InkWebApp {
    fn as_any_mut(&mut self) -> Option<&mut dyn std::any::Any> {
        Some(self)
    }

    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.show_toolbar(ctx);
        egui::CentralPanel::default()
            .frame(egui::Frame::NONE)
            .show(ctx, |ui| {
                let size = ui.available_size();
                self.view.set_surface(size.x, size.y);
                let (response, painter) = ui.allocate_painter(size, egui::Sense::click_and_drag());
                self.handle_canvas_input(&response, ctx);
                self.paint_canvas(&painter, response.rect);
            });
    }
}

#[derive(Clone, Copy)]
struct ToolbarSettings {
    tool: ToolMode,
    finger_drawing_allowed: bool,
    page_theme_mode: InkPageThemeMode,
    color: u32,
    width: f32,
}

#[derive(Debug, Clone, Copy)]
enum DocumentJump {
    Top,
    Bottom,
}

#[derive(Debug, Clone, Copy)]
enum CommandAction {
    ZoomIn,
    ZoomOut,
    FitWidth,
    Zoom100,
}

#[derive(Debug, Clone)]
enum UndoOp {
    StrokeAdded(String),
    EraserDrag(Vec<String>),
    ClearAll(Vec<String>),
}

impl ToolbarSettings {
    fn from_js(value: &JsValue) -> Self {
        Self {
            tool: read_string(value, "tool")
                .as_deref()
                .and_then(tool_from_setting)
                .unwrap_or(ToolMode::Pen),
            finger_drawing_allowed: read_bool(value, "fingerDrawingAllowed").unwrap_or(true),
            page_theme_mode: read_string(value, "pageThemeMode")
                .as_deref()
                .and_then(page_theme_from_setting)
                .unwrap_or(InkPageThemeMode::Light),
            color: read_number(value, "colorArgb")
                .map(|n| n as u32)
                .unwrap_or(DEFAULT_COLOR),
            width: read_number(value, "width")
                .map(|n| n as f32)
                .filter(|n| n.is_finite())
                .map(|n| n.clamp(0.5, 12.0))
                .unwrap_or(DEFAULT_WIDTH),
        }
    }
}

#[derive(Clone)]
struct Stroke {
    id: String,
    color: u32,
    width: f32,
    points: Vec<egui::Pos2>,
}

#[derive(Clone)]
struct View {
    surface: egui::Vec2,
    scale: f32,
    pan: egui::Vec2,
    layout: DocumentLayout,
}

impl View {
    fn new(page_count: u32) -> Self {
        Self {
            surface: egui::vec2(1.0, 1.0),
            scale: 1.0,
            pan: egui::vec2(0.0, 0.0),
            layout: DocumentLayout::default_pages(page_count),
        }
    }

    fn set_page_count(&mut self, page_count: u32) {
        self.layout = DocumentLayout::default_pages(page_count);
        self.clamp();
    }

    fn set_surface(&mut self, w: f32, h: f32) {
        let old = self.surface;
        self.surface = egui::vec2(w.max(1.0), h.max(1.0));
        if old.x <= 1.0 && old.y <= 1.0 {
            self.scale = self.min_scale();
            self.pan.x = (self.surface.x - self.layout.page.width * self.scale) * 0.5;
            self.pan.y = self.layout.page_gap * self.scale;
        }
        self.clamp();
    }

    fn min_scale(&self) -> f32 {
        (self.surface.x / self.layout.page.width)
            .min(self.surface.y / self.layout.page.height)
            .max(0.05)
    }

    fn page_to_screen(&self, p: egui::Pos2) -> egui::Pos2 {
        egui::pos2(p.x * self.scale + self.pan.x, p.y * self.scale + self.pan.y)
    }

    fn screen_to_page(&self, p: egui::Pos2) -> Option<egui::Pos2> {
        let page = egui::pos2(
            (p.x - self.pan.x) / self.scale,
            (p.y - self.pan.y) / self.scale,
        );
        self.layout
            .contains_page_point(page.x, page.y)
            .then_some(page)
    }

    fn pan_by(&mut self, dx: f32, dy: f32) {
        if !dx.is_finite() || !dy.is_finite() {
            return;
        }
        self.pan += egui::vec2(dx, dy);
        self.clamp();
    }

    fn zoom_around(&mut self, focus: egui::Pos2, factor: f32) {
        if !focus.x.is_finite()
            || !focus.y.is_finite()
            || !factor.is_finite()
            || factor <= 0.0
            || !self.scale.is_finite()
        {
            return;
        }
        let before = egui::pos2(
            (focus.x - self.pan.x) / self.scale,
            (focus.y - self.pan.y) / self.scale,
        );
        self.scale = (self.scale * factor).clamp(self.min_scale(), self.min_scale() * 6.0);
        self.pan = egui::vec2(
            focus.x - before.x * self.scale,
            focus.y - before.y * self.scale,
        );
        self.clamp();
    }

    fn center(&self) -> egui::Pos2 {
        egui::pos2(self.surface.x * 0.5, self.surface.y * 0.5)
    }

    fn fit_page_width(&mut self) {
        let target_width = (self.surface.x - 32.0).max(1.0);
        self.scale =
            (target_width / self.layout.page.width).clamp(self.min_scale(), self.max_scale());
        self.pan.x = (self.surface.x - self.layout.page.width * self.scale) * 0.5;
        self.pan.y = self.layout.page_gap * self.scale;
        self.clamp();
    }

    fn set_zoom_100(&mut self) {
        let focus = self.center();
        let before = egui::pos2(
            (focus.x - self.pan.x) / self.scale,
            (focus.y - self.pan.y) / self.scale,
        );
        self.scale = 1.0_f32.clamp(self.min_scale(), self.max_scale());
        self.pan = egui::vec2(
            focus.x - before.x * self.scale,
            focus.y - before.y * self.scale,
        );
        self.clamp();
    }

    fn scroll_to_top(&mut self) {
        self.pan.y = self.layout.page_gap * self.scale;
        self.clamp();
    }

    fn scroll_to_bottom(&mut self) {
        let content_h = self.layout.document_height() * self.scale;
        let margin = self.layout.page_gap * self.scale;
        self.pan.y = self.surface.y - content_h - margin;
        self.clamp();
    }

    fn max_scale(&self) -> f32 {
        self.min_scale() * 6.0
    }

    fn clamp(&mut self) {
        self.layout = DocumentLayout::default_pages(self.layout.page_count.max(MIN_PAGE_COUNT));
        if !self.scale.is_finite() {
            self.scale = self.min_scale();
        }
        if !vec2_is_finite(self.pan) {
            self.pan = egui::Vec2::ZERO;
        }
        self.scale = self.scale.max(self.min_scale());

        let content_w = self.layout.document_width() * self.scale;
        if content_w <= self.surface.x {
            self.pan.x = (self.surface.x - content_w) * 0.5;
        } else {
            self.pan.x = self.pan.x.clamp(self.surface.x - content_w - 16.0, 16.0);
        }

        let content_h = self.layout.document_height() * self.scale;
        let margin = self.layout.page_gap * self.scale;
        let min_y = self.surface.y - content_h - margin;
        let max_y = margin;
        if min_y <= max_y {
            self.pan.y = self.pan.y.clamp(min_y, max_y);
        } else {
            self.pan.y = (self.surface.y - content_h) * 0.5;
        }
    }
}

fn vec2_is_finite(v: egui::Vec2) -> bool {
    v.x.is_finite() && v.y.is_finite()
}

fn visible_strokes(doc: &StrokesDoc) -> Vec<Stroke> {
    let mut strokes = Vec::new();
    doc.for_each_stroke(|view| {
        strokes.push(Stroke {
            id: view.id.to_owned(),
            color: view.color,
            width: view.width,
            points: view
                .points
                .chunks_exact(2)
                .map(|p| egui::pos2(p[0], p[1]))
                .collect(),
        });
    });
    strokes
}

fn page_count_for_strokes(strokes: &[Stroke]) -> u32 {
    let max_y = strokes
        .iter()
        .flat_map(|stroke| stroke.points.iter().map(|p| p.y))
        .fold(0.0_f32, f32::max);
    DocumentLayout::page_count_for_content_max_y(max_y)
}

fn paint_polyline(
    painter: &egui::Painter,
    view: &View,
    points: &[egui::Pos2],
    color: u32,
    width: f32,
) {
    if points.len() < 2 {
        return;
    }
    let color = color32_from_argb(color);
    let stroke = egui::Stroke::new((width * view.scale).max(1.0), color);
    for pair in points.windows(2) {
        painter.line_segment(
            [view.page_to_screen(pair[0]), view.page_to_screen(pair[1])],
            stroke,
        );
    }
}

fn read_property(value: &JsValue, key: &str) -> Option<JsValue> {
    let property = Reflect::get(value, &JsValue::from_str(key)).ok()?;
    if property.is_null() || property.is_undefined() {
        None
    } else {
        Some(property)
    }
}

fn read_string(value: &JsValue, key: &str) -> Option<String> {
    read_property(value, key)?.as_string()
}

fn read_bool(value: &JsValue, key: &str) -> Option<bool> {
    read_property(value, key)?.as_bool()
}

fn read_number(value: &JsValue, key: &str) -> Option<f64> {
    read_property(value, key)?
        .as_f64()
        .filter(|n| n.is_finite())
}

fn tool_from_setting(value: &str) -> Option<ToolMode> {
    match value {
        "pen" => Some(ToolMode::Pen),
        "eraser" => Some(ToolMode::Eraser),
        _ => None,
    }
}

fn tool_to_setting(tool: ToolMode) -> &'static str {
    match tool {
        ToolMode::Pen => "pen",
        ToolMode::Eraser => "eraser",
    }
}

fn page_theme_from_setting(value: &str) -> Option<InkPageThemeMode> {
    match value {
        "light" => Some(InkPageThemeMode::Light),
        "system" => Some(InkPageThemeMode::System),
        _ => None,
    }
}

fn page_theme_to_setting(mode: InkPageThemeMode) -> &'static str {
    match mode {
        InkPageThemeMode::Light => "light",
        InkPageThemeMode::System => "system",
    }
}

fn color32_from_argb(argb: u32) -> egui::Color32 {
    egui::Color32::from_rgba_premultiplied(
        ((argb >> 16) & 0xff) as u8,
        ((argb >> 8) & 0xff) as u8,
        (argb & 0xff) as u8,
        ((argb >> 24) & 0xff) as u8,
    )
}

fn display_color_argb(color: u32, page_dark: bool) -> u32 {
    if page_dark {
        invert_rgb_argb(color)
    } else {
        color
    }
}

fn invert_rgb_argb(color: u32) -> u32 {
    let a = color & 0xFF00_0000;
    let rgb = color & 0x00FF_FFFF;
    a | (!rgb & 0x00FF_FFFF)
}

fn stroke_hits(stroke: &Stroke, p: egui::Pos2, radius: f32) -> bool {
    let radius_sq = radius * radius;
    stroke
        .points
        .windows(2)
        .any(|pair| distance_to_segment_sq(p, pair[0], pair[1]) <= radius_sq)
}

fn distance_to_segment_sq(p: egui::Pos2, a: egui::Pos2, b: egui::Pos2) -> f32 {
    let ab = b - a;
    let len_sq = ab.length_sq();
    if len_sq <= f32::EPSILON {
        return p.distance_sq(a);
    }
    let t = ((p - a).dot(ab) / len_sq).clamp(0.0, 1.0);
    p.distance_sq(a + ab * t)
}
