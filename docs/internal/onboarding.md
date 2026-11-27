# First-run setup

Fresh release installations open setup before the workspace. Existing installs
keep opening their workspace. Setup can also be opened from Settings → General →
**Run setup again**.

The four steps cover account connection, appearance, editing, and initial
content. The first step offers **Skip and use offline with default settings**,
or **Skip and keep current settings** for an existing vault. Managed hosting is
unavailable until a working service is configured.

Preset, mode, UI size, editor size and line spacing update the sample
workspace immediately. While dragging UI font size only the sample scales; the
rest of the app applies the size on release, so the slider stays under the
pointer. The editing step uses a temporary Milkdown editor, Markdown source and
a split preview. Practice changes do not create or modify real notes.

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
is kept locally so reloading resumes setup. Account sign-in requires the native
app.

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

The welcome content lives in `src/lib/onboarding/demo-notes/<slug>/<lang>.md`,
in the setup language (English where a note has no file in it). See
`src/lib/onboarding/demo-notes/README.md` for how to add or change one. Setup
renders each file in a hidden editor with fixed options and hands the document to
`finish_onboarding`, which names the note after a hash of it and adds it only if
no note has that id. An app update never changes an existing demo note.

The "Welcome notes" choice adds an introduction, sync and live collaboration,
import/export and backup, and everyday tips in English or German. The welcome
note opens first. Links between demo notes are resolved to the target note's
content-derived ID before rendering, so they keep working after a rename. The
browser build uses the same IDs and editor state as native setup.

## Tests

The browser suite (`e2e-tests/browser/onboarding.spec.ts`) runs against the mock
store, so native sign-in and the backup file picker remain part of packaged-app
validation.
