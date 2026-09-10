import { afterEach, describe, expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { loadTree } from './tree';

afterEach(() => {
  vi.unstubAllGlobals();
  invoke.mockReset();
});
describe('tree snapshot IPC', () => {
  it('loads folder and note summaries with one command', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true
    });
    invoke.mockResolvedValue({ collections: [], notes: [] });
    try {
      const result = await loadTree();
      expect(invoke).toHaveBeenCalledOnce();
      expect(invoke).toHaveBeenCalledWith('load_tree', {});
      expect(result.tree.map((node) => node.id)).toEqual(['trash']);
    } finally {
      Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    }
  });
  it('rejects malformed snapshots instead of assigning an inconsistent tree', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true
    });
    invoke.mockResolvedValue({ collections: [], notes: null });
    try {
      await expect(loadTree()).rejects.toThrow(
        'tree collections and notes must be arrays'
      );
    } finally {
      Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    }
  });
});
