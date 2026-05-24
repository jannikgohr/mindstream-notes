// Line shader for the canvas.
//
// Vertices arrive in PAGE COORDINATES (1 unit = 1/144 inch by
// default; see drawing/page.rs). We map page → screen via the view
// uniform (`scale` + `pan`), then screen → NDC for the rasteriser.
// This keeps stored vertices stable across rotations / re-attaches:
// the view transform is the only thing that changes per-surface, and
// it lives in the uniform buffer.

struct ViewUniform {
    scale: f32,
    pan: vec2<f32>,
    surface_dims: vec2<f32>,
}

@group(0) @binding(0) var<uniform> view: ViewUniform;

struct VsIn {
    @location(0) position: vec2<f32>,
    @location(1) color: vec4<f32>,
};

struct VsOut {
    @builtin(position) clip_pos: vec4<f32>,
    @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(in: VsIn) -> VsOut {
    let screen = in.position * view.scale + view.pan;
    // Surface origin is top-left, NDC origin is centre with Y up —
    // hence the (1 - 2y) flip on Y.
    let ndc = vec2<f32>(
        screen.x / view.surface_dims.x * 2.0 - 1.0,
        1.0 - screen.y / view.surface_dims.y * 2.0,
    );
    var out: VsOut;
    out.clip_pos = vec4<f32>(ndc, 0.0, 1.0);
    out.color = in.color;
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    return in.color;
}
