//! Page-coordinate model.
//!
//! Strokes live in document (page) coordinates — 1 unit = 1/144
//! inch by default. The wgpu side stores page-coord vertices and
//! applies a `ViewTransform` in the shader to map them to the
//! surface, so the same stored values render correctly across
//! rotations, surface re-attaches, and (eventually) pan/zoom.
//!
//! This file owns three pieces:
//!   - `PageSize`        — width/height in page-units, with named
//!                         constants for common paper sizes.
//!   - `DocumentLayout`  — uniform pages stacked vertically in
//!                         document coordinates.
//!   - `ViewTransform`   — runtime mapping from document → surface
//!                         pixels. Initially fitted to page 0, then
//!                         mutated by D6 pan/zoom gestures.
//!   - `ViewUniform`     — std140-laid-out GPU uniform that mirrors
//!                         the shader struct in `line.wgsl`.
//!
//! Future work tracked in the roadmap:
//!   - C1: per-note `PageSize` (today's `DEFAULT_PAGE` is hardcoded).
//!   - F6: user-facing page-size setting.
//!   - D6: pan + pinch-zoom (`ViewTransform::fit_in_surface` becomes
//!         the initial state, then mutated by gesture handling).
//!   - D7: multi-page (more pages stacked along Y in document space).

// The GPU-uniform struct (`ViewUniform` + its bytemuck derives)
// requires `bytemuck`, which lives in the Android-only dep block.
// Cfg-gate the uniform itself + the conversion method so the rest
// of this file (the pure math) compiles + tests on every host.
#[cfg(target_os = "android")]
use bytemuck::{Pod, Zeroable};

/// Page dimensions in document units. 1 unit = 1/144 inch at the
/// implicit reference DPI (144) — chosen so common paper sizes
/// round to clean integers and so rendering at typical screen
/// densities doesn't over- or under-sample.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct PageSize {
    pub width: f32,
    pub height: f32,
}

impl PageSize {
    /// A4 portrait: 8.27" × 11.69" → 1190 × 1684 page-units.
    pub const A4_PORTRAIT: Self = Self {
        width: 1190.0,
        height: 1684.0,
    };

    /// A4 landscape.
    pub const A4_LANDSCAPE: Self = Self {
        width: 1684.0,
        height: 1190.0,
    };

    /// US Letter portrait: 8.5" × 11" → 1224 × 1584 page-units.
    pub const LETTER_PORTRAIT: Self = Self {
        width: 1224.0,
        height: 1584.0,
    };
}

/// The page size every newly-attached ink note currently uses.
/// Becomes per-note in C1, then user-configurable in F6.
pub const DEFAULT_PAGE: PageSize = PageSize::A4_PORTRAIT;

/// Gap between vertically-stacked pages, in document units. At the
/// default 144 units/inch this is roughly 0.5", enough to read as a
/// page break without wasting too much scroll distance.
pub const DEFAULT_PAGE_GAP: f32 = 72.0;

/// Minimum number of pages kept reachable in an ink note. Keeping a
/// trailing blank page available means the first D7 slice can support
/// vertical paged drawing without separate "add page" UI.
pub const MIN_PAGE_COUNT: u32 = 2;

/// Uniform fixed-size pages arranged top-to-bottom in one continuous
/// document coordinate space. Page 0 starts at y=0; page 1 starts at
/// `page.height + page_gap`; and so on.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct DocumentLayout {
    pub page: PageSize,
    pub page_count: u32,
    pub page_gap: f32,
}

impl DocumentLayout {
    pub fn new(page: PageSize, page_count: u32, page_gap: f32) -> Self {
        Self {
            page,
            page_count: page_count.max(1),
            page_gap: page_gap.max(0.0),
        }
    }

    pub fn default_pages(page_count: u32) -> Self {
        Self::new(
            DEFAULT_PAGE,
            page_count.max(MIN_PAGE_COUNT),
            DEFAULT_PAGE_GAP,
        )
    }

    pub fn stride_y(&self) -> f32 {
        self.page.height + self.page_gap
    }

    pub fn document_width(&self) -> f32 {
        self.page.width
    }

    pub fn document_height(&self) -> f32 {
        let pages = self.page_count.max(1) as f32;
        self.page.height * pages + self.page_gap * (pages - 1.0)
    }

