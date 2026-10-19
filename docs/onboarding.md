# First-run setup

Fresh release installations open setup before the workspace. Existing installs
keep opening their workspace. Setup can also be opened from Settings > General >
Run setup again.

The four steps cover account connection, appearance, editing, and initial
content. The first step offers **Skip and use offline with default settings**,
or **Skip and keep current settings** for an existing vault. Managed hosting is
unavailable until a working service is configured.

Back and Continue stay in a bottom bar while the step content scrolls above it.
On phones, choices use compact rows and the progress indicator shows the current
step name. Skip floats above the footer, aligned with Continue's right edge.
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
Toolbar components. Theme, accent, UI size, editor size, and line spacing update
the sample workspace immediately. The editing step has a temporary Milkdown
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

Release startup does not seed demo folders. Finishing setup can create one
welcome or blank note, or keep existing content. Initial-note creation is
retryable and does not overwrite a note created by an earlier attempt. Import
and restore finish setup before opening their existing dialogs. Cancelling a
dialog leaves the workspace ready to use.

## Verification

```sh
pnpm test -- src/lib/api/onboarding.test.ts src/lib/hotkeys/presets.test.ts
pnpm test:e2e onboarding.spec.ts --project chromium --workers 1
cd src-tauri
cargo test --lib onboarding::tests
cargo test --lib vault_runtime::tests
```
