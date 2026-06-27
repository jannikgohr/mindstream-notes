/**
 * Note-history retention: read the user's "Keep edit history for" setting and
 * sweep versions older than the cutoff. Local-only and best-effort; runs once
 * on app start (see the desktop/mobile layout mounts).
 */

import { pruneNoteVersions } from '$lib/api';
import { getSettingValue } from '$lib/settings/store.svelte';

/**
 * The configured retention in days, or `null` for "Forever". Defaults to
 * forever for any unexpected value so we never delete history unintentionally.
 */
export function historyRetentionDays(): number | null {
  const v = getSettingValue('data.historyRetentionDays');
  if (v === 'forever' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Sweep history older than the configured retention. Never throws. */
export async function pruneHistoryOnStartup(): Promise<void> {
  try {
    await pruneNoteVersions(historyRetentionDays());
  } catch (err) {
    console.debug('[history] retention sweep failed', err);
  }
}
