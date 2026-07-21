import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captureCurrentNoteVersion =
  vi.fn<(noteId: string, action: string) => Promise<boolean>>();
const bumpNoteHistory = vi.fn<(noteId: string) => void>();
const getSettingValue = vi.fn<(key: string) => unknown>();

vi.mock('$lib/api/history', () => ({
  captureCurrentNoteVersion: (noteId: string, action: string) =>
    captureCurrentNoteVersion(noteId, action)
}));
vi.mock('$lib/stores/note-history-bridge.svelte', () => ({
  bumpNoteHistory: (noteId: string) => bumpNoteHistory(noteId)
}));
vi.mock('$lib/settings/store.svelte', () => ({
  getSettingValue: (key: string) => getSettingValue(key)
}));

const { HISTORY_IDLE_DEFAULT_S, createHistoryCapture, historyIdleMs } =
  await import('./capture-scheduler');

function make(overrides: Partial<Parameters<typeof createHistoryCapture>[0]>) {
  return createHistoryCapture({
    noteId: () => 'note-1',
    label: 'Test',
    isTrashed: () => false,
    isReady: () => true,
    mode: 'debounce',
    snapshotNowRequiresDirty: true,
    ...overrides
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  captureCurrentNoteVersion.mockReset().mockResolvedValue(true);
  bumpNoteHistory.mockReset();
  getSettingValue.mockReset().mockReturnValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('historyIdleMs', () => {
  it('falls back to the default when the setting is absent or invalid', () => {
    for (const value of [undefined, 'abc', 0, -5]) {
      getSettingValue.mockReturnValue(value);
      expect(historyIdleMs()).toBe(HISTORY_IDLE_DEFAULT_S * 1000);
    }
  });

  it('uses the configured number of seconds', () => {
    getSettingValue.mockReturnValue(30);
    expect(historyIdleMs()).toBe(30_000);
  });
});

describe('scheduling', () => {
  it('captures once the idle delay elapses', async () => {
    const history = make({});
    history.schedule();

    expect(captureCurrentNoteVersion).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HISTORY_IDLE_DEFAULT_S * 1000);

    expect(captureCurrentNoteVersion).toHaveBeenCalledWith('note-1', 'edited');
    expect(bumpNoteHistory).toHaveBeenCalledWith('note-1');
  });

  it('does not bump history when no version was created', async () => {
    captureCurrentNoteVersion.mockResolvedValue(false);
    const history = make({});
    history.schedule();
    await vi.advanceTimersByTimeAsync(HISTORY_IDLE_DEFAULT_S * 1000);

    expect(bumpNoteHistory).not.toHaveBeenCalled();
  });

  it('never captures for a trashed note', async () => {
    const history = make({ isTrashed: () => true });
    history.schedule();
    await vi.advanceTimersByTimeAsync(HISTORY_IDLE_DEFAULT_S * 1000);

    expect(captureCurrentNoteVersion).not.toHaveBeenCalled();
  });

  it('waits until the doc is ready', async () => {
    const history = make({ isReady: () => false });
    history.schedule();
    await vi.advanceTimersByTimeAsync(HISTORY_IDLE_DEFAULT_S * 1000);

    expect(captureCurrentNoteVersion).not.toHaveBeenCalled();
  });

  it('reads the note id when the capture fires, not when it was armed', async () => {
    let noteId = 'first';
    const history = make({ noteId: () => noteId });
    history.schedule();
    noteId = 'second';
    await vi.advanceTimersByTimeAsync(HISTORY_IDLE_DEFAULT_S * 1000);

    expect(captureCurrentNoteVersion).toHaveBeenCalledWith('second', 'edited');
  });

  it('survives a failing capture', async () => {
    captureCurrentNoteVersion.mockRejectedValue(new Error('offline'));
    const history = make({});
    history.schedule();

    await expect(
      vi.advanceTimersByTimeAsync(HISTORY_IDLE_DEFAULT_S * 1000)
    ).resolves.not.toThrow();
    expect(bumpNoteHistory).not.toHaveBeenCalled();
  });
});

describe('debounce mode', () => {
  it('restarts the timer on every edit', async () => {
    getSettingValue.mockReturnValue(10);
    const history = make({ mode: 'debounce' });

    history.schedule();
    await vi.advanceTimersByTimeAsync(6000);
    history.schedule();
    await vi.advanceTimersByTimeAsync(6000);

    // The second edit pushed the deadline out, so 12s in nothing has fired.
    expect(captureCurrentNoteVersion).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4000);
    expect(captureCurrentNoteVersion).toHaveBeenCalledTimes(1);
  });
});

describe('deadline mode', () => {
  it('keeps the original deadline when further edits arrive', async () => {
    getSettingValue.mockReturnValue(10);
    const history = make({ mode: 'deadline' });

    history.schedule();
    await vi.advanceTimersByTimeAsync(6000);
    history.schedule();
    await vi.advanceTimersByTimeAsync(4000);

    // Fires 10s after the *first* edit, regardless of the second.
    expect(captureCurrentNoteVersion).toHaveBeenCalledTimes(1);
  });
});

describe('capture', () => {
  it('skips an edited capture when nothing changed', async () => {
    const history = make({});
    await history.capture('edited');
    expect(captureCurrentNoteVersion).not.toHaveBeenCalled();
  });

  it('always runs an explicit action', async () => {
    const history = make({});
    await history.capture('created');
    expect(captureCurrentNoteVersion).toHaveBeenCalledWith('note-1', 'created');
  });

  it('clears the dirty flag so a second edited capture no-ops', async () => {
    const history = make({});
    history.schedule();
    expect(history.dirty).toBe(true);

    await history.capture('edited');
    expect(history.dirty).toBe(false);

    await history.capture('edited');
    expect(captureCurrentNoteVersion).toHaveBeenCalledTimes(1);
  });
});

describe('snapshotNow', () => {
  it('captures immediately and disarms the pending timer', async () => {
    const history = make({});
    history.schedule();

    await history.snapshotNow();
    expect(captureCurrentNoteVersion).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(HISTORY_IDLE_DEFAULT_S * 1000);
    expect(captureCurrentNoteVersion).toHaveBeenCalledTimes(1);
  });

  it('no-ops on a clean note when the caller asks it to', async () => {
    const history = make({ snapshotNowRequiresDirty: true });
    await history.snapshotNow();
    expect(captureCurrentNoteVersion).not.toHaveBeenCalled();
  });

  it('still no-ops on a clean note via the dirty guard in capture', async () => {
    const history = make({ snapshotNowRequiresDirty: false });
    await history.snapshotNow();
    expect(captureCurrentNoteVersion).not.toHaveBeenCalled();
  });
});

describe('cancel', () => {
  it('drops a pending capture', async () => {
    const history = make({});
    history.schedule();
    history.cancel();

    await vi.advanceTimersByTimeAsync(HISTORY_IDLE_DEFAULT_S * 1000);
    expect(captureCurrentNoteVersion).not.toHaveBeenCalled();
    // The note is still dirty, so a teardown flush can pick it up.
    expect(history.dirty).toBe(true);
  });
});
