import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createNoteIn, requestOpenNote } = vi.hoisted(() => ({
  createNoteIn: vi.fn(),
  requestOpenNote: vi.fn()
}));
vi.mock('$lib/stores/tree.svelte', () => ({ createNoteIn }));
vi.mock('$lib/stores/open-note-intent.svelte', () => ({ requestOpenNote }));

import { registerPlugin, resetPluginRegistry } from './registry.svelte';
import {
  pluginCommandLabel,
  pluginHotkeyCommandId,
  pluginHotkeyCommands
} from './hotkeys';

const PLUGIN_ID = 'com.example.templates';
const COMMAND_ID = `plugin.${PLUGIN_ID}.new-meeting`;

function register(binding: string | null = null): void {
  registerPlugin({
    id: PLUGIN_ID,
    name: 'Example',
    version: '1.0.0',
    runtime: 'manifest-only',
    permissions: ['notes.create'],
    contributes: {
      i18n: {
        en: {
          'templates.meeting.name': 'Meeting notes',
          'commands.newMeeting.label': 'New meeting notes'
        }
      },
      noteTemplates: [
        {
          id: 'meeting',
          labelKey: 'templates.meeting.name',
          noteKind: 'markdown',
          titleTemplate: 'Meeting — {{date}}',
          bodyTemplate: '# {{title}}'
        }
      ],
      commands: [
        {
          id: 'new-meeting',
          labelKey: 'commands.newMeeting.label',
          defaultBinding: binding,
          action: { type: 'createTemplateNote', templateId: 'meeting' }
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

describe('pluginHotkeyCommandId', () => {
  it('namespaces the command under the plugin', () => {
    expect(pluginHotkeyCommandId(PLUGIN_ID, 'new-meeting')).toBe(COMMAND_ID);
  });
});

describe('pluginHotkeyCommands', () => {
  it('is empty with no plugins', () => {
    expect(pluginHotkeyCommands()).toHaveLength(0);
  });

  it('maps an enabled plugin command to a global command', () => {
    register('mod+alt+m');
    const [cmd] = pluginHotkeyCommands();
    expect(cmd.id).toBe(COMMAND_ID);
    expect(cmd.scope).toBe('global');
    expect(cmd.defaultBinding).toBe('mod+alt+m');
  });

  it('defaults an absent binding to null', () => {
    register(null);
    expect(pluginHotkeyCommands()[0].defaultBinding).toBeNull();
  });

  it('run() creates + opens a note from the command template', () => {
    register();
    pluginHotkeyCommands()[0].run();
    expect(createNoteIn).toHaveBeenCalledWith(
      null,
      expect.stringMatching(/^Meeting — /),
      'markdown',
      expect.any(String)
    );
  });
});

describe('pluginCommandLabel', () => {
  it('resolves a plugin command label via plugin i18n', () => {
    register();
    expect(pluginCommandLabel(COMMAND_ID)).toBe('New meeting notes');
  });

  it('returns undefined for a non-plugin command id', () => {
    register();
    expect(pluginCommandLabel('global.newMarkdownNote')).toBeUndefined();
  });
});