    pub fn page_top(&self, index: u32) -> f32 {
        index as f32 * self.stride_y()
    }

    pub fn page_rect(&self, index: u32) -> Option<[f32; 4]> {
        if index >= self.page_count {
            return None;
        }
        let top = self.page_top(index);
        Some([0.0, top, self.page.width, top + self.page.height])
    }

    /// Return the page containing `point`, or `None` when the point
    /// is outside the document or inside a page gap.
    pub fn page_index_at(&self, x: f32, y: f32) -> Option<u32> {
        if x < 0.0 || x > self.page.width || y < 0.0 || y > self.document_height() {
            return None;
        }
        let stride = self.stride_y();
        if stride <= 0.0 {
            return None;
        }
        let index = (y / stride).floor() as u32;
        if index >= self.page_count {
            return None;
        }
        let local_y = y - self.page_top(index);
        if local_y <= self.page.height {
            Some(index)
        } else {
            None
        }
    }

    pub fn contains_page_point(&self, x: f32, y: f32) -> bool {
        self.page_index_at(x, y).is_some()
    }

    pub fn page_count_for_content_max_y(max_y: f32) -> u32 {
        if !max_y.is_finite() || max_y <= 0.0 {
            return MIN_PAGE_COUNT;
        }
        let layout = Self::default_pages(MIN_PAGE_COUNT);
        let stride = layout.stride_y();
        let content_pages = (max_y / stride).floor() as u32 + 1;
        (content_pages + 1).max(MIN_PAGE_COUNT)
    }
}

/// Maps between page coordinates (what we store in vertices) and
/// surface pixels (what touches arrive in and what the surface
/// presents).
///
/// Built per-surface via `fit_in_surface`: pick the scale that
/// makes the *whole* page fit in the surface (whichever dimension
/// would overflow wins), and centre the page. So in portrait the
/// page typically scales to surface width with small top/bottom
/// margins; in landscape it scales to surface height with larger
/// left/right margins.
///
/// Pan/zoom (D6) replaces the always-fitted derivation with
/// user-driven values, but the `surface_to_page` /
/// `as_uniform` API stays the same.
#[derive(Copy, Clone, Debug)]
pub struct ViewTransform {
    pub layout: DocumentLayout,
    pub surface_w: f32,
    pub surface_h: f32,
    /// 1 page-unit = `scale` surface pixels.
    pub scale: f32,
    /// Surface-pixel offset of the page's top-left corner.
    pub pan_x: f32,
    pub pan_y: f32,
}

impl ViewTransform {
    pub fn fit_in_surface(page: PageSize, surface_w: f32, surface_h: f32) -> Self {
        Self::fit_layout_in_surface(
            DocumentLayout::new(page, 1, DEFAULT_PAGE_GAP),
            surface_w,
            surface_h,
        )
    }

    pub fn fit_layout_in_surface(layout: DocumentLayout, surface_w: f32, surface_h: f32) -> Self {
        let sw = surface_w.max(1.0);
        let sh = surface_h.max(1.0);
        // Fit the first page, not the whole document. Multi-page
        // documents should open at readable page size with vertical
        // scrolling, not shrink until every page fits at once.
        let scale = (sw / layout.page.width).min(sh / layout.page.height);
        let page_screen_w = layout.page.width * scale;
        let page_screen_h = layout.page.height * scale;
        let mut view = Self {
            layout,
            surface_w: sw,
            surface_h: sh,
            scale,
            pan_x: (sw - page_screen_w) * 0.5,
            pan_y: (sh - page_screen_h) * 0.5,
        };
        view.clamp_to_document();
        view
    }

    pub fn set_surface_size(&mut self, surface_w: f32, surface_h: f32) {
        let old_sw = self.surface_w.max(1.0);
        let old_sh = self.surface_h.max(1.0);
        let focus_x = old_sw * 0.5;
        let focus_y = old_sh * 0.5;
        let doc_at_focus = self.surface_to_page(focus_x, focus_y);
        self.surface_w = surface_w.max(1.0);
        self.surface_h = surface_h.max(1.0);
        self.pan_x = self.surface_w * 0.5 - doc_at_focus[0] * self.scale;
        self.pan_y = self.surface_h * 0.5 - doc_at_focus[1] * self.scale;
        self.clamp_to_document();
    }

