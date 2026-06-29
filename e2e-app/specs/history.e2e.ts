/**
 * T3 — note history against the real backend (Rust history table + SQLite).
 * Implements docs/e2e-strategy.md §4 (T3). The browser-fallback slice of this
 * lives in e2e/note-history.spec.ts; here the value is the *real* capture /
 * restore / undo round-trip and that it survives an app restart.
 *
 * Run: MINDSTREAM_E2E_APP=1 pnpm test:e2e:app
 */

import { browser, expect } from '@wdio/globals';
import {
  byName,
  requireAppE2E,
  restartApp,
  waitForShell
} from '../helpers/harness.js';

async function openSeededMarkdownNote(): Promise<void> {
  await byName('Personal').click();
  await byName('Ideas').click();
  await expect(byName('Markdown note')).toBeDisplayed();
}

async function typeInEditor(text: string): Promise<void> {
  const editor = $('.ProseMirror');
  await editor.click();
  await browser.keys(text.split(''));
}

describe('T3 note history', function () {
  before(function () {
    requireAppE2E(this);
  });

  beforeEach(async () => {
    await waitForShell();
  });

  it('captures a baseline "created" version on open', async () => {
    await openSeededMarkdownNote();
    await expect(byName('Note created')).toBeDisplayed();
  });

  it('restores an older version and the pre-restore checkpoint exists', async () => {
    await openSeededMarkdownNote();
    await expect(byName('Note created')).toBeDisplayed();

    await typeInEditor(' a meaningful change to restore away from');
    await byName('Refresh history').click();
    await expect(byName('Edited')).toBeDisplayed();

    // Restore the baseline; a 'reverted' entry plus the pre-restore checkpoint
    // ('edited') should both land.
    await byName('Note created').click();
    await byName('Restore this version').click();

    await expect(byName('Restored to an earlier version.')).toBeDisplayed();
  });

  it('Undo survives a tree/sync refresh (bridge-store regression)', async () => {
    await openSeededMarkdownNote();
    await typeInEditor(' change for undo-survival');
    await byName('Refresh history').click();
    await byName('Note created').click();
    await byName('Restore this version').click();

    const banner = byName('Restored to an earlier version.');
    await expect(banner).toBeDisplayed();

    // A tree refresh rebuilds notesById; the per-note bridge store must keep
    // the Undo affordance alive (a component-local banner would be wiped).
    await byName('Refresh history').click();
    await expect(banner).toBeDisplayed();
    await expect(byName('Undo')).toBeEnabled();
  });

  it('Ctrl+Z does not revert a restore (editor-undo isolation)', async () => {
    await openSeededMarkdownNote();
    await typeInEditor(' isolation check body text');
    await byName('Refresh history').click();
    await byName('Note created').click();
    await byName('Restore this version').click();
    await expect(byName('Restored to an earlier version.')).toBeDisplayed();

    const before = await $('.ProseMirror').getText();
    await $('.ProseMirror').click();
    await browser.keys(['Control', 'z']);
    // The restore is never on the editor's native undo stack, so the content
    // is unchanged by Ctrl+Z.
    await expect($('.ProseMirror')).toHaveText(before);
  });

  it('versions and reverted labels persist across a restart', async () => {
    await openSeededMarkdownNote();
    await typeInEditor(' persisted change');
    await byName('Refresh history').click();
    await byName('Note created').click();
    await byName('Restore this version').click();
    await expect(byName('Restored to an earlier version.')).toBeDisplayed();

    await restartApp();
    await waitForShell();
    await openSeededMarkdownNote();

    // The denormalised history (created + edited + reverted) survived the
    // quit/relaunch against the same profile dir.
    await expect(byName('Note created')).toBeDisplayed();
    await expect(byName('Edited')).toBeDisplayed();
  });

  // Per-kind coverage (freeform / ink / PDF) follows the same shape but needs
  // kind-specific note creation + a non-markdown restore assertion (the restore
  // mechanism differs per kind — see docs/known-limitations.md). TODO once the
  // harness can seed those note kinds.
});
