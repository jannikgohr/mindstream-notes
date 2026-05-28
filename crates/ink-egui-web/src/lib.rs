use eframe::egui;
use js_sys::{Function, Uint8Array};
use wasm_bindgen::prelude::*;
use yrs::any::Any;
use yrs::updates::decoder::Decode;
use yrs::{
    Array, ArrayRef, Doc, Map, MapPrelim, MapRef, Out, ReadTxn, StateVector, Transact, Update,
};

const STROKES_KEY: &str = "strokes";
const FIELD_TOMBSTONED: &str = "tombstoned";
const FIELD_ID: &str = "id";
const FIELD_PAYLOAD: &str = "payload";
const PAYLOAD_VERSION_V1: u8 = 1;
const PAYLOAD_VERSION_V2: u8 = 2;
const DEFAULT_COLOR: u32 = 0xFF00_0000;
const DEFAULT_WIDTH: f32 = 4.0;
const PAGE_W: f32 = 1190.0;
const PAGE_H: f32 = 1684.0;
const PAGE_GAP: f32 = 72.0;
const MIN_PAGE_COUNT: u32 = 2;

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
        on_change: Function,
    ) -> Result<(), JsValue> {
        let app = InkWebApp::new(initial_state, on_change);
        self.runner
            .start(
                canvas,
                eframe::WebOptions::default(),
                Box::new(move |_cc| Ok(Box::new(app))),
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
    doc: StrokeDoc,
    strokes: Vec<Stroke>,
    view: View,
    tool: ToolMode,
    color: u32,
    width: f32,
    in_flight: Vec<egui::Pos2>,
    drawing: bool,
    on_change: Function,
}

impl InkWebApp {
    fn new(initial_state: Vec<u8>, on_change: Function) -> Self {
        let doc = StrokeDoc::from_bytes(&initial_state);
        let strokes = doc.visible_strokes();
        let page_count = page_count_for_strokes(&strokes);
        Self {
            doc,
            strokes,
            view: View::new(page_count),
            tool: ToolMode::Pen,
            color: DEFAULT_COLOR,
            width: DEFAULT_WIDTH,
            in_flight: Vec::new(),
            drawing: false,
            on_change,
        }
    }

    fn refresh_strokes(&mut self) {
        self.strokes = self.doc.visible_strokes();
        self.view.page_count = page_count_for_strokes(&self.strokes);
        self.view.clamp();
    }

    fn emit_change(&self) {
        let bytes = self.doc.encode();
        let array = Uint8Array::from(bytes.as_slice());
        let _ = self.on_change.call1(&JsValue::NULL, &array);
    }

    fn toolbar(&mut self, ctx: &egui::Context) {
        egui::TopBottomPanel::top("ink-web-toolbar")
            .exact_height(56.0)
            .frame(egui::Frame::default().fill(egui::Color32::from_rgb(250, 250, 250)))
            .show(ctx, |ui| {
                ui.horizontal_centered(|ui| {
                    ui.selectable_value(&mut self.tool, ToolMode::Pen, "Pen");
                    ui.selectable_value(&mut self.tool, ToolMode::Eraser, "Eraser");
                    ui.separator();
                    ui.label("Width");
                    ui.add(egui::Slider::new(&mut self.width, 0.5..=12.0).show_value(false));
                    ui.separator();
                    if ui.button("Clear").clicked() {
                        self.doc.tombstone_all();
                        self.refresh_strokes();
                        self.emit_change();
                    }
                });
            });
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
                if self.doc.erase_at(page_pos, 10.0) {
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
        if self.doc.end_stroke() {
            self.refresh_strokes();
            self.emit_change();
        }
    }

    fn paint_canvas(&self, painter: &egui::Painter, rect: egui::Rect) {
        painter.rect_filled(rect, 0.0, egui::Color32::from_rgb(238, 238, 238));
        for page in 0..self.view.page_count {
            let top = page as f32 * (PAGE_H + PAGE_GAP);
            let min = self.view.page_to_screen(egui::pos2(0.0, top));
            let max = self.view.page_to_screen(egui::pos2(PAGE_W, top + PAGE_H));
            let page_rect = egui::Rect::from_min_max(min, max);
            painter.rect_filled(
                page_rect.translate(egui::vec2(0.0, 2.0)),
                2.0,
                egui::Color32::from_black_alpha(24),
            );
            painter.rect_filled(page_rect, 2.0, egui::Color32::WHITE);
            painter.rect_stroke(
                page_rect,
                2.0,
                egui::Stroke::new(1.0, egui::Color32::from_rgb(214, 214, 214)),
                egui::StrokeKind::Outside,
            );
        }

        for stroke in &self.strokes {
            paint_polyline(
                painter,
                &self.view,
                &stroke.points,
                stroke.color,
                stroke.width,
            );
        }
        paint_polyline(painter, &self.view, &self.in_flight, self.color, self.width);
    }
}

impl eframe::App for InkWebApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.toolbar(ctx);
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

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
enum ToolMode {
    Pen,
    Eraser,
}

#[derive(Clone)]
struct Stroke {
    id: String,
    color: u32,
    width: f32,
    points: Vec<egui::Pos2>,
}

struct StrokeDoc {
    doc: Doc,
    strokes: ArrayRef,
    in_progress_color: Option<u32>,
    in_progress_width: f32,
    in_progress_points: Vec<f32>,
    in_progress_pressures: Vec<f32>,
}

impl StrokeDoc {
    fn new() -> Self {
        let doc = Doc::new();
        let strokes = doc.get_or_insert_array(STROKES_KEY);
        Self {
            doc,
            strokes,
            in_progress_color: None,
            in_progress_width: DEFAULT_WIDTH,
            in_progress_points: Vec::new(),
            in_progress_pressures: Vec::new(),
        }
    }

    fn from_bytes(bytes: &[u8]) -> Self {
        let doc = Self::new();
        if !bytes.is_empty() {
            let mut tx = doc.doc.transact_mut();
            if let Ok(update) = Update::decode_v1(bytes) {
                let _ = tx.apply_update(update);
            }
        }
        doc
    }

    fn encode(&self) -> Vec<u8> {
        let tx = self.doc.transact();
        tx.encode_state_as_update_v1(&StateVector::default())
    }

    fn begin_stroke(&mut self, color: u32, width: f32) {
        self.in_progress_color = Some(color);
        self.in_progress_width = width;
        self.in_progress_points.clear();
        self.in_progress_pressures.clear();
    }

    fn push_point(&mut self, x: f32, y: f32, pressure: f32) {
        if self.in_progress_color.is_none() {
            return;
        }
        self.in_progress_points.push(x);
        self.in_progress_points.push(y);
        self.in_progress_pressures.push(pressure);
    }

    fn end_stroke(&mut self) -> bool {
        let Some(color) = self.in_progress_color.take() else {
            return false;
        };
        if self.in_progress_pressures.len() < 2 {
            self.in_progress_points.clear();
            self.in_progress_pressures.clear();
            return false;
        }
        let payload = encode_payload_v2(
            color,
            self.in_progress_width,
            &self.in_progress_points,
            &self.in_progress_pressures,
        );
        self.in_progress_points.clear();
        self.in_progress_pressures.clear();

        let stroke_id = format!("stroke_{}", uuid::Uuid::new_v4());
        let mut tx = self.doc.transact_mut();
        let len = self.strokes.len(&tx);
        let stroke_map = self.strokes.insert(&mut tx, len, MapPrelim::default());
        stroke_map.insert(&mut tx, FIELD_ID, Any::from(stroke_id));
        stroke_map.insert(&mut tx, FIELD_TOMBSTONED, Any::Bool(false));
        stroke_map.insert(
            &mut tx,
            FIELD_PAYLOAD,
            Any::Buffer(payload.into_boxed_slice().into()),
        );
        true
    }

    fn visible_strokes(&self) -> Vec<Stroke> {
        let tx = self.doc.transact();
        let mut out = Vec::new();
        for stroke_value in self.strokes.iter(&tx) {
            let Out::YMap(stroke) = stroke_value else {
                continue;
            };
            let tombstoned = matches!(
                stroke.get(&tx, FIELD_TOMBSTONED),
                Some(Out::Any(Any::Bool(true)))
            );
            if tombstoned {
                continue;
            }
            let id = match stroke.get(&tx, FIELD_ID) {
                Some(Out::Any(Any::String(s))) => s.to_string(),
                _ => continue,
            };
            let Some(Out::Any(Any::Buffer(bytes))) = stroke.get(&tx, FIELD_PAYLOAD) else {
                continue;
            };
            let Some(decoded) = decode_payload(&bytes) else {
                continue;
            };
            out.push(Stroke {
                id,
                color: decoded.color,
                width: decoded.width,
                points: decoded
                    .points
                    .chunks_exact(2)
                    .map(|p| egui::pos2(p[0], p[1]))
                    .collect(),
            });
        }
        out
    }

    fn tombstone_all(&mut self) {
        let mut tx = self.doc.transact_mut();
        let len = self.strokes.len(&tx);
        for i in 0..len {
            let Some(Out::YMap(stroke)) = self.strokes.get(&tx, i) else {
                continue;
            };
            stroke.insert(&mut tx, FIELD_TOMBSTONED, Any::Bool(true));
        }
    }

    fn erase_at(&mut self, page_pos: egui::Pos2, radius: f32) -> bool {
        let ids: Vec<String> = self
            .visible_strokes()
            .into_iter()
            .filter(|stroke| stroke_hits(stroke, page_pos, radius))
            .map(|stroke| stroke.id)
            .collect();
        if ids.is_empty() {
            return false;
        }

        let to_tombstone: Vec<MapRef> = {
            let tx = self.doc.transact();
            self.strokes
                .iter(&tx)
                .filter_map(|stroke_value| {
                    let Out::YMap(stroke) = stroke_value else {
                        return None;
                    };
                    let matches_id = matches!(
                        stroke.get(&tx, FIELD_ID),
                        Some(Out::Any(Any::String(s))) if ids.iter().any(|id| id == &*s)
                    );
                    matches_id.then_some(stroke)
                })
                .collect()
        };
        let mut tx = self.doc.transact_mut();
        for stroke in to_tombstone {
            stroke.insert(&mut tx, FIELD_TOMBSTONED, Any::Bool(true));
        }
        true
    }
}

struct DecodedPayload {
    color: u32,
    width: f32,
    points: Vec<f32>,
}

fn encode_payload_v2(color: u32, width: f32, points: &[f32], pressures: &[f32]) -> Vec<u8> {
    let n_points = pressures.len() as u32;
    let mut out = Vec::with_capacity(13 + points.len() * 4 + pressures.len() * 4);
    out.push(PAYLOAD_VERSION_V2);
    out.extend_from_slice(&color.to_le_bytes());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&n_points.to_le_bytes());
    for v in points {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for v in pressures {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

fn decode_payload(bytes: &[u8]) -> Option<DecodedPayload> {
    let version = *bytes.first()?;
    match version {
        PAYLOAD_VERSION_V1 => decode_payload_after_header(bytes, 5, DEFAULT_WIDTH),
        PAYLOAD_VERSION_V2 => {
            if bytes.len() < 13 {
                return None;
            }
            let width = f32::from_le_bytes(bytes[5..9].try_into().ok()?);
            decode_payload_after_header(bytes, 9, width)
        }
        _ => None,
    }
}

fn decode_payload_after_header(
    bytes: &[u8],
    n_offset: usize,
    width: f32,
) -> Option<DecodedPayload> {
    let color = u32::from_le_bytes(bytes[1..5].try_into().ok()?);
    let n = u32::from_le_bytes(bytes[n_offset..n_offset + 4].try_into().ok()?) as usize;
    let points_start = n_offset + 4;
    let points_len = n.checked_mul(8)?;
    let pressures_start = points_start.checked_add(points_len)?;
    let pressures_len = n.checked_mul(4)?;
    let total = pressures_start.checked_add(pressures_len)?;
    if bytes.len() < total {
        return None;
    }
    let mut points = Vec::with_capacity(n * 2);
    for chunk in bytes[points_start..pressures_start].chunks_exact(4) {
        points.push(f32::from_le_bytes(chunk.try_into().ok()?));
    }
    Some(DecodedPayload {
        color,
        width,
        points,
    })
}

#[derive(Clone)]
struct View {
    surface: egui::Vec2,
    scale: f32,
    pan: egui::Vec2,
    page_count: u32,
}

impl View {
    fn new(page_count: u32) -> Self {
        Self {
            surface: egui::vec2(1.0, 1.0),
            scale: 1.0,
            pan: egui::vec2(0.0, PAGE_GAP),
            page_count: page_count.max(MIN_PAGE_COUNT),
        }
    }

    fn set_surface(&mut self, w: f32, h: f32) {
        let old = self.surface;
        self.surface = egui::vec2(w.max(1.0), h.max(1.0));
        if old.x <= 1.0 && old.y <= 1.0 {
            self.scale = self.min_scale();
            self.pan.x = (self.surface.x - PAGE_W * self.scale) * 0.5;
            self.pan.y = PAGE_GAP * self.scale;
        }
        self.clamp();
    }

    fn min_scale(&self) -> f32 {
        (self.surface.x / PAGE_W)
            .min(self.surface.y / PAGE_H)
            .max(0.05)
    }

    fn document_h(&self) -> f32 {
        PAGE_H * self.page_count as f32 + PAGE_GAP * (self.page_count.saturating_sub(1)) as f32
    }

    fn page_to_screen(&self, p: egui::Pos2) -> egui::Pos2 {
        egui::pos2(p.x * self.scale + self.pan.x, p.y * self.scale + self.pan.y)
    }

    fn screen_to_page(&self, p: egui::Pos2) -> Option<egui::Pos2> {
        let page = egui::pos2(
            (p.x - self.pan.x) / self.scale,
            (p.y - self.pan.y) / self.scale,
        );
        (page.x >= 0.0
            && page.x <= PAGE_W
            && page.y >= 0.0
            && page.y <= self.document_h()
            && page.y % (PAGE_H + PAGE_GAP) <= PAGE_H)
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
        self.page_count = self.page_count.max(MIN_PAGE_COUNT);
        self.scale = self.scale.max(self.min_scale());
        let content_w = PAGE_W * self.scale;
        if content_w <= self.surface.x {
            self.pan.x = (self.surface.x - content_w) * 0.5;
        } else {
            self.pan.x = self.pan.x.clamp(self.surface.x - content_w - 16.0, 16.0);
        }

        let content_h = self.document_h() * self.scale;
        let margin = PAGE_GAP * self.scale;
        if content_h <= self.surface.y {
            self.pan.y = self
                .pan
                .y
                .clamp(margin, self.surface.y - content_h - margin);
        } else {
            self.pan.y = self
                .pan
                .y
                .clamp(self.surface.y - content_h - margin, margin);
        }
    }
}

fn page_count_for_strokes(strokes: &[Stroke]) -> u32 {
    let max_y = strokes
        .iter()
        .flat_map(|stroke| stroke.points.iter().map(|p| p.y))
        .fold(0.0_f32, f32::max);
    if max_y <= 0.0 {
        return MIN_PAGE_COUNT;
    }
    let stride = PAGE_H + PAGE_GAP;
    ((max_y / stride).floor() as u32 + 2).max(MIN_PAGE_COUNT)
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

fn color32_from_argb(argb: u32) -> egui::Color32 {
    egui::Color32::from_rgba_premultiplied(
        ((argb >> 16) & 0xff) as u8,
        ((argb >> 8) & 0xff) as u8,
        (argb & 0xff) as u8,
        ((argb >> 24) & 0xff) as u8,
    )
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
