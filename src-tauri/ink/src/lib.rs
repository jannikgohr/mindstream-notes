//! Ink strokes as the editor stores them, and the page image handwriting
//! recognition reads. Both hosts build this crate, so they compute the same
//! signature and send the same image for the same page.

use tiny_skia::{
    Color, FillRule, LineCap, LineJoin, Paint, PathBuilder, Pixmap, Stroke as Pen, Transform,
};

#[derive(Debug, Clone, PartialEq)]
pub struct Point {
    pub x: f32,
    pub y: f32,
    pub pressure: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Stroke {
    /// ARGB.
    pub color: u32,
    pub width: f32,
    pub points: Vec<Point>,
}

const DEFAULT_WIDTH: f32 = 4.0;

/// Reads the payload `stroke-codec.ts` writes: a version byte, ARGB colour,
/// width (v2 only), point count, x/y pairs, then pressures, little endian.
/// Malformed payloads yield `None`, as they do there.
pub fn decode_payload(bytes: &[u8]) -> Option<Stroke> {
    let (header, width) = match bytes.first()? {
        1 => (9, DEFAULT_WIDTH),
        2 if bytes.len() >= 13 => (13, sanitize_width(f32_at(bytes, 5))),
        _ => return None,
    };
    if bytes.len() < header {
        return None;
    }
    let count = u32_at(bytes, header - 4) as usize;
    if count.checked_mul(12)?.checked_add(header)? != bytes.len() {
        return None;
    }
    let pressures = header + count * 8;
    let points = (0..count)
        .map(|i| Point {
            x: f32_at(bytes, header + i * 8),
            y: f32_at(bytes, header + i * 8 + 4),
            pressure: sanitize_pressure(f32_at(bytes, pressures + i * 4)),
        })
        .collect();
    Some(Stroke {
        color: u32_at(bytes, 1),
        width,
        points,
    })
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}

fn f32_at(bytes: &[u8], at: usize) -> f32 {
    f32::from_bits(u32_at(bytes, at))
}

fn sanitize_pressure(value: f32) -> f32 {
    if value.is_finite() && value > 0.0 {
        value.min(1.0)
    } else {
        1.0
    }
}

fn sanitize_width(value: f32) -> f32 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        DEFAULT_WIDTH
    }
}

/// Changes when a page's strokes move, appear or disappear, at whole-unit
/// precision. Colour and width changes keep it, since they don't change
/// what the page says.
pub fn signature(strokes: &[Stroke]) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    let mut mix = |n: i32| {
        for byte in n.to_le_bytes() {
            hash = (hash ^ byte as u32).wrapping_mul(0x0100_0193);
        }
    };
    for stroke in strokes {
        mix(stroke.points.len() as i32);
        for point in &stroke.points {
            mix(point.x.round() as i32);
            mix(point.y.round() as i32);
        }
    }
    format!("{}:{}", strokes.len(), base36(hash))
}

fn base36(mut n: u32) -> String {
    let mut digits = Vec::new();
    loop {
        digits.push(char::from_digit(n % 36, 36).unwrap());
        n /= 36;
        if n == 0 {
            break;
        }
    }
    digits.iter().rev().collect()
}

pub const PADDING: f32 = 24.0;
pub const MAX_SIDE: f32 = 1600.0;

/// The strokes alone, cropped to their painted bounds with `PADDING`, on white,
/// scaled down to at most `MAX_SIDE` per side, as PNG. `None` when there is
/// nothing to draw. It does not need to match the editor canvas.
pub fn render_png(strokes: &[Stroke]) -> Option<Vec<u8>> {
    let finite = |p: &&Point| p.x.is_finite() && p.y.is_finite();
    let (mut min_x, mut min_y) = (f32::INFINITY, f32::INFINITY);
    let (mut max_x, mut max_y) = (f32::NEG_INFINITY, f32::NEG_INFINITY);
    for stroke in strokes {
        let radius = stroke.width / 2.0;
        for point in stroke.points.iter().filter(finite) {
            min_x = min_x.min(point.x - radius);
            min_y = min_y.min(point.y - radius);
            max_x = max_x.max(point.x + radius);
            max_y = max_y.max(point.y + radius);
        }
    }
    if min_x > max_x {
        return None;
    }
    let width = max_x - min_x + PADDING * 2.0;
    let height = max_y - min_y + PADDING * 2.0;
    let scale = (MAX_SIDE / width.max(height)).min(1.0);
    let mut pixmap = Pixmap::new(
        ((width * scale).ceil() as u32).clamp(1, MAX_SIDE as u32),
        ((height * scale).ceil() as u32).clamp(1, MAX_SIDE as u32),
    )?;
    pixmap.fill(Color::WHITE);
    let transform =
        Transform::from_translate(PADDING - min_x, PADDING - min_y).post_scale(scale, scale);
    for stroke in strokes {
        let points: Vec<_> = stroke.points.iter().filter(finite).collect();
        draw_stroke(&mut pixmap, &points, stroke, scale, transform);
    }
    pixmap.encode_png().ok()
}

fn draw_stroke(
    pixmap: &mut Pixmap,
    points: &[&Point],
    stroke: &Stroke,
    scale: f32,
    transform: Transform,
) {
    let [a, r, g, b] = stroke.color.to_be_bytes();
    let mut paint = Paint::default();
    paint.set_color_rgba8(r, g, b, a);
    paint.anti_alias = true;
    // Widths are in output pixels, so a scaled-down page keeps strokes readable.
    let width_at = |pressure: f32| {
        let width = (stroke.width * scale * (0.25 + 0.75 * pressure.clamp(0.0, 1.0))).max(1.0);
        (width * 4.0).round() / 4.0
    };
    let dot = |pixmap: &mut Pixmap, point: &Point| {
        let radius = width_at(point.pressure) / scale / 2.0;
        if let Some(path) = PathBuilder::from_circle(point.x, point.y, radius) {
            pixmap.fill_path(&path, &paint, FillRule::Winding, transform, None);
        }
    };
    if let [point] = points {
        dot(pixmap, point);
        return;
    }
    // One path per run of equal width, so overlapping segments of a
    // translucent stroke don't darken each other.
    let mut start = 0;
    while start + 1 < points.len() {
        let width = width_at(points[start + 1].pressure);
        let mut end = start + 1;
        while end + 1 < points.len() && width_at(points[end + 1].pressure) == width {
            end += 1;
        }
        let mut path = PathBuilder::new();
        path.move_to(points[start].x, points[start].y);
        for point in &points[start + 1..=end] {
            path.line_to(point.x, point.y);
        }
        match path.finish() {
            Some(path) => {
                let pen = Pen {
                    width: width / scale,
                    line_cap: LineCap::Round,
                    line_join: LineJoin::Round,
                    ..Pen::default()
                };
                pixmap.stroke_path(&path, &paint, &pen, transform, None);
            }
            None => dot(pixmap, points[start]),
        }
        start = end;
    }
}

#[cfg(test)]
mod tests;
