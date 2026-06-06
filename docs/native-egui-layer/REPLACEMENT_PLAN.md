**Plan**

1. **Define the new boundary**
   - Create a platform-neutral ink document module with no `egui`, no `wgpu`.
   - Keep: stroke schema, Yrs/Yjs encoding, page layout, hit testing, undo/redo model, brush settings.
   - Move egui-specific UI into a deprecated/temporary adapter.

2. **Build the JS canvas ink editor**
   - Replace `InkWebNoteEditor`’s egui WASM canvas with a Svelte + TypeScript canvas editor.
   - Implement:
     - page stack rendering
     - pen strokes with pressure
     - eraser
     - undo/redo
     - pan/zoom
     - dark page theme
     - toolbar/settings in Svelte
   - Use Pointer Events, `getCoalescedEvents()`, and optionally `getPredictedEvents()`.

3. **Use the JS canvas on desktop first**
   - Make desktop ink notes use the new JS canvas editor.
   - Keep existing save/collab path.
   - Verify large notes, pan/zoom, undo/redo, and live collab behavior.

4. **Switch Android canonical rendering to WebView canvas**
   - Change Android ink note UI so the WebView canvas is the real drawing surface.
   - Stop routing canonical input through Rust/egui.
   - JS records strokes and commits them to the shared ink document.

5. **Convert Kotlin live ink into a mirror overlay**
   - Keep Kotlin `MotionEvent` capture.
   - Draw only the in-flight wet stroke with `CanvasFrontBufferedRenderer`.
   - Do not let Kotlin own persistence or stroke geometry.
   - Cancel/hide the wet overlay after JS commits the stroke.
   - Make the native layer ignore toolbar/control regions.

6. **Add an Android input tee**
   - Kotlin observes stylus samples while still letting WebView receive pointer events.
   - Match JS and Kotlin coordinates exactly.
   - Forward active brush style from JS to Kotlin: color, width, eraser/live-ink hidden state.
   - Add a simple “JS committed stroke” ack so Kotlin knows when to clear the overlay.

7. **Measure before deleting egui**
   - Compare:
     - APK/AAB size
     - note open time
     - pen latency on Tab S7 FE
     - memory use on large notes
     - save/collab correctness
   - Keep old egui path behind a dev flag until this passes.

8. **Remove egui/wgpu from Android**
   - Remove Android use of `egui`, `egui-wgpu`, `wgpu`, `egui-shadcn`, `lucide-icons` where no longer needed.
   - Keep only Rust document/save/collab code.
   - Rebuild release APK and confirm size drop.

9. **Platform live-ink follow-ups**
   - Windows: first try browser Ink API / Pointer Events in WebView2.
   - iOS: later add UIKit coalesced/predicted touch overlay.
   - macOS/Linux: stick with JS canvas unless real testing shows a problem.

**First Implementation Milestone**

Do this first: desktop JS canvas ink editor with the existing ink note schema and save path.

That proves the core bet without touching Android lifecycle complexity. Once desktop canvas feels right, Android becomes “same editor plus native wet stroke overlay,” which is a much cleaner migration.
