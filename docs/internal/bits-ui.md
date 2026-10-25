# Bits UI maintenance and dialog tests

Bits UI owns focus trapping, keyboard navigation, and portal behavior. App
components own workflow state. Keep those responsibilities separate when
adding a dialog or diagnosing a failure.

## Dependency changes

The current dependency is pinned to `2.19.5` and carries no patch. Do not edit
installed files or import private `bits-ui/*` modules into app code; ESLint
rejects those imports. A fix to library internals belongs in a pnpm patch
under `patches/`, listed in `patchedDependencies` in `pnpm-workspace.yaml`, so
that frozen-lockfile installation applies it in local builds and CI.

Move across a major version in a dedicated migration. Review the components
we use: Dialog, AlertDialog, Select, Popover, Tabs, and Portal, plus the
WithElementRef type. Check the release notes for the candidate version,
rather than applying examples for a different version.

For a Bits UI, Svelte, or supporting dependency update:

1. Update the manifest and lockfile together. Keep exact Bits UI versioning.
2. Review custom autofocus callbacks and dynamic dialog content. Prefer the
   library's defaults. Any override must explain its purpose and have a
   browser behavior test.
3. Run `pnpm check`, `pnpm test`, `pnpm build`, and
   `pnpm test:e2e:dialogs`. The dialog command builds production assets and
   runs the importer in Chromium and WebKit without test retries.
   The runner always starts a fresh production preview, matching CI; it fails
   if another process owns port 1440 rather than testing an unknown build.
4. Run the packaged-app tests in Linux CI. Playwright WebKit helps catch
   engine differences, but does not reproduce the WebKitGTK/native IPC
   environment completely. Ready PRs enable E2E; for a draft use the existing
   `ci:app-e2e` label or dispatch Test manually.
5. Remove a patch only when these behavior tests pass without it, including
   genuine close and reopen behavior. Record that result in this file.

Do not combine a library migration with unrelated workflow changes. A green
type check proves API compatibility, not correct focus behavior.

## Library defaults we rely on

AlertDialog focuses its content element on open, so that a screen reader
announces the title and description. ConfirmDialog, ExportResultDialog, and
ImportChoiceDialog take that default: Enter does nothing until the user tabs
to a button. `1.0.0-next.78` focused the Cancel button instead.

ImportNotesDialog overrides the default to focus its persistent Cancel/Stop
button, because the other controls are replaced at every stage change.

## Removed focus-scope patch

Until the move to `2.19.5` the project pinned `1.0.0-next.78` with a patch to
`use-focus-scope.svelte.js`. That version deferred a focus scope's removal by
a zero-delay timer. The importer changes its content from source selection to
configuration while Settings remains open, and its scope registered again
before the timer ran. The stale callback then removed the live importer scope
and resumed Settings, leaving both dialogs trapping focus. Focusing an import
field bounced between the two until the stack overflowed. The patch made the
callback skip a scope that had registered again.

Bits UI `2.8.1` rewrote the focus scope. Removal is synchronous, and only the
scope on top of the stack traps focus, so the patch has no code left to
guard. `pnpm test:e2e:dialogs` passes on `2.19.5` without it in Chromium and
WebKit.

## Dialog behavior to test

For a workflow dialog, opening it is only the first assertion. Cover the
transitions that change its DOM while another modal is open:

- Focusing and editing every important control after a stage change.
- Tab and Shift+Tab wrapping inside the active dialog.
- A running operation with its promise held open, including disabled controls
  and Escape behavior.
- Failure, retained choices, and retry.
- Both immediate completion and delayed completion, including replacement
  with a result dialog.
- Closing the top dialog, automatic return of focus, and reopening it.

Assert `toBeFocused()` or containment in the active dialog. Do not manually
focus the underlying trigger before asserting restoration, since that masks
broken cleanup. Collect unexpected page errors during the workflow so a
stack overflow cannot pass merely because the screen eventually looks right.

The importer browser tests stub only native commands and tree refresh. They
use the real Svelte components and Bits UI, without injecting fake focus
behavior. The packaged-app test checks imported content, links, assets,
hierarchy, and persistence across restart. Keep that native test focused on
the real data round trip; the faster browser tests cover failure branches.

## When a native test hangs

Identify the last command that started without returning. Capture HTML and
focus state before risky transitions, and use independent X11 screenshots
when the WebDriver connection cannot respond. A page-side timeout cannot
interrupt synchronous focus recursion, and a failure hook after session
deletion cannot retrieve DOM or screenshots.

Keep the current command trace, bounded captures, and CI artifact upload.
Reproduce on the exact failing revision with a fresh production build before
changing product code. Replace sleeps and deferred clicks with observable
states; increases to retries or timeouts need evidence of an environment
failure rather than a repeatable product bug.
