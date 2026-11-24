import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  pending: vi.fn(),
  commit: vi.fn(),
  run: vi.fn()
}));

vi.mock('$lib/api/plugin-events', () => ({
  pluginEventsPending: api.pending,
  pluginEventsCommit: api.commit
}));
vi.mock('./run-script', () => ({
  browserPluginSettings: () => ({ endpoint: 'http://localhost' }),
  runPluginScript: api.run
}));

import { deliverNoteEvents } from './note-events';
import { registerPlugin, resetPluginRegistry } from './registry.svelte';

function watcher(id: string): Record<string, unknown> {
  return {
    manifestVersion: 2,
    id,
    name: 'Watcher',
    version: '1.0.0',
    runtime: 'wasm',
    entry: 'plugin.wasm',
    permissions: ['notes.watch'],
    contributes: {
      noteEvents: [
        {
          on: 'note.changed',
          export: 'noteChanged',
          noteKinds: ['ink'],
          settleMs: 5000
        }
      ]
    }
  };
}

afterEach(() => {
  resetPluginRegistry();
  vi.clearAllMocks();
});

describe('deliverNoteEvents', () => {
  it('delivers in order and moves past a change whose handler failed', async () => {
    registerPlugin(watcher('com.example.watcher'));
    registerPlugin(watcher('com.example.off'), { enabled: false });
    registerPlugin(watcher('com.example.ungranted'), { granted: [] });
    const changes = [
      { noteId: 'a', kind: 'ink', revision: 3 },
      { noteId: 'b', kind: 'ink', revision: 5 }
    ];
    api.pending.mockResolvedValue({ generation: 'g', changes });
    api.run.mockRejectedValueOnce(new Error('plugin failed'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await deliverNoteEvents();

    expect(api.pending.mock.calls).toEqual([
      [
        'com.example.watcher',
        'noteChanged',
        { endpoint: 'http://localhost' },
        ['ink'],
        5000,
        50
      ]
    ]);
    expect(api.run.mock.calls).toEqual([
      ['com.example.watcher', 'noteChanged', changes[0]],
      ['com.example.watcher', 'noteChanged', changes[1]]
    ]);
    expect(api.commit.mock.calls).toEqual([
      ['com.example.watcher', 'noteChanged', 'g', 3],
      ['com.example.watcher', 'noteChanged', 'g', 5]
    ]);
  });
});
