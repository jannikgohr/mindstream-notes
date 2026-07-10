import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSettingValueMock = vi.fn();
const pruneNoteVersionsMock = vi.fn();
const sweepUnreferencedMarkdownAssetsMock = vi.fn();

vi.mock('$lib/settings/store.svelte', () => ({
  getSettingValue: (...a: unknown[]) => getSettingValueMock(...a)
}));
vi.mock('$lib/api', () => ({
  pruneNoteVersions: (...a: unknown[]) => pruneNoteVersionsMock(...a),
  sweepUnreferencedMarkdownAssets: (...a: unknown[]) =>
    sweepUnreferencedMarkdownAssetsMock(...a)
}));

import { historyRetentionDays, pruneHistoryOnStartup } from './retention';

beforeEach(() => {
  getSettingValueMock.mockReset();
  pruneNoteVersionsMock.mockReset().mockResolvedValue(0);
  sweepUnreferencedMarkdownAssetsMock.mockReset().mockResolvedValue(0);
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('historyRetentionDays', () => {
  it('maps a numeric setting to days', () => {
    getSettingValueMock.mockReturnValue('90');
    expect(historyRetentionDays()).toBe(90);
  });

  it('maps "forever" / missing / invalid to null (never deletes)', () => {
    getSettingValueMock.mockReturnValue('forever');
    expect(historyRetentionDays()).toBeNull();
    getSettingValueMock.mockReturnValue(undefined);
    expect(historyRetentionDays()).toBeNull();
    getSettingValueMock.mockReturnValue('garbage');
    expect(historyRetentionDays()).toBeNull();
    getSettingValueMock.mockReturnValue('0');
    expect(historyRetentionDays()).toBeNull();
  });
});

describe('pruneHistoryOnStartup', () => {
  it('sweeps with the configured retention', async () => {
    getSettingValueMock.mockReturnValue('30');
    await pruneHistoryOnStartup();
    expect(pruneNoteVersionsMock).toHaveBeenCalledWith(30);
    expect(sweepUnreferencedMarkdownAssetsMock).toHaveBeenCalledOnce();
  });

  it('passes null for forever and swallows errors', async () => {
    getSettingValueMock.mockReturnValue('forever');
    pruneNoteVersionsMock.mockRejectedValueOnce(new Error('boom'));
    await expect(pruneHistoryOnStartup()).resolves.toBeUndefined();
    expect(pruneNoteVersionsMock).toHaveBeenCalledWith(null);
    expect(console.debug).toHaveBeenCalledWith(
      '[history] retention sweep failed',
      expect.any(Error)
    );
  });
});
