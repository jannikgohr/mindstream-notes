# Ink Replacement Measurement

This page is the step 7 gate for deleting the old native egui/wgpu ink
stack from Android. The canonical editor is now the Svelte canvas; the
native Android layer is only the live wet-stroke overlay.

## Snapshot Command

Run this after building the app you want to measure:

```bash
pnpm measure:ink-replacement
```

The command prints a Markdown snapshot with:

- current commit and working-tree state
- native ink dependencies still present in `src-tauri/Cargo.toml`
- Android APK/AAB outputs found under Gradle build outputs
- packaged Android `libmindstream_notes_lib.so` sizes
- local Cargo native library outputs
- remaining egui WASM package files, if any

Use the same command before and after step 8. The size delta should be
captured for the APK/AAB and the Android native library for each ABI.

## Device Metrics

Collect these on the same device and build type before removing egui,
then repeat after removal.

| Metric                  | How to collect                                                                             | Pass condition                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| APK/AAB size            | `pnpm measure:ink-replacement` after Android build                                         | Step 8 should reduce Android package size materially                      |
| Native library size     | `pnpm measure:ink-replacement`                                                             | `libmindstream_notes_lib.so` should shrink materially per ABI             |
| Ink note open time      | Browser/WebView console line `[ink.perf] web_open ... first_draw_ms=...`                   | No regression versus current JS-canvas baseline                           |
| Android live ink        | Draw on Tab S7 FE with S Pen                                                               | Wet stroke appears, clears after JS commit, no duplicate committed stroke |
| S Pen side button       | Hold side button while drawing                                                             | Erases committed strokes; no live-ink or canvas pen stroke is created     |
| Page bounds             | Draw across page edge                                                                      | No committed points outside page bounds                                   |
| Undo/redo               | Draw, undo, redo, erase, undo                                                              | Buttons enable correctly and mutate the canvas                            |
| Memory on large note    | `adb shell dumpsys meminfo com.jannikgohr.mindstream_notes` after opening a large ink note | No increase versus current baseline                                       |
| Save correctness        | Draw, navigate away, reopen                                                                | Stroke state persists                                                     |
| Live collab correctness | Two clients edit same ink note                                                             | Remote strokes converge; no duplicate local echo                          |

## Useful Commands

Windows PowerShell:

```powershell
adb logcat -c
# Open an ink note, draw, erase, navigate away/reopen.
adb logcat -d | Select-String "\[ink.perf\]|\[drawing.perf\]|\[ink-collab\]"
adb shell dumpsys meminfo com.jannikgohr.mindstream_notes
```

Android build artifacts vary by build route. If the snapshot reports no
APK/AAB outputs, build Android first and rerun it.
