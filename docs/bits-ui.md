# Bits UI maintenance and dialog tests

Bits UI owns focus trapping, keyboard navigation, and portal behavior. App
components own workflow state. Keep those responsibilities separate when
adding a dialog or diagnosing a failure.

## Dependency changes

The current dependency is pinned to `1.0.0-next.78` with a pnpm patch in
[`patches/`](../patches/README.md). Frozen-lockfile installation applies the
patch in local builds and CI. Do not edit installed files or import private
`bits-ui/*` modules into app code; ESLint rejects those imports.

Move to a stable release in a dedicated migration. Bits UI's
[migration guide](https://www.bits-ui.com/docs/migration-guide) warns that
component APIs changed across the prerelease boundary. Review the components
we use: Dialog, AlertDialog, Select, Popover, Tabs, and Portal, plus the
WithElementRef type. Check the guide and release notes for the candidate
version, rather than applying examples for a different version.

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
5. Remove the patch only when these behavior tests pass without it, including
   genuine close and reopen behavior. Update the patch notes with that result.

Do not combine a library migration with unrelated workflow changes. A green
type check proves API compatibility, not correct focus behavior.

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
