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
vi.mock('$lib/components/NoteEditor.svelte', async () => ({
  default: (await import('./note-editor/__tests__/EditorProbe.svelte')).default
}));
vi.mock('$lib/components/FreeformNoteEditor.svelte', async () => ({
  default: (await import('./note-editor/__tests__/EditorProbe.svelte')).default
}));
vi.mock('$lib/components/PdfDocumentEditor.svelte', async () => ({
  default: (await import('./note-editor/__tests__/EditorProbe.svelte')).default
}));
vi.mock('$lib/components/KanbanNoteEditor.svelte', async () => ({
  default: (await import('./note-editor/__tests__/EditorProbe.svelte')).default
}));
vi.mock('$lib/components/PluginDocumentNoteEditor.svelte', async () => ({
  default: (await import('./note-editor/__tests__/EditorProbe.svelte')).default
}));

import NoteKindRenderer from './NoteKindRenderer.svelte';

afterEach(() => {
  cleanup();
  resetPluginRegistry();
});

describe('NoteKindRenderer', () => {
  it.each([
    'markdown',
    'freeform',
    'ink',
    'pdf',
    'kanban',
    'plugin.com.example.stability.document'
  ])(
    'keeps the %s editor mounted across native plugin registry refreshes',
    async (noteKind) => {
      registerPlugin(templatesManifest);
      if (noteKind.startsWith('plugin.'))
        registerPlugin({
          manifestVersion: 2,
          id: 'com.example.stability',
          name: 'Stability fixture',
          version: '1.0.0',
          runtime: 'wasm',
          entry: 'plugin.wasm',
          permissions: [],
          contributes: {
            noteKinds: [
              {
                id: 'document',
                labelKey: 'document',
                render: { export: 'renderDocument' }
              }
            ]
          }
        });
      render(NoteKindRenderer, { noteId: 'note-one', noteKind });
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
    }
  );
});
