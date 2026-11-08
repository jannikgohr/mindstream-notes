import { beforeEach, describe, expect, it } from 'vitest';
import {
  importActivity,
  importProgressed,
  resetImportActivityForTests,
  whenNoImportRuns
} from './import-activity.svelte';

beforeEach(resetImportActivityForTests);

describe('import activity', () => {
  it('runs from the first progress event until the finished one', async () => {
    let released = false;
    importProgressed({ phase: 'scanning', done: 0, total: 0 });
    expect(importActivity.running).toBe(true);
    void whenNoImportRuns().then(() => (released = true));

    importProgressed({ phase: 'importing', done: 500, total: 1200 });
    await Promise.resolve();
    expect(released).toBe(false);
    expect([importActivity.done, importActivity.total]).toEqual([500, 1200]);

    importProgressed({ phase: 'finished', done: 0, total: 0 });
    await Promise.resolve();
    expect(released).toBe(true);
    expect(importActivity.running).toBe(false);
  });

  it('lets a write through at once when nothing imports', async () => {
    await expect(whenNoImportRuns()).resolves.toBeUndefined();
  });
});
