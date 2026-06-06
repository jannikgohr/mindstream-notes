# egui Ink Replacement Plan

## Goal

Make the browser canvas the canonical ink surface and keep native
live-ink layers as optional latency helpers. Android keeps Kotlin
`MotionEvent` + `CanvasFrontBufferedRenderer` for the wet stroke, but
Svelte/TypeScript owns the toolbar, committed rendering, and document
mutations.

## Commit Discipline

Each numbered step below should land as its own commit with a
commitlint-compatible message (`type(scope): summary`). If a later step
needs to change this plan, update this file in that step's commit.

## Steps

1. **Define the new boundary** - Done
   - Create a platform-neutral ink document module with no `egui` and
     no `wgpu`.
   - Keep: stroke schema, Yrs/Yjs encoding, page layout, hit testing,
     undo/redo model, and brush settings.
   - Move egui-specific UI into a deprecated/temporary adapter.

2. **Build the JS canvas ink editor** - Done
   - Replace `InkWebNoteEditor`'s egui WASM canvas with a Svelte +
     TypeScript canvas editor.
   - Implement page-stack rendering, pen strokes with pressure, eraser,
     undo/redo, pan/zoom, dark page theme, and Svelte toolbar/settings.
   - Use Pointer Events, `getCoalescedEvents()`, and optionally
     `getPredictedEvents()`.

3. **Use the JS canvas on desktop first** - Done
   - Make desktop ink notes use the new JS canvas editor.
   - Keep the existing save/collab path.
   - Verify large notes, pan/zoom, undo/redo, and live collab behavior.

4. **Switch Android canonical rendering to WebView canvas** - Done
   - Change Android ink note UI so the WebView canvas is the real
     drawing surface.
   - Stop routing canonical input through Rust/egui.
   - JS records strokes and commits them to the shared ink document.

5. **Convert Kotlin live ink into a mirror overlay** - In progress
   - Keep Kotlin `MotionEvent` capture.
   - Draw only the in-flight wet stroke with
     `CanvasFrontBufferedRenderer`.
   - Do not let Kotlin own persistence or stroke geometry.
   - Cancel/hide the wet overlay after JS commits the stroke.
   - Make the native layer ignore toolbar/control regions.
   - Implementation exists; needs Android stylus validation.

6. **Add an Android input tee** - In progress
   - Kotlin observes stylus samples while still letting WebView receive
     pointer events.
   - Match JS and Kotlin coordinates exactly.
   - Forward active brush style from JS to Kotlin: color, width, and
     eraser/live-ink hidden state.
   - Add a simple "JS committed stroke" ack so Kotlin knows when to
     clear the overlay.
   - Implementation exists; needs Android stylus validation.

7. **Measure before deleting egui** - Pending
   - Compare APK/AAB size, note-open time, Tab S7 FE pen latency, memory
     use on large notes, and save/collab correctness.
   - Keep the old egui path behind a dev flag until this passes.

8. **Remove egui/wgpu from Android** - Pending
   - Remove Android use of `egui`, `egui-wgpu`, `wgpu`, `egui-shadcn`,
     and `lucide-icons` where no longer needed.
   - Keep only Rust document/save/collab code.
   - Rebuild release APK and confirm size drop.

## Out of Scope For This Pass

Platform live-ink follow-ups beyond Android are intentionally skipped
for now. Windows browser Ink API, iOS UIKit/PencilKit overlays, and
macOS/Linux native tablet integrations require device-specific testing
and product choices before implementation.

## First Implementation Milestone

Start with the desktop JS canvas ink editor using the existing ink note
schema and save path. That proves the core bet before changing Android
lifecycle behavior; Android then becomes the same editor plus a native
wet-stroke overlay.
