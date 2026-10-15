import { afterEach, describe, expect, it } from 'vitest';
import type { SyncReport } from '$lib/api/sync';
import { setLanguage } from '$lib/settings/i18n.svelte';
import { summariseSyncReport } from './report-summary';

const NOTHING: SyncReport = {
  folders_pulled: 0,
  folders_pushed: 0,
  notes_pulled: 0,
  notes_pushed: 0,
  assets_pulled: 0,
  assets_pushed: 0,
  conflicts_resolved: 0,
  held_back: 0
};
const HELD_BACK = 'Some changes were not sent, see the notifications';

afterEach(() => setLanguage('en'));

describe('summariseSyncReport', () => {
  it('says so when there was nothing to do', () => {
    expect(summariseSyncReport(NOTHING)).toBe('Already up to date');
  });

  it('says what came down, what went up and what was merged', () => {
    expect(
      summariseSyncReport({
        ...NOTHING,
        notes_pulled: 3,
        folders_pulled: 1,
        notes_pushed: 2,
        conflicts_resolved: 1
      })
    ).toBe(
      'Notes pulled: 3, folders: 1 · Notes pushed: 2, folders: 0 · Conflicts merged: 1'
    );
  });

  it('does not call a sync up to date when the server held changes back', () => {
    expect(summariseSyncReport({ ...NOTHING, held_back: 1 })).toBe(HELD_BACK);
    expect(summariseSyncReport({ ...NOTHING, held_back: 2 })).toBe(HELD_BACK);
  });

  it('says what was sent and what was held back side by side', () => {
    expect(
      summariseSyncReport({ ...NOTHING, notes_pushed: 2, held_back: 1 })
    ).toBe(`Notes pushed: 2, folders: 0 · ${HELD_BACK}`);
  });

  it('says it in German too', () => {
    setLanguage('de');
    expect(summariseSyncReport({ ...NOTHING, held_back: 1 })).toBe(
      'Einige Änderungen wurden nicht gesendet, siehe Benachrichtigungen'
    );
  });
});
