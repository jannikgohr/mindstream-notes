import { beforeEach, describe, expect, it } from 'vitest';
import {
  importChoiceQueue,
  pickImportChoice
} from './import-choice-dialog.svelte';
import type { ImportPreview } from '$lib/api';

const preview = (): ImportPreview =>
  ({
    token: 'tok',
    backup_counts: { notes: 1, folders: 1, assets_bytes: 0 },
    current_counts: { notes: 0, folders: 0, assets_bytes: 0 },
    backup_app_version: '0.1.0',
    backup_created_at: '2024-01-01',
    same_account: true,
    backup_account: null,
    current_account: null
  }) as ImportPreview;

beforeEach(() => {
  importChoiceQueue.items = [];
});

describe('pickImportChoice', () => {
  it('enqueues the preview and resolves with the chosen action', async () => {
    const p = pickImportChoice(preview());
    expect(importChoiceQueue.items).toHaveLength(1);
    importChoiceQueue.items[0].resolve('merge');
    await expect(p).resolves.toBe('merge');
  });

  it('resolves cancel when dismissed', async () => {
    const p = pickImportChoice(preview());
    importChoiceQueue.items[0].resolve('cancel');
    await expect(p).resolves.toBe('cancel');
  });

  it('queues multiple requests in order', () => {
    void pickImportChoice(preview());
    void pickImportChoice(preview());
    expect(importChoiceQueue.items).toHaveLength(2);
  });
});
