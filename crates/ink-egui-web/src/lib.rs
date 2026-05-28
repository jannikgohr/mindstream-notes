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
    on_change: Function,
    on_toolbar_settings: Function,
}

impl InkWebApp {
    fn new(
        initial_state: Vec<u8>,
        toolbar_settings: ToolbarSettings,
        on_change: Function,
        on_toolbar_settings: Function,
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
            on_change,
            on_toolbar_settings,
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
                can_undo: false,
                can_redo: false,
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
            self.doc.tombstone_all();
            self.refresh_strokes();
            doc_changed = true;
        }
        if toolbar_changed {
            self.emit_toolbar_settings();
        }
        if doc_changed {
            self.emit_change();
        }
    }

    fn handle_canvas_input(&mut self, response: &egui::Response, ctx: &egui::Context) {
        if response.hovered() {
            ctx.input(|i| {
                let scroll = i.smooth_scroll_delta;
                if scroll != egui::Vec2::ZERO {
                    if i.modifiers.ctrl {
                        if let Some(pos) = response.hover_pos() {
                            let factor = (1.0_f32 + scroll.y * 0.001).clamp(0.75, 1.25);
                            self.view.zoom_around(pos, factor);
                        }
                    } else {
                        self.view.pan_by(scroll.x, scroll.y);
                    }
                }
            });
        }

        let pointer_down = ctx.input(|i| i.pointer.primary_down());
        let Some(pos) = response.interact_pointer_pos() else {
            if self.drawing && !pointer_down {
                self.finish_stroke();
            }
            return;
        };

        if self.tool == ToolMode::Eraser && response.dragged() {
            if let Some(page_pos) = self.view.screen_to_page(pos) {
                if self.erase_at(page_pos, 10.0) {
                    self.refresh_strokes();
                    self.emit_change();
                }
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
        if self.doc.end_stroke().is_some() {
            self.refresh_strokes();
            self.emit_change();
        }
    }

    fn erase_at(&mut self, page_pos: egui::Pos2, radius: f32) -> bool {
        let ids: HashSet<String> = self
            .strokes
            .iter()
            .filter(|stroke| stroke_hits(stroke, page_pos, radius))
            .map(|stroke| stroke.id.clone())
            .collect();
        self.doc.tombstone_strokes(&ids) > 0
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
        self.pan += egui::vec2(dx, dy);
        self.clamp();
    }

    fn zoom_around(&mut self, focus: egui::Pos2, factor: f32) {
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

    fn clamp(&mut self) {
        self.layout = DocumentLayout::default_pages(self.layout.page_count.max(MIN_PAGE_COUNT));
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
