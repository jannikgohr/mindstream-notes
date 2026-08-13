import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createNoteIn,
  requestOpenNote,
  userTemplateEntries,
  createNoteFromUserTemplate,
  renderUserTemplateBody
} = vi.hoisted(() => ({
  createNoteIn: vi.fn(),
  requestOpenNote: vi.fn(),
  userTemplateEntries: vi.fn(),
  createNoteFromUserTemplate: vi.fn(),
  renderUserTemplateBody: vi.fn()
}));
vi.mock('$lib/stores/tree.svelte', () => ({ createNoteIn }));
vi.mock('$lib/stores/open-note-intent.svelte', () => ({ requestOpenNote }));
vi.mock('$lib/templates/user-templates', () => ({
  userTemplateEntries,
  createNoteFromUserTemplate,
  renderUserTemplateBody
}));

import { registerPlugin, resetPluginRegistry } from './registry.svelte';
import {
  hasPluginTemplates,
  hasTemplateEntries,
  pluginTemplateDefaultTitle,
  pluginTemplateEntries,
  pluginTemplateNoteKind,
  renderTemplateEntryBody,
  runPluginTemplate,
  runTemplateEntry,
  templateMenuEntries
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
  userTemplateEntries.mockReset().mockReturnValue([]);
  createNoteFromUserTemplate.mockReset().mockResolvedValue('note-u');
  renderUserTemplateBody.mockReset().mockResolvedValue('user body');
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

  it('renders a user template body via the user-templates module', async () => {
    const body = await renderTemplateEntryBody({
      kind: 'user',
      noteId: 'note-42',
      label: 'My template'
    });
    expect(renderUserTemplateBody).toHaveBeenCalledWith('note-42');
    expect(body).toBe('user body');
  });
});

describe('pluginTemplateNoteKind', () => {
  it('returns the template note kind or null when unresolved', () => {
    register();
    expect(pluginTemplateNoteKind(PLUGIN_ID, 'meeting')).toBe('markdown');
    expect(pluginTemplateNoteKind(PLUGIN_ID, 'ghost')).toBeNull();
    expect(pluginTemplateNoteKind('nope', 'meeting')).toBeNull();
  });
});

describe('pluginTemplateDefaultTitle', () => {
  it('renders a declarative titleTemplate synchronously', () => {
    register();
    expect(pluginTemplateDefaultTitle(PLUGIN_ID, 'meeting')).toMatch(
      /^Meeting — /
    );
  });

  it('returns empty string for an unknown template', () => {
    register();
    expect(pluginTemplateDefaultTitle(PLUGIN_ID, 'ghost')).toBe('');
  });
});

describe('templateMenuEntries / hasTemplateEntries', () => {
  it('is empty when neither plugin nor user templates exist', () => {
    expect(templateMenuEntries()).toEqual([]);
    expect(hasTemplateEntries()).toBe(false);
  });

  it('lists plugin templates first, then user templates', () => {
    register();
    userTemplateEntries.mockReturnValue([
      { noteId: 'note-7', label: 'My note template' }
    ]);
    const entries = templateMenuEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'plugin', templateId: 'meeting' });
    expect(entries[1]).toEqual({
      kind: 'user',
      noteId: 'note-7',
      label: 'My note template'
    });
    expect(hasTemplateEntries()).toBe(true);
  });
});

describe('runTemplateEntry', () => {
  it('creates a note from a plugin entry', async () => {
    register();
    await runTemplateEntry(
      {
        kind: 'plugin',
        pluginId: PLUGIN_ID,
        templateId: 'meeting',
        label: 'x'
      },
      'folder-3'
    );
    expect(createNoteIn).toHaveBeenCalled();
    expect(createNoteFromUserTemplate).not.toHaveBeenCalled();
  });

  it('delegates a user entry to the user-templates module', async () => {
    await runTemplateEntry(
      { kind: 'user', noteId: 'note-9', label: 'x' },
      'folder-3'
    );
    expect(createNoteFromUserTemplate).toHaveBeenCalledWith(
      'note-9',
      'folder-3'
    );
  });

  it('swallows errors from a failing entry', async () => {
    createNoteFromUserTemplate.mockRejectedValue(new Error('boom'));
    await expect(
      runTemplateEntry({ kind: 'user', noteId: 'x', label: 'x' }, null)
    ).resolves.toBeUndefined();
  });
});
