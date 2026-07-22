import { describe, expect, it } from 'vitest';
import { setSyncSchedule } from './sync';

describe('setSyncSchedule', () => {
  it('is a no-op outside Tauri for a valid schedule', async () => {
    await expect(
      setSyncSchedule({ enabled: true, intervalSecs: 30 })
    ).resolves.toBeUndefined();
  });

  it('rejects enabled zero-second schedules before IPC', async () => {
    await expect(
      setSyncSchedule({ enabled: true, intervalSecs: 0 })
    ).rejects.toThrow('enabled sync schedule requires a positive interval');
  });

  it('accepts zero seconds when disabling the scheduler', async () => {
    await expect(
      setSyncSchedule({ enabled: false, intervalSecs: 0 })
    ).resolves.toBeUndefined();
  });

  it('rejects non-integer intervals', async () => {
    await expect(
      setSyncSchedule({ enabled: true, intervalSecs: 1.5 })
    ).rejects.toThrow(
      'sync schedule intervalSecs must be a non-negative integer'
    );
  });
});
