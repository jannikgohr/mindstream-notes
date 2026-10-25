# Android document export save fix

This follows the [failed native save check](android-plugin-validation-2026-10-24.md#native-source-save-failure).
That run generated correct Typst source but rejected the Android picker's
`content://` URI and left an empty document.

## Change

The Android build now initializes `tauri-plugin-fs`, already present as a
transitive dependency of the dialog plugin. The export command passes the
picker's `FilePath` to `FsExt::open` instead of converting it to a filesystem
path. Tauri opens the URI through Android's ContentResolver and transfers the
descriptor to Rust. Write and truncate options request `wt`, avoiding the
provider-dependent truncation behavior of `w`.

Opening and writing run on a blocking worker. Its vault job remains alive
until the write completes, including when the invoking command is dropped.
Cancellation still returns `false`, and write failures propagate as errors.
Both generic file exports and the legacy PDF command share this path.
Desktop and iOS keep filesystem-path writing. No frontend filesystem
permissions, Android storage permissions, execution budgets or plugin trust
checks were added or relaxed.

The Android API documents URI access and write modes in
[ContentResolver](<https://developer.android.com/reference/android/content/ContentResolver#openAssetFileDescriptor(android.net.Uri,java.lang.String)>).
The implementation uses the locked Tauri filesystem plugin version 2.5.1.

## Validation

Device: Samsung SM-T733, ARM64, Android 14/API 34, WebView 156.0.8078.47,
USB powered. Tests used the disposable
`com.jannikgohr.mindstream_notes.android_validation` package and the real
Android DocumentsUI picker targeting Downloads. The device checks ran on
2026-10-25, 00:45–00:48 UTC, in a release build with `tauri/devtools` solely
for invoking the native command from the installed WebView. No profiling
timers or test-only destination arguments were added to production code.

| Device check                                                     | Result                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| Real Typst guest source export through `save_file_export`        | Pass, all 64 bytes match, including Unicode and line breaks         |
| Legacy `save_pdf_export`, 256 KiB binary pattern with PDF header | Pass, byte-for-byte match across every byte value                   |
| Intentionally empty generic export                               | Pass, returns `true` and writes an empty document                   |
| Cancel generic export                                            | Pass, returns `false`, no document created                          |
| Cancel legacy PDF export                                         | Pass, returns `false`, no document created                          |
| Save after both cancellations                                    | Pass, all 32 bytes match                                            |
| Explicit replacement of existing document                        | Pass, a 64-byte file becomes exactly 6 bytes, with no trailing data |

The replacement flow requires tapping the existing document, pressing Save,
then confirming Replace. Pressing Save directly with an existing name creates
a numbered copy. The test confirmed both behaviors and retained the output
bytes. The binary PDF test checks transport and writing, not PDF validity.
Only the local Downloads document provider was exercised; cloud providers
remain unmeasured.

Checks before committing:

- `cargo fmt --manifest-path src-tauri/Cargo.toml --all --check`: pass.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --workspace --all-targets -- -D warnings`:
  pass on Windows.
- `cargo test --manifest-path src-tauri/Cargo.toml --locked --workspace -- --test-threads=1`:
  1,119 passed, 6 ignored on Windows. The export tests include binary saves,
  shorter replacement through a file URL, rejection of document URIs on
  desktop, filesystem failures and filter validation.
- Targeted frontend export API/result-dialog suites: 20 passed.
- Android ARM64 `cargo check`: pass. The Android build reports existing
  unused-import/dead-code warnings; the Windows Clippy check is the
  warnings-as-errors result above.

The normal release APK and AAB both built successfully. The normal APK was
installed over the diagnostic build and launched with no WebView debugging
socket. Its mobile note context menu currently exposes Select, Rename, Move
and Delete, with no Export action. Consequently the byte-level export checks
above establish the native command path in the diagnostic release, not an
end-to-end Export-menu check in the normal mobile UI. Normal installation and
startup were checked separately.

The fixed normal build remains installed on the disposable package. All five
owned Downloads fixtures were removed. The two pre-existing test apps and
their data were preserved, the original 30-minute screen timeout remains,
and the disposable application-ID changes were reverted before committing.

## Evidence and attempts

The ignored local folder `.output/android-export-fix-2026-10-25/` retains
command transcripts, scripts, picker XML, screenshots, expected and actual
bytes, `device-results.json`, build logs and diagnostic artifacts.

The unchanged product fix is committed as
`5456a8a742f6ebc86815535f01776c1d5dc68361`.
The build source was `d162acb55ee86e95e513fcfb4361fe6b3f570c76` plus
`product.patch`, whose SHA-256 is
`21b1bab8f0f5f9e56661ae62cfdbdbf3cd89180c52757eb11619d2ef0d9e2b71`.
That patch contains the four product files only; the separate disposable-ID
patch from the original validation run was also applied for packaging.
The frontend build from the original validated revision was reused because
this fix changes no frontend code.

The successful diagnostic APK SHA-256 is
`e53fb597a93503e3cfcf7b78f0115a6cd958b30402785ddbbdabc740a7c8b54a`.
The normal APK SHA-256 is
`d808e6bed98e7606f97d5a8b79e0f43fa6c165d9024cf03d4933003258a68c8d`.
The normal AAB SHA-256 is
`d25b289c37c4c7a170523a2a1d6847c8690eadee41ed073ce5074bd5d298da6a`.
Bundletool validation and ZIP integrity checks passed. The artifacts contain
ARM64 native libraries only. The final checksum manifest covers 107 evidence
files, excluding the host build cache. Its SHA-256 is
`563f418e916c021cb7410161e42e9c64dbb7cb42adcfeb4b57ee5851488884a7`.

Failed harness attempts are retained, not discarded:

- The first `uiautomator dump` exited 137. Retrying succeeded; the original
  pending Typst save was resumed and its actual bytes matched.
- An initial overwrite assertion expected direct Save to replace a file.
  DocumentsUI instead created a numbered file. Tapping an existing item only
  selected it; waiting for completion without pressing Save timed out.
  The corrected sequence pressed Save and confirmed Replace.
- Reading the numbered file with literal shell quotes through `adb exec-out`
  failed. `adb pull` handled the filename and verified its bytes. The actual
  replacement had already succeeded, and its six bytes were independently
  read successfully before this harness failure.

There were no observed native export/write errors in the fixed app during
these checks. The original validation and profiling evidence folders were
left unchanged.

## Performance follow-up

[Issue #116](https://github.com/jannikgohr/mindstream-notes/issues/116) tracks
signed-plugin lock contention, repeated integrity hashing and representative
third-party editor responsiveness. The [phase profile](android-plugin-profile-2026-10-24.md)
remains the performance evidence; this save fix makes no plugin-latency claim.

The editor's input handler updates source and schedules rendering through a
timer without awaiting the plugin. Its default debounce is 250 ms, overridable
by a contribution. This keeps invocation completion separate from input
handling, but does not establish typing or preview latency for arbitrary
third-party renderers. The 10 ms p95 frequent-hook goal remains open.
