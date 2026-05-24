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
//!   - `ViewTransform`   — runtime mapping from page → surface
//!                         pixels. Currently always built via
//!                         `fit_in_surface` (scope #1 of C0); D6
//!                         adds user-driven pan/zoom on top.
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
    pub page: PageSize,
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
        let sw = surface_w.max(1.0);
        let sh = surface_h.max(1.0);
        let scale = (sw / page.width).min(sh / page.height);
        let page_screen_w = page.width * scale;
        let page_screen_h = page.height * scale;
        Self {
            page,
            surface_w: sw,
            surface_h: sh,
            scale,
            pan_x: (sw - page_screen_w) * 0.5,
            pan_y: (sh - page_screen_h) * 0.5,
        }
    }

    /// Inverse of the GPU transform — convert a surface-pixel touch
    /// coordinate into the page-coordinate value we'll store in the
    /// vertex buffer.
    pub fn surface_to_page(&self, sx: f32, sy: f32) -> [f32; 2] {
        [(sx - self.pan_x) / self.scale, (sy - self.pan_y) / self.scale]
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

    #[test]
    fn surface_to_page_is_inverse_of_pan_plus_scale() {
        let vt = ViewTransform::fit_in_surface(PageSize::A4_PORTRAIT, 1080.0, 2400.0);
        // A point at the page's top-left corner in surface space:
        let [px, py] = vt.surface_to_page(vt.pan_x, vt.pan_y);
        approx(px, 0.0);
        approx(py, 0.0);
        // A point at the page's bottom-right corner in surface space:
        let br_x = vt.pan_x + vt.page.width * vt.scale;
        let br_y = vt.pan_y + vt.page.height * vt.scale;
        let [px, py] = vt.surface_to_page(br_x, br_y);
        approx(px, vt.page.width);
        approx(py, vt.page.height);
    }
}
