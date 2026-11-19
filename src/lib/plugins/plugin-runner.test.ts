import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PluginRequest, PluginResponse } from './browser-runtime';
import { resetPluginRunner, runBundledPlugin } from './plugin-runner';

/** A plugin Worker that loads its component and then never answers. */
class HangingWorker {
  static instances: HangingWorker[] = [];
  onmessage: ((event: { data: PluginResponse }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  terminated = false;

  constructor() {
    HangingWorker.instances.push(this);
  }

  postMessage({ id }: PluginRequest) {
    queueMicrotask(() => this.onmessage?.({ data: { id, started: true } }));
  }

  terminate() {
    this.terminated = true;
  }
}

const TYPST = 'com.mindstream.typst';
const call = (pluginId: string) => ({
  pluginId,
  granted: [],
  notes: [],
  nativeTools: []
});

beforeEach(() => {
  HangingWorker.instances = [];
  vi.stubGlobal('Worker', HangingWorker);
  vi.useFakeTimers();
});
afterEach(() => {
  resetPluginRunner();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('terminates a call that overruns the clamped manifest timeout', async () => {
  // Typst asks for 20 s; the app's policy allows at most 5 s.
  const first = runBundledPlugin('renderDocument', {}, call(TYPST));
  const queued = runBundledPlugin('renderDocument', {}, call(TYPST));
  const firstFailure = expect(first).rejects.toThrow(
    'script exceeded its time budget'
  );
  const queuedFailure = expect(queued).rejects.toThrow(
    'plugin call was cancelled'
  );
  await vi.advanceTimersByTimeAsync(4999);
  expect(HangingWorker.instances[0].terminated).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await firstFailure;
  await queuedFailure;
  expect(HangingWorker.instances[0].terminated).toBe(true);

  void runBundledPlugin('renderDocument', {}, call(TYPST)).catch(() => {});
  expect(HangingWorker.instances).toHaveLength(2);
});

it('fails the pending calls when the Worker itself fails', async () => {
  const pending = runBundledPlugin('renderDocument', {}, call(TYPST));
  HangingWorker.instances[0].onerror?.({ message: 'blocked' });
  await expect(pending).rejects.toThrow('plugin worker failed: blocked');
});
