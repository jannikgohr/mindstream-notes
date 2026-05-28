# Shared Ink Core Plan

## Goal

Desktop ink notes should render inside Dockview without native overlay
windows, while still looking and behaving like the Android native egui
surface. The way to get there is to extract the portable ink document,
page, and egui UI code from `src-tauri/src/drawing` into a shared Rust
crate consumed by both render paths.

## Target Architecture

- `crates/ink-core`
  - Owns portable, platform-neutral ink code.
  - Includes page layout, input model, yrs stroke document, egui toolbar,
    theme, color picker, and brush picker.
  - Must not depend on Tauri, JNI/NDK, raw native window handles, or
    `wgpu::Surface`.

- `src-tauri/src/drawing`
  - Owns native adapters only: Android SurfaceView bridge, wgpu surface
    pipeline, render thread, save worker, and platform lifecycle glue.
  - Re-exports shared `ink-core` modules during migration so existing
    native code keeps its current module paths.

- `crates/ink-egui-web`
  - Owns the desktop web adapter: `eframe::WebRunner`, canvas mount, JS
    save callback, and browser input/event wiring.
  - Imports `ink-core` for the document model and, next, the real shared
    `CanvasUi` toolbar.

## Migration Steps

1. Create `crates/ink-core` with copied portable modules.
2. Patch shared UI paths so they are crate-local instead of
   `crate::drawing::*`.
3. Make the Tauri drawing module re-export `ink-core` modules.
4. Make `ink-egui-web` depend on `ink-core` and delete its duplicated
   stroke/page serialization code.
5. Replace the temporary web toolbar with shared `ink_core::ui::CanvasUi`.
6. Move the remaining portable stroke tessellation/smoothing helpers into
   `ink-core` so the web renderer can match native stroke feel.
7. Retire the desktop native overlay commands once the web path reaches
   feature parity.

## Current Status

- Step 1: Done. `crates/ink-core` now owns the copied portable modules.
- Step 2: Done. Shared UI/stroke docs now use crate-local paths.
- Step 3: Done. `src-tauri/src/drawing` re-exports the shared modules so
  native code keeps its current imports.
- Step 4: Done for the document/page model. `ink-egui-web` depends on
  `ink-core`, uses shared `StrokesDoc`, and uses shared page layout math.
- Step 5: Pending.
- Step 6: Pending.
- Step 7: Pending.

## Verification

- `cargo check --manifest-path crates/ink-core/Cargo.toml`
- `cargo check --manifest-path crates/ink-core/Cargo.toml --target wasm32-unknown-unknown`
- `cargo check --manifest-path crates/ink-egui-web/Cargo.toml --target wasm32-unknown-unknown`
- `cargo check` in `src-tauri`
- `cargo check --target aarch64-linux-android` in `src-tauri`
- `cargo test --manifest-path crates/ink-core/Cargo.toml`
- `cargo clippy --manifest-path crates/ink-egui-web/Cargo.toml --target wasm32-unknown-unknown -- -D warnings`
- `pnpm check`
- `pnpm build`
- `git diff --check`

## Notes

The current desktop web implementation is intentionally only a first
slice. Its visual mismatch comes from using a small standalone egui app
instead of the native `CanvasUi`. The shared-core extraction is the bridge
from "works inside Dockview" to "same Samsung Notes-style toolbar and
settings across Android and desktop."