    pub fn set_layout(&mut self, layout: DocumentLayout) {
        self.layout = layout;
        self.clamp_to_document();
    }

    pub fn pan_by(&mut self, dx: f32, dy: f32) {
        self.pan_x += dx;
        self.pan_y += dy;
        self.clamp_to_document();
    }

    pub fn zoom_around(&mut self, focus_x: f32, focus_y: f32, scale_delta: f32) {
        if !scale_delta.is_finite() || scale_delta <= 0.0 {
            return;
        }
        let before = self.surface_to_page(focus_x, focus_y);
        let min_scale = self.min_scale();
        let max_scale = min_scale * 6.0;
        self.scale = (self.scale * scale_delta).clamp(min_scale, max_scale);
        self.pan_x = focus_x - before[0] * self.scale;
        self.pan_y = focus_y - before[1] * self.scale;
        self.clamp_to_document();
    }

    pub fn apply_gesture(
        &mut self,
        focus_x: f32,
        focus_y: f32,
        pan_dx: f32,
        pan_dy: f32,
        scale_delta: f32,
    ) {
        if scale_delta.is_finite() && (scale_delta - 1.0).abs() > f32::EPSILON {
            self.zoom_around(focus_x, focus_y, scale_delta);
        }
        self.pan_by(pan_dx, pan_dy);
    }

    fn min_scale(&self) -> f32 {
        (self.surface_w / self.layout.page.width).min(self.surface_h / self.layout.page.height)
    }

    pub fn clamp_to_document(&mut self) {
        self.scale = self.scale.max(self.min_scale());
        let doc_w = self.layout.document_width() * self.scale;
        let doc_h = self.layout.document_height() * self.scale;
        let page_w = self.layout.page.width * self.scale;
        let page_h = self.layout.page.height * self.scale;
        let max_x = ((self.surface_w - page_w) * 0.5).max(0.0);
        let max_y = ((self.surface_h - page_h) * 0.5).max(0.0);
        self.pan_x = clamp_axis(self.pan_x, self.surface_w, doc_w, max_x);
        self.pan_y = clamp_axis(self.pan_y, self.surface_h, doc_h, max_y);
    }

    /// Inverse of the GPU transform — convert a surface-pixel touch
    /// coordinate into the page-coordinate value we'll store in the
    /// vertex buffer.
    pub fn surface_to_page(&self, sx: f32, sy: f32) -> [f32; 2] {
        [
            (sx - self.pan_x) / self.scale,
            (sy - self.pan_y) / self.scale,
        ]
    }

    pub fn surface_to_page_if_inside_page(&self, sx: f32, sy: f32) -> Option<[f32; 2]> {
        let [px, py] = self.surface_to_page(sx, sy);
        self.layout.contains_page_point(px, py).then_some([px, py])
    }

    /// Pack into the std140-laid-out uniform the shader reads.
    /// Android-only because the matching `ViewUniform` requires
    /// bytemuck, which only ships on the Android-target dep set.
    #[cfg(target_os = "android")]
    pub fn as_uniform(&self) -> ViewUniform {
        ViewUniform {
            scale: self.scale,
            _pad0: 0.0,
            pan: [self.pan_x, self.pan_y],
            surface_dims: [self.surface_w, self.surface_h],
        }
    }
}

fn clamp_axis(pan: f32, surface: f32, content: f32, leading_margin: f32) -> f32 {
    if content <= surface {
        (surface - content) * 0.5
    } else {
        let max_pan = leading_margin;
        let min_pan = surface - content - leading_margin;
        pan.clamp(min_pan, max_pan)
    }
}

/// GPU-side uniform layout. Fields are arranged to match WGSL's
/// vec2 alignment rules (vec2 is 8-byte aligned), so the explicit
/// pad after `scale` mirrors the implicit padding the WGSL
/// compiler inserts in the matching `ViewUniform` struct in
/// `line.wgsl`. Total size: 24 bytes.
#[cfg(target_os = "android")]
#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
pub struct ViewUniform {
    pub scale: f32,
    pub _pad0: f32,
    pub pan: [f32; 2],
    pub surface_dims: [f32; 2],
}

