import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const app = vi.hoisted(() => ({
  tauri: true,
  running: false,
  handler: null as null | ((progress: unknown) => void)
}));
vi.mock('$lib/api/core', () => ({
  isTauri: () => app.tauri,
  invokeTauri: vi.fn(async () => app.running),
  TauriCommandName: { NotesImportRunning: 'notes_import_running' }
}));
vi.mock('$lib/api/events', () => ({
  TauriEventName: { ImportProgress: 'import-progress' },
  listen: vi.fn(
    async (_event: string, handler: (progress: unknown) => void) => {
      app.handler = handler;
      return () => {
        app.handler = null;
      };
    }
  )
}));
const loadTree = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('$lib/stores/tree.svelte', () => ({
  loadTree,
  tree: { ready: true }
}));

import { installImportActivityBridge } from './import-activity-bridge';
import {
  importActivity,
  resetImportActivityForTests,
  whenNoImportRuns
} from './import-activity.svelte';

let uninstall: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  resetImportActivityForTests();
  loadTree.mockClear();
  app.tauri = true;
  app.running = false;
  app.handler = null;
});
afterEach(() => {
  uninstall();
  vi.useRealTimers();
});

const send = (phase: string, done = 0, total = 0) =>
  app.handler?.({ phase, done, total });

describe('import activity bridge', () => {
  it('follows the progress events and reloads the tree at the end', async () => {
    uninstall = installImportActivityBridge();
    await vi.waitFor(() => expect(app.handler).not.toBeNull());

    send('importing', 500, 1200);
    expect(importActivity.running).toBe(true);
    expect(importActivity.done).toBe(500);
    const released = whenNoImportRuns();

    send('finished');
    await released;
    expect(importActivity.running).toBe(false);
    expect(loadTree).toHaveBeenCalledOnce();
  });

  it('learns of an import that began before the window opened', async () => {
    app.running = true;
    uninstall = installImportActivityBridge();
    await vi.waitFor(() => expect(importActivity.running).toBe(true));
  });

  it('ends the wait when the app says the import is over, even without its event', async () => {
    uninstall = installImportActivityBridge();
    await vi.waitFor(() => expect(app.handler).not.toBeNull());
    app.running = true;
    send('importing', 1, 2);

    // The finished event never arrives.
    app.running = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(importActivity.running).toBe(false);
    expect(loadTree).toHaveBeenCalledOnce();
  });

  it('asks the app nothing in a browser', async () => {
    app.tauri = false;
    app.running = true;
    uninstall = installImportActivityBridge();
    await vi.waitFor(() => expect(app.handler).not.toBeNull());
    await vi.advanceTimersByTimeAsync(6000);
    expect(importActivity.running).toBe(false);
  });
});
