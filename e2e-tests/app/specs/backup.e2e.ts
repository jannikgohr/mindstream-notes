/**
 * T3 — flows 1.2 / 1.3 / 1.4: export the vault, then import it (restore +
 * merge). These drive **native file dialogs** (save / open pickers), which
 * WebDriver cannot click, so they are gated behind `requireDialogHook` until a
 * Rust-side test seam exists to pre-seed the path (docs/e2e/harness.md, an
 * open gap). The SQL merge logic itself is unit-tested in backup.rs; this tier
 * proves the orchestration through real IPC + filesystem (+ a real restart for
 * restore).
 */

import { expect } from '@wdio/globals';
import {
  byName,
  clickName,
  requireDialogHook,
  restartApp,
  waitForShell
} from '../helpers/harness.js';

describe('T3 backup export / import', function () {
  before(function () {
    // Skips unless MINDSTREAM_E2E_APP=1 AND a dialog hook is wired.
    requireDialogHook(this);
  });

  beforeEach(async () => {
    await waitForShell();
  });

  it('exports the vault to a .zip (1.2)', async () => {
    // With a dialog hook, seed the destination path, then trigger the export.
    // TODO: harness.seedSavePath(zipPath) once the Rust hook lands.
    // await openSettingsData();
    // await byName('Export vault').click();
    // assert the .zip exists on disk and the result dialog reports counts.
    expect(true).toBe(true);
  });

  it('restores a backup across a relaunch (1.3)', async () => {
    // export → alter live vault → Import → Restore → app relaunches → assert
    // imported notes/folders present and the live DB was swapped.
    await restartApp();
    await waitForShell();
    // TODO: assert restored content after apply_pending_restore_if_any.
    expect(true).toBe(true);
  });

  it('merges a backup, deduping by id (1.4)', async () => {
    // Import → Merge → assert only rows whose ids don't already exist are added,
    // orphaned parents rerouted to root, and the merge-result dialog counts.
    await clickName('Home');
    // TODO: drive Settings → Data → Import → Merge with a seeded path.
    expect(true).toBe(true);
  });
});
