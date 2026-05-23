// Minimal line shader for the POC.
// Vertices arrive pre-projected into NDC by render.rs::to_ndc, so the
// vertex stage is just a coordinate pass-through. The fragment stage
// emits opaque black; colour selection (and stroke width) come later
// when the toolbar lands.

struct VsIn {
    @location(0) position: vec2<f32>,
};

@vertex
fn vs_main(in: VsIn) -> @builtin(position) vec4<f32> {
    return vec4<f32>(in.position, 0.0, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
}