/// Squared distance from point `p` to the line segment `a → b`,
/// in whatever coordinate system the caller is using (typically
/// page coordinates for the eraser hit-test). Squared because the
/// caller almost always compares against a squared radius — one
/// `sqrt` saved per hit-test, which adds up across thousands of
/// (sample × stroke segment) checks per drag frame.
///
/// Behaviour:
///   - Degenerate segment (a == b) returns squared distance from
///     `p` to `a`, no NaN.
///   - Point past either endpoint clamps to the endpoint (so the
///     segment doesn't "extend infinitely" — what the user expects
///     for eraser hits near a stroke's start / end).
pub fn point_to_segment_distance_sq(
    (px, py): (f32, f32),
    (ax, ay): (f32, f32),
    (bx, by): (f32, f32),
) -> f32 {
    let dx = bx - ax;
    let dy = by - ay;
    let len_sq = dx * dx + dy * dy;
    if len_sq < 1e-12 {
        // Degenerate — segment collapsed to a point; return distance
        // to that point.
        let qx = px - ax;
        let qy = py - ay;
        return qx * qx + qy * qy;
    }
    // Project (p - a) onto (b - a) / |b - a|², clamped to [0, 1] for
    // segment (vs line) semantics.
    let t = ((px - ax) * dx + (py - ay) * dy) / len_sq;
    let t = t.clamp(0.0, 1.0);
    let cx = ax + t * dx;
    let cy = ay + t * dy;
    let qx = px - cx;
    let qy = py - cy;
    qx * qx + qy * qy
}

/// Expand a single pen segment into six vertex positions (two
/// triangles, TriangleList ordering) with potentially different
/// widths at each endpoint. Output is pure `[f32; 2]` so this can
/// live on the host side of the cfg gate and be unit-tested without
/// the wgpu vertex type.
///
/// Geometry:
///
///   p0 ─ p1 direction = `d`; perpendicular = `n` (90° CCW of `d`).
///   Six vertices form the two triangles
///     [a0, b0, a1]  and  [b0, b1, a1]
///   where a* sit on the +n side and b* on the -n side.
///
/// Returns six identical `p0` vertices for degenerate (zero-length)
/// segments so the GPU draws two zero-area triangles (no visible
/// effect) while keeping the vertex count predictable for the
/// caller's `extend`. NaN normals would otherwise propagate into
/// the rasteriser.
pub fn segment_quad_positions(
    (p0x, p0y): (f32, f32),
    (p1x, p1y): (f32, f32),
    w0: f32,
    w1: f32,
) -> [[f32; 2]; 6] {
    let dx = p1x - p0x;
    let dy = p1y - p0y;
    let len_sq = dx * dx + dy * dy;
    if len_sq < 1e-8 {
        let z = [p0x, p0y];
        return [z, z, z, z, z, z];
    }
    let inv_len = 1.0 / len_sq.sqrt();
    // Perpendicular (90° CCW of (dx, dy)) normalised.
    let nx = -dy * inv_len;
    let ny = dx * inv_len;
    let h0 = w0 * 0.5;
    let h1 = w1 * 0.5;
    let a0 = [p0x + nx * h0, p0y + ny * h0];
    let b0 = [p0x - nx * h0, p0y - ny * h0];
    let a1 = [p1x + nx * h1, p1y + ny * h1];
    let b1 = [p1x - nx * h1, p1y - ny * h1];
    [a0, b0, a1, b0, b1, a1]
}

/// Build a continuous triangle-list stroke mesh from an unchanged
/// centreline. Unlike [`segment_quad_positions`], which expands each
/// segment independently, this computes one normal per centre point
/// from neighbouring points. Thick slow strokes then get a coherent
/// outline instead of a visible chain of tiny rectangles.
///
/// The centreline is preserved exactly: every generated left/right
/// pair is symmetric around the original input point. Only the visual
/// offset direction and radius are filtered.
pub fn stroke_polyline_positions(points: &[(f32, f32)], widths: &[f32]) -> Vec<[f32; 2]> {
    let n = points.len();
    if n < 2 {
        return Vec::new();
    }

    let mut left = Vec::with_capacity(n);
    let mut right = Vec::with_capacity(n);
    for i in 0..n {
        let (px, py) = points[i];
        let Some((tx, ty)) = tangent_at(points, i) else {
            left.push([px, py]);
            right.push([px, py]);
            continue;
        };
        let width = smoothed_width_at(widths, i);
        let hx = -ty * width * 0.5;
        let hy = tx * width * 0.5;
        left.push([px + hx, py + hy]);
        right.push([px - hx, py - hy]);
    }

    let mut out = Vec::with_capacity((n - 1) * 6);
    for i in 0..(n - 1) {
        let dx = points[i + 1].0 - points[i].0;
        let dy = points[i + 1].1 - points[i].1;
        if dx * dx + dy * dy < 1e-8 {
            continue;
        }
        out.extend_from_slice(&[
            left[i],
            right[i],
            left[i + 1],
            right[i],
            right[i + 1],
            left[i + 1],
        ]);
    }
    out
}

