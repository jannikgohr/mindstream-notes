import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { listen, handlers, isTauri, loadTree, applyNoteChange } = vi.hoisted(
  () => ({
    handlers: {} as Record<string, (p: unknown) => void>,
    listen: vi.fn(
      (event: string, handler: (p: unknown) => void) =>
        new Promise<() => void>((resolve) => {
          (handlers as Record<string, (p: unknown) => void>)[event] = handler;
          resolve(() => delete handlers[event]);
        })
    ),
    isTauri: vi.fn(() => false),
    loadTree: vi.fn().mockResolvedValue(undefined),
    applyNoteChange: vi.fn()
  })
);

vi.mock('$lib/api/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/api/core')>();
  return { ...actual, isTauri };
});
vi.mock('$lib/api/events', () => ({
  listen,
  TauriEventName: {
    NoteSummaryChanged: 'note-summary-changed',
    SyncCompleted: 'sync-completed'
  }
}));
vi.mock('$lib/stores/tree.svelte', () => ({ applyNoteChange, loadTree }));

import { installSyncTreeRefreshBridge } from './tree-refresh-bridge';

let visibility: DocumentVisibilityState = 'visible';
function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

let teardowns: (() => void)[] = [];
function install() {
  const teardown = installSyncTreeRefreshBridge();
  teardowns.push(teardown);
  return teardown;
}

afterEach(() => {
  for (const teardown of teardowns) teardown();
  teardowns = [];
  delete (document as { visibilityState?: unknown }).visibilityState;
});

beforeEach(() => {
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility
  });
  for (const key of Object.keys(handlers)) delete handlers[key];
  listen.mockClear();
  loadTree.mockClear();
  applyNoteChange.mockClear();
  isTauri.mockReturnValue(true);
});

describe('installSyncTreeRefreshBridge', () => {
  it('reloads the tree when a scheduled sync completes', () => {
    install();
    expect(loadTree).not.toHaveBeenCalled();

    handlers['sync-completed']?.({
      report: {},
      notes_pulled_ids: ['note_1'],
      assets_pulled_ids: [],
      tree_changed: true
    });

    expect(loadTree).toHaveBeenCalledTimes(1);
  });

  it('leaves the tree alone when the sync changed nothing it shows', () => {
    install();
    handlers['sync-completed']?.({
      report: {},
      notes_pulled_ids: ['note_1'],
      assets_pulled_ids: [],
      tree_changed: false
    });
    expect(loadTree).not.toHaveBeenCalled();
  });

  it('waits until the window is seen again, then reloads once', () => {
    install();
    setVisibility('hidden');
    const sync = {
      report: {},
      notes_pulled_ids: [],
      assets_pulled_ids: [],
      tree_changed: true
    };
    handlers['sync-completed']?.(sync);
    handlers['sync-completed']?.(sync);
    expect(loadTree).not.toHaveBeenCalled();

    setVisibility('visible');
    expect(loadTree).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    setVisibility('visible');
    expect(loadTree).toHaveBeenCalledTimes(1);
  });

  it('is a no-op outside Tauri', () => {
    isTauri.mockReturnValue(false);
    const teardown = install();
    expect(listen).not.toHaveBeenCalled();
    teardown();
  });

  it('applies a rename or save another window announced', () => {
    install();
    const change = { id: 'note_1', title: 'New', modified: '2026-11-05' };
    handlers['note-summary-changed']?.(change);
    expect(applyNoteChange).toHaveBeenCalledWith(change);
    expect(loadTree).not.toHaveBeenCalled();
  });

  it('stops refreshing after teardown', async () => {
    const teardown = install();
    teardown();
    await Promise.resolve();
    expect(handlers['sync-completed']).toBeUndefined();
    expect(handlers['note-summary-changed']).toBeUndefined();
  });
});
