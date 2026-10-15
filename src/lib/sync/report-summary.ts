/**
 * What the sync form says after a sync started by hand.
 *
 * One line: what came down, what went up, what was merged. A sync that
 * moved nothing reads "Already up to date", unless the server took nothing
 * new for some space because a limit was reached. Then there are changes on
 * this device the server does not have, and saying "up to date" would be
 * wrong. The notice in the notification panel says which limit it was.
 */

import type { SyncReport } from '$lib/api/sync';
import { tUi, tUiFormat } from '$lib/settings/i18n.svelte';

export function summariseSyncReport(report: SyncReport): string {
  const parts: string[] = [];
  if (report.notes_pulled || report.folders_pulled) {
    parts.push(
      tUiFormat('account.sync.pulled', {
        notes: report.notes_pulled,
        folders: report.folders_pulled
      })
    );
  }
  if (report.notes_pushed || report.folders_pushed) {
    parts.push(
      tUiFormat('account.sync.pushed', {
        notes: report.notes_pushed,
        folders: report.folders_pushed
      })
    );
  }
  if (report.conflicts_resolved) {
    parts.push(
      tUiFormat('account.sync.conflicts', {
        count: report.conflicts_resolved
      })
    );
  }
  if (report.held_back) parts.push(tUi('account.sync.heldBack'));
  return parts.length > 0 ? parts.join(' · ') : tUi('account.sync.upToDate');
}
