import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Isolate the module from the real note-creation + open-note plumbing.
const { createNoteIn, requestOpenNote } = vi.hoisted(() => ({
  createNoteIn: vi.fn(),
  requestOpenNote: vi.fn()
}));
vi.mock('$lib/stores/tree.svelte', () => ({ createNoteIn }));
vi.mock('$lib/stores/open-note-intent.svelte', () => ({ requestOpenNote }));

import { registerPlugin, resetPluginRegistry } from './registry.svelte';
import {
  buildTemplateContext,
  createNoteFromPluginTemplate,
  renderPluginTemplate,
  renderTemplateString,
  todayIsoDate
} from './templates';
import type { PluginNoteTemplateContribution } from './types';

const PLUGIN_ID = 'com.example.templates';

function meetingTemplate(): PluginNoteTemplateContribution {
  return {
    id: 'meeting',
    labelKey: 'templates.meeting.name',
    noteKind: 'markdown',
    titleTemplate: 'Meeting — {{date}}',
    bodyTemplate: '# {{title}}\n\nOwner: {{owner}}',
    variables: [
      { id: 'owner', labelKey: 'templates.meeting.owner', type: 'text' }
    ]
  };
}

function registerMeeting(
  permissions = ['templates.contribute', 'notes.create']
): void {
  registerPlugin({
    id: PLUGIN_ID,
    name: 'Example',
    version: '1.0.0',
    runtime: 'manifest-only',
    permissions,
    contributes: {
      i18n: { en: { 'templates.meeting.name': 'Meeting notes' } },
      noteTemplates: [meetingTemplate()]
    }
  });
}

beforeEach(() => {
  createNoteIn.mockReset().mockResolvedValue('note-1');
  requestOpenNote.mockReset();
});
afterEach(() => resetPluginRegistry());

describe('renderTemplateString', () => {
  it('replaces placeholders, tolerating inner whitespace', () => {
    expect(renderTemplateString('a {{x}} {{ y }}', { x: '1', y: '2' })).toBe(
      'a 1 2'
    );
  });

  it('renders unknown placeholders as empty', () => {
    expect(renderTemplateString('[{{missing}}]', {})).toBe('[]');
  });
});

describe('buildTemplateContext', () => {
  it('injects date, applies defaults, and lets provided values win', () => {
    const t = meetingTemplate();
    t.variables = [
      { id: 'owner', labelKey: 'k', type: 'text', default: 'Nobody' }
    ];
    const ctx = buildTemplateContext(
      t,
      { owner: 'Ada' },
      new Date('2026-07-25T10:00:00Z')
    );
    expect(ctx.date).toBe('2026-07-25');
    expect(ctx.owner).toBe('Ada');
  });

  it('uses the default when no value is provided', () => {
    const t = meetingTemplate();
    t.variables = [
      { id: 'owner', labelKey: 'k', type: 'text', default: 'Nobody' }
    ];
    expect(buildTemplateContext(t).owner).toBe('Nobody');
  });
});

describe('renderPluginTemplate', () => {
  it('renders title and resolves {{title}} inside the body', () => {
    registerMeeting();
    const out = renderPluginTemplate(
      PLUGIN_ID,
      meetingTemplate(),
      { owner: 'Ada' },
      new Date('2026-07-25T10:00:00Z')
    );
    expect(out.title).toBe('Meeting — 2026-07-25');
    expect(out.body).toBe('# Meeting — 2026-07-25\n\nOwner: Ada');
  });

  it('falls back to the localized label when the title renders empty', () => {
    registerMeeting();
    const t = meetingTemplate();
    t.titleTemplate = '{{missing}}';
    expect(renderPluginTemplate(PLUGIN_ID, t).title).toBe('Meeting notes');
  });

  it('throws when a required variable is missing', () => {
    const t = meetingTemplate();
    t.variables = [
      { id: 'owner', labelKey: 'k', type: 'text', required: true }
    ];
    expect(() => renderPluginTemplate(PLUGIN_ID, t)).toThrow(
      /requires a value for variable "owner"/
    );
  });
});

describe('createNoteFromPluginTemplate', () => {
  it('creates a markdown note through the app path and opens it', async () => {
    registerMeeting();
    const id = await createNoteFromPluginTemplate(
      PLUGIN_ID,
      'meeting',
      'col-1',
      {
        owner: 'Ada'
      }
    );
    expect(id).toBe('note-1');
    expect(createNoteIn).toHaveBeenCalledWith(
      'col-1',
      expect.stringMatching(/^Meeting — \d{4}-\d{2}-\d{2}$/),
      'markdown',
      expect.stringContaining('Owner: Ada')
    );
    expect(requestOpenNote).toHaveBeenCalledWith('note-1');
  });

  it('throws for an unknown / disabled template without creating anything', async () => {
    await expect(
      createNoteFromPluginTemplate(PLUGIN_ID, 'ghost', null)
    ).rejects.toThrow(/No enabled template/);
    expect(createNoteIn).not.toHaveBeenCalled();
  });

  it('refuses when the plugin lacks notes.create', async () => {
    registerMeeting(['templates.contribute']);
    await expect(
      createNoteFromPluginTemplate(PLUGIN_ID, 'meeting', null)
    ).rejects.toThrow(/missing notes.create/);
    expect(createNoteIn).not.toHaveBeenCalled();
  });
});

describe('todayIsoDate', () => {
  it('formats as YYYY-MM-DD', () => {
    expect(todayIsoDate(new Date('2026-01-05T23:00:00Z'))).toBe('2026-01-05');
  });
});
