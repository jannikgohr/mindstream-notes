import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginDownload,
  endProgress,
  finishDownload,
  recordChunk,
  updaterProgress
} from './progress.svelte';

// recordChunk throttles on performance.now(); control time so the flush
// behaviour is deterministic.
let now = 0;

beforeEach(() => {
  now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  endProgress();
});

afterEach(() => {
  vi.restoreAllMocks();
  endProgress();
});

describe('beginDownload', () => {
  it('activates the dialog in the downloading phase with the given total', () => {
    beginDownload(2048);
    expect(updaterProgress.active).toBe(true);
    expect(updaterProgress.phase).toBe('downloading');
    expect(updaterProgress.total).toBe(2048);
    expect(updaterProgress.downloaded).toBe(0);
  });
});

describe('recordChunk', () => {
  it('accumulates and flushes once the throttle window elapses', () => {
    beginDownload(1000);
    now = 1000; // lastTick reset to 0 in beginDownload, so first chunk flushes
    recordChunk(100);
    expect(updaterProgress.downloaded).toBe(100);

    // Within the throttle window — accumulates but does not flush.
    now = 1030;
    recordChunk(50);
    expect(updaterProgress.downloaded).toBe(100);

    // Past the window — flushes the accumulated total.
    now = 1100;
    recordChunk(50);
    expect(updaterProgress.downloaded).toBe(200);
  });
});

describe('finishDownload', () => {
  it('flushes the pending bytes and switches to installing', () => {
    beginDownload(500);
    now = 1000;
    recordChunk(300);
    now = 1010; // throttled, not yet flushed
    recordChunk(200);
    finishDownload();
    expect(updaterProgress.downloaded).toBe(500);
    expect(updaterProgress.phase).toBe('installing');
  });
});

describe('endProgress', () => {
  it('resets every field', () => {
    beginDownload(100);
    recordChunk(50);
    endProgress();
    expect(updaterProgress).toEqual({
      active: false,
      phase: null,
      downloaded: 0,
      total: 0
    });
  });
});
