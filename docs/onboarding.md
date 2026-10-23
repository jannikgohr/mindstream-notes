# First-run setup

Fresh release installations open setup before the workspace. Existing installs
keep opening their workspace. Setup can also be opened from Settings > General >
Run setup again.

The four steps cover account connection, appearance, editing, and initial
content. The first step offers **Skip and use offline with default settings**,
or **Skip and keep current settings** for an existing vault. Managed hosting is
unavailable until a working service is configured.

Back and Continue stay in a bottom bar while the step content scrolls above it.
The progress indicator connects steps with lines, highlighting completed
connections. On phones, choices use compact rows and only the current step name
is shown. Skip floats above the footer, aligned with Continue's right edge.
Its faint pill background and reduced opacity keep it secondary. The mobile
footer uses 44 px touch targets with an even 8 px gutter on every side; on
devices with a home indicator the bottom safe area replaces that gutter rather
than adding to it. Extra scroll
spacing keeps the last controls clear of the button. The divider sits immediately
above Back and Continue, whose positions remain fixed across steps. Repeated
taps on Back cannot activate Skip after returning to the first screen.
The header uses the real app logo and the shared themed language dropdown,
which leads with a language icon so it reads as a language picker without the
text label phones hide. The sign-in form sits directly under the account
choices in its own single card.
The header and bottom bar respect the device's safe areas.

Appearance uses the app's shared Surface, SectionHeader, Input, Button, and
Toolbar components. Apollo, Slate & Indigo, Paper & Teal, Warm, Forest, and custom
presets provide their own light and dark accents. Preset, mode, UI size, editor
size, and line spacing update the sample workspace immediately. The preview uses
the same editor surface as the workspace. While dragging UI font size, only the
sample scales; the rest of the app applies the size on release so the slider
stays in place. Editor text size remains independent of UI size.
The editing step has a temporary Milkdown
editor, Markdown source, and a synchronized split preview. Practice changes do
not create or modify real notes.

## Development

Native dev and test launches skip onboarding. To open it explicitly, pass
`--onboarding` to the application. With the Tauri wrapper:

```sh
node src-tauri/scripts/tauri.mjs dev -- -- --onboarding
```

The two `--` separators are intentional: Tauri separates runner arguments from
application arguments. A built executable accepts `--onboarding` directly. An
already-running coordinator forwards the request to the active vault window.
An ordinary later dev/test launch skips setup again. Authentication reloads in
the same launch retain the current step.

For browser development, run `pnpm dev` and open
`http://localhost:1420/?onboarding`. The query is consumed once; browser progress
is kept locally so reloading resumes setup. Browser previews use the existing
mock vault and preserve its demo notes. Account sign-in requires the native app.

## Persistence

Native progress lives in `onboarding.json` at the environment root, outside
vault backups and sync. The coordinator initializes it before creating the
profile index. Root locking, atomic writes, and a validated previous copy protect
updates. A main window claims the flow for its vault; other vaults and popouts do
not repeat it. Progress stores the step and completion state, never credentials
or recovery keys. The existing account form owns key reveal and session adoption.

Preferences use the regular settings store and retain their device/vault scope.
Shortcut lookup uses a custom binding first, then the selected preset, then the
command default. Preset selection checks the whole effective map for conflicts;
resetting an individual binding restores preset inheritance.

Release startup does not seed demo folders. Finishing setup can add the welcome
content, create a blank note, or keep existing content. Initial-note creation is
retryable and does not overwrite a note created by an earlier attempt. Import
and restore finish setup before opening their existing dialogs. Cancelling a
dialog leaves the workspace ready to use.

The welcome content is the repo's demo notes, `demo-notes/<slug>/<lang>.md`, in
the setup language (English where a note has no file in it). See
`demo-notes/README.md` for how to add or change one. Setup renders each file in
a hidden editor with fixed options and hands the document to
`finish_onboarding`, which names the note after a hash of it and adds it only if
no note has that id. An app update never changes an existing demo note.

## Verification

```sh
pnpm test -- src/lib/api/onboarding.test.ts src/lib/hotkeys/presets.test.ts src/lib/onboarding/demo-notes.test.ts
pnpm test:e2e onboarding --project chromium --workers 1
cd src-tauri
cargo test --lib onboarding::tests
cargo test --lib demo_notes
cargo test --lib vault_runtime::tests
```

The browser suites cover opt-in development launches and fresh-install progress,
both skip labels, remote-account gating, all completion choices, settings relaunch,
temporary practice edits, live appearance previews, keyboard preset selection,
progress recovery, and import/restore cancellation. Mobile coverage includes
320 px layouts, equal step connectors, fixed bottom controls, and repeated Back
taps. They use the browser fallback store; native sign-in and the backup file
picker remain part of packaged-app validation.
