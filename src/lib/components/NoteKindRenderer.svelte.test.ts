import { cleanup, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import templatesManifest from '../../../plugins/templates/manifest.json';
import {
  registerPlugin,
  resetPluginRegistry
} from '$lib/plugins/registry.svelte';

vi.mock('$lib/components/DrawingNoteEditor.svelte', async () => ({
  default: (await import('./note-editor/__tests__/EditorProbe.svelte')).default
}));

import NoteKindRenderer from './NoteKindRenderer.svelte';

afterEach(() => {
  cleanup();
  resetPluginRegistry();
});

describe('NoteKindRenderer', () => {
  it('keeps the active editor mounted across native plugin registry refreshes', async () => {
    registerPlugin(templatesManifest);
    render(NoteKindRenderer, { noteId: 'ink-one', noteKind: 'ink' });
    const input = (await screen.findByLabelText(
      'Editor input'
    )) as HTMLInputElement;
    input.value = 'unsaved input';
    input.focus();

    // Every native ink toolbar setting write rediscovers and replaces plugins.
    for (let i = 0; i < 6; i += 1) {
      registerPlugin(structuredClone(templatesManifest));
      await tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await tick();
      expect(screen.getByLabelText('Editor input')).toBe(input);
      expect(input.value).toBe('unsaved input');
      expect(document.activeElement).toBe(input);
    }
  });
});
