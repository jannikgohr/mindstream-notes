import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createNoteIn, requestOpenNote } = vi.hoisted(() => ({
  createNoteIn: vi.fn(),
  requestOpenNote: vi.fn()
}));
vi.mock('$lib/stores/tree.svelte', () => ({ createNoteIn }));
vi.mock('$lib/stores/open-note-intent.svelte', () => ({ requestOpenNote }));

import { registerPlugin, resetPluginRegistry } from './registry.svelte';
import {
  hasPluginTemplates,
  pluginTemplateEntries,
  renderTemplateEntryBody,
  runPluginTemplate
} from './menu';

const PLUGIN_ID = 'com.example.templates';

function register(): void {
  registerPlugin({
    id: PLUGIN_ID,
    name: 'Example',
    version: '1.0.0',
    runtime: 'manifest-only',
    permissions: ['templates.contribute', 'notes.create'],
    contributes: {
      i18n: {
        en: {
          'templates.meeting.name': 'Meeting notes',
          'templates.meeting.description': 'Agenda and follow-ups'
        }
      },
      noteTemplates: [
        {
          id: 'meeting',
          labelKey: 'templates.meeting.name',
          descriptionKey: 'templates.meeting.description',
          noteKind: 'markdown',
          titleTemplate: 'Meeting — {{date}}',
          bodyTemplate: '# {{title}}'
        }
      ]
    }
  });
}

beforeEach(() => {
  createNoteIn.mockReset().mockResolvedValue('note-1');
  requestOpenNote.mockReset();
});
afterEach(() => resetPluginRegistry());

describe('pluginTemplateEntries', () => {
  it('is empty with no plugins', () => {
    expect(pluginTemplateEntries()).toHaveLength(0);
    expect(hasPluginTemplates()).toBe(false);
  });

  it('lists localized label + description for each enabled template', () => {
    register();
    const entries = pluginTemplateEntries();
    expect(entries).toEqual([
      {
        pluginId: PLUGIN_ID,
        templateId: 'meeting',
        label: 'Meeting notes',
        description: 'Agenda and follow-ups'
      }
    ]);
    expect(hasPluginTemplates()).toBe(true);
  });
});

describe('runPluginTemplate', () => {
  it('creates a note at the given parent', async () => {
    register();
    await runPluginTemplate(PLUGIN_ID, 'meeting', 'folder-9');
    expect(createNoteIn).toHaveBeenCalledWith(
      'folder-9',
      expect.stringMatching(/^Meeting — /),
      'markdown',
      expect.any(String)
    );
  });

  it('swallows errors from an unknown template', async () => {
    register();
    await expect(
      runPluginTemplate(PLUGIN_ID, 'ghost', null)
    ).resolves.toBeUndefined();
    expect(createNoteIn).not.toHaveBeenCalled();
  });
});

describe('renderTemplateEntryBody', () => {
  it('renders a plugin template body with placeholders interpolated', async () => {
    register();
    const body = await renderTemplateEntryBody({
      kind: 'plugin',
      pluginId: PLUGIN_ID,
      templateId: 'meeting',
      label: 'Meeting notes'
    });
    // bodyTemplate '# {{title}}' → title 'Meeting — <date>'. No note is created.
    expect(body).toMatch(/^# Meeting — /);
    expect(createNoteIn).not.toHaveBeenCalled();
  });

  it('throws for an unknown plugin template', async () => {
    register();
    await expect(
      renderTemplateEntryBody({
        kind: 'plugin',
        pluginId: PLUGIN_ID,
        templateId: 'ghost',
        label: 'x'
      })
    ).rejects.toThrow();
  });
});