fn tangent_at(points: &[(f32, f32)], i: usize) -> Option<(f32, f32)> {
    let current = points[i];
    let prev = nearest_distinct_before(points, i);
    let next = nearest_distinct_after(points, i);

    if let (Some(p), Some(n)) = (prev, next) {
        if let Some(t) = normalize((n.0 - p.0, n.1 - p.1)) {
            return Some(t);
        }
    }
    if let Some(n) = next {
        if let Some(t) = normalize((n.0 - current.0, n.1 - current.1)) {
            return Some(t);
        }
    }
    if let Some(p) = prev {
        if let Some(t) = normalize((current.0 - p.0, current.1 - p.1)) {
            return Some(t);
        }
    }
    None
}

fn nearest_distinct_before(points: &[(f32, f32)], i: usize) -> Option<(f32, f32)> {
    let current = points[i];
    points[..i]
        .iter()
        .rev()
        .copied()
        .find(|p| dist_sq(*p, current) >= 1e-8)
}

fn nearest_distinct_after(points: &[(f32, f32)], i: usize) -> Option<(f32, f32)> {
    let current = points[i];
    points
        .get(i + 1..)
        .unwrap_or(&[])
        .iter()
        .copied()
        .find(|p| dist_sq(*p, current) >= 1e-8)
}

fn dist_sq(a: (f32, f32), b: (f32, f32)) -> f32 {
    let dx = a.0 - b.0;
    let dy = a.1 - b.1;
    dx * dx + dy * dy
}

fn normalize((x, y): (f32, f32)) -> Option<(f32, f32)> {
    let len_sq = x * x + y * y;
    if len_sq < 1e-8 {
        return None;
    }
    let inv_len = 1.0 / len_sq.sqrt();
    Some((x * inv_len, y * inv_len))
}

fn smoothed_width_at(widths: &[f32], i: usize) -> f32 {
    if widths.is_empty() {
        return 1.0;
    }
    let current = widths
        .get(i)
        .copied()
        .unwrap_or_else(|| *widths.last().unwrap());
    let prev = if i == 0 {
        current
    } else {
        widths.get(i - 1).copied().unwrap_or(current)
    };
    let next = widths.get(i + 1).copied().unwrap_or(current);
    (prev + current * 2.0 + next) * 0.25
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32) {
        assert!((a - b).abs() < 0.01, "{a} != {b}");
    }

    #[test]
    fn fit_portrait_page_in_portrait_surface() {
        // A4 portrait (1190 × 1684, ~0.71 aspect) into a phone
        // portrait surface (1080 × 2400, ~0.45 aspect). Surface is
        // taller than the page is — width is the constraint.
        let vt = ViewTransform::fit_in_surface(PageSize::A4_PORTRAIT, 1080.0, 2400.0);
        approx(vt.scale, 1080.0 / 1190.0);
        approx(vt.pan_x, 0.0);
        // page screen height = 1684 * (1080/1190) ≈ 1528; vertical
        // margin = (2400 - 1528) / 2 ≈ 436
        approx(vt.pan_y, (2400.0 - 1684.0 * (1080.0 / 1190.0)) * 0.5);
    }

    #[test]
    fn fit_portrait_page_in_landscape_surface() {
        // A4 portrait into a phone landscape surface (2400 × 1080).
        // Height is now the constraint.
        let vt = ViewTransform::fit_in_surface(PageSize::A4_PORTRAIT, 2400.0, 1080.0);
        approx(vt.scale, 1080.0 / 1684.0);
        approx(vt.pan_y, 0.0);
        // page screen width = 1190 * (1080/1684) ≈ 763; horizontal
        // margin = (2400 - 763) / 2 ≈ 819
        approx(vt.pan_x, (2400.0 - 1190.0 * (1080.0 / 1684.0)) * 0.5);
    }

    fn approx2(a: [f32; 2], b: [f32; 2]) {
        approx(a[0], b[0]);
        approx(a[1], b[1]);
    }

    #[test]
    fn point_to_segment_distance_perpendicular() {
        // Horizontal segment (0,0)→(10,0); point at (5, 3).
        // Closest point is (5, 0), distance 3, sq = 9.
        let d_sq = point_to_segment_distance_sq((5.0, 3.0), (0.0, 0.0), (10.0, 0.0));
        approx(d_sq, 9.0);
    }

    #[test]
    fn point_to_segment_distance_beyond_endpoint_clamps() {
        // Segment (0,0)→(10,0); point at (15, 0) is 5 past the end.
        // Should clamp to (10, 0), distance 5, sq = 25.
        let d_sq = point_to_segment_distance_sq((15.0, 0.0), (0.0, 0.0), (10.0, 0.0));
        approx(d_sq, 25.0);
        // Same the other way: point at (-3, 4) is past the start.
        // Closest is (0, 0), distance 5, sq = 25.
        let d_sq = point_to_segment_distance_sq((-3.0, 4.0), (0.0, 0.0), (10.0, 0.0));
        approx(d_sq, 25.0);
    }

    #[test]
    fn point_to_segment_distance_on_segment_is_zero() {
        // Diagonal segment (0,0)→(10,10); point at (5, 5) lies on it.
        let d_sq = point_to_segment_distance_sq((5.0, 5.0), (0.0, 0.0), (10.0, 10.0));
        approx(d_sq, 0.0);
    }

    #[test]
    fn point_to_segment_distance_degenerate_segment() {
        // Zero-length segment (collapsed to a point) — must not NaN.
        // Returns distance from p to that point.
        let d_sq = point_to_segment_distance_sq((3.0, 4.0), (0.0, 0.0), (0.0, 0.0));
        approx(d_sq, 25.0); // sqrt(3² + 4²)² = 25
                            // Sanity: a point ON the degenerate point.
        let d_sq = point_to_segment_distance_sq((0.0, 0.0), (0.0, 0.0), (0.0, 0.0));
        approx(d_sq, 0.0);
    }

    #[test]
    fn segment_quad_horizontal_stroke_is_a_rectangle() {
        // Horizontal segment (1, 0) → (3, 0) with uniform width 2:
        // perpendicular is (0, 1) (CCW 90° of +x). The two
        // triangles' six vertices should outline the rectangle
        // (1, ±1)–(3, ±1).
        let quad = segment_quad_positions((1.0, 0.0), (3.0, 0.0), 2.0, 2.0);
        // First triangle: a0, b0, a1 = +y at p0, -y at p0, +y at p1
        approx2(quad[0], [1.0, 1.0]);
        approx2(quad[1], [1.0, -1.0]);
        approx2(quad[2], [3.0, 1.0]);
        // Second triangle: b0, b1, a1
        approx2(quad[3], [1.0, -1.0]);
        approx2(quad[4], [3.0, -1.0]);
        approx2(quad[5], [3.0, 1.0]);
    }

    #[test]
    fn segment_quad_tapers_when_widths_differ() {
        // Same horizontal segment, but the trailing endpoint is
        // half as wide as the leading endpoint — emulates a stroke
        // where pressure dropped over time. The leading edge spans
        // y ∈ [-1, 1], the trailing edge spans y ∈ [-0.5, 0.5].
        let quad = segment_quad_positions((0.0, 0.0), (4.0, 0.0), 2.0, 1.0);
        approx2(quad[0], [0.0, 1.0]); // a0
        approx2(quad[1], [0.0, -1.0]); // b0
        approx2(quad[2], [4.0, 0.5]); // a1
        approx2(quad[4], [4.0, -0.5]); // b1
    }

    #[test]
    fn segment_quad_diagonal_uses_perpendicular_normal() {
        // 45° segment (0, 0) → (1, 1) with uniform width √2 so the
        // offsets along the perpendicular ((-√2/2, √2/2) normalised
        // = (-1/√2, 1/√2)) work out to nice unit values.
        // a0 = (0,0) + n * w/2 with n = (-1/√2, 1/√2), w/2 = √2/2
        //    = (0,0) + (-1/√2, 1/√2) * (√2/2)
        //    = (-0.5, 0.5)
        let quad = segment_quad_positions(
            (0.0, 0.0),
            (1.0, 1.0),
            std::f32::consts::SQRT_2,
            std::f32::consts::SQRT_2,
        );
        approx2(quad[0], [-0.5, 0.5]);
        approx2(quad[1], [0.5, -0.5]);
        approx2(quad[2], [0.5, 1.5]);
    }

    #[test]
    fn segment_quad_degenerate_segment_collapses() {
        // Zero-length segment shouldn't produce NaN normals — we
        // collapse it to six copies of the start position so the
        // rasteriser sees a zero-area triangle pair.
        let quad = segment_quad_positions((7.0, 9.0), (7.0, 9.0), 2.0, 2.0);
        for v in quad {
            approx2(v, [7.0, 9.0]);
        }
    }

    #[test]
    fn stroke_polyline_two_points_matches_segment_quad() {
        let points = [(1.0, 0.0), (3.0, 0.0)];
        let mesh = stroke_polyline_positions(&points, &[2.0, 2.0]);
        let quad = segment_quad_positions(points[0], points[1], 2.0, 2.0);
        assert_eq!(mesh.len(), 6);
        for (a, b) in mesh.into_iter().zip(quad) {
            approx2(a, b);
        }
    }

    #[test]
    fn stroke_polyline_keeps_center_points_fixed_at_corner() {
        let points = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)];
        let mesh = stroke_polyline_positions(&points, &[2.0, 2.0, 2.0]);
        assert_eq!(mesh.len(), 12);

        let mid_left = mesh[2];
        let mid_right = mesh[4];
        approx((mid_left[0] + mid_right[0]) * 0.5, 1.0);
        approx((mid_left[1] + mid_right[1]) * 0.5, 0.0);
    }

    #[test]
    fn surface_to_page_is_inverse_of_pan_plus_scale() {
        let vt = ViewTransform::fit_in_surface(PageSize::A4_PORTRAIT, 1080.0, 2400.0);
        // A point at the page's top-left corner in surface space:
        let [px, py] = vt.surface_to_page(vt.pan_x, vt.pan_y);
        approx(px, 0.0);
        approx(py, 0.0);
        // A point at the page's bottom-right corner in surface space:
        let br_x = vt.pan_x + vt.layout.page.width * vt.scale;
        let br_y = vt.pan_y + vt.layout.page.height * vt.scale;
        let [px, py] = vt.surface_to_page(br_x, br_y);
        approx(px, vt.layout.page.width);
        approx(py, vt.layout.page.height);
    }

    #[test]
    fn document_layout_detects_pages_and_gaps() {
        let layout = DocumentLayout::new(PageSize::A4_PORTRAIT, 3, 72.0);
        assert_eq!(layout.page_index_at(10.0, 10.0), Some(0));
        assert_eq!(
            layout.page_index_at(10.0, PageSize::A4_PORTRAIT.height + 10.0),
            None
        );
        assert_eq!(
            layout.page_index_at(10.0, PageSize::A4_PORTRAIT.height + 80.0),
            Some(1)
        );
        assert_eq!(layout.page_index_at(-1.0, 10.0), None);
    }

    #[test]
    fn zoom_around_keeps_focus_document_point_stable() {
        let layout = DocumentLayout::default_pages(3);
        let mut vt = ViewTransform::fit_layout_in_surface(layout, 1080.0, 2400.0);
        let before = vt.surface_to_page(540.0, 900.0);
        vt.zoom_around(540.0, 900.0, 2.0);
        let after = vt.surface_to_page(540.0, 900.0);
        approx(before[0], after[0]);
        approx(before[1], after[1]);
    }

    #[test]
    fn pan_clamps_against_vertical_document_bounds() {
        let layout = DocumentLayout::default_pages(4);
        let mut vt = ViewTransform::fit_layout_in_surface(layout, 1080.0, 2400.0);
        vt.pan_by(0.0, 100_000.0);
        let top_pan = vt.pan_y;
        vt.pan_by(0.0, -100_000.0);
        assert!(vt.pan_y < top_pan);
        let doc_bottom = vt.pan_y + layout.document_height() * vt.scale;
        let trailing_margin = ((vt.surface_h - layout.page.height * vt.scale) * 0.5).max(0.0);
        approx(doc_bottom, vt.surface_h - trailing_margin);
    }
}
