import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Isolate the module from the real note-creation + open-note plumbing.
const { createNoteIn, requestOpenNote, settingValues } = vi.hoisted(() => ({
  createNoteIn: vi.fn(),
  requestOpenNote: vi.fn(),
  settingValues: new Map<string, unknown>()
}));
vi.mock('$lib/stores/tree.svelte', () => ({ createNoteIn }));
vi.mock('$lib/stores/open-note-intent.svelte', () => ({ requestOpenNote }));
vi.mock('$lib/settings/store.svelte', () => ({
  getSettingValue: (id: string) => settingValues.get(id)
}));

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
  settingValues.clear();
});
afterEach(() => resetPluginRegistry());

// A fixed local-time instant used everywhere date output is asserted, so the
// expectations are stable regardless of the machine's timezone.
const NOON = new Date(2026, 6, 25, 14, 5, 9); // Sat 25 Jul 2026, 14:05:09 local

describe('renderTemplateString', () => {
  it('replaces placeholders, tolerating inner whitespace', () => {
    expect(renderTemplateString('a {{x}} {{ y }}', { x: '1', y: '2' })).toBe(
      'a 1 2'
    );
  });

  it('renders unknown placeholders as empty', () => {
    expect(renderTemplateString('[{{missing}}]', {})).toBe('[]');
  });

  it('resolves built-in date bases with default formats', () => {
    expect(renderTemplateString('{{date}}', {}, NOON)).toBe('2026-07-25');
    expect(renderTemplateString('{{time}}', {}, NOON)).toBe('14:05');
    expect(renderTemplateString('{{datetime}}', {}, NOON)).toBe(
      '2026-07-25 14:05'
    );
  });

  it('applies an explicit format to a date base', () => {
    expect(renderTemplateString('{{date:YYYY/MM/DD}}', {}, NOON)).toBe(
      '2026/07/25'
    );
    expect(renderTemplateString('{{date:dddd}}', {}, NOON, 'en')).toBe(
      'Saturday'
    );
    expect(renderTemplateString('{{date:dddd}}', {}, NOON, 'de')).toBe(
      'Samstag'
    );
  });

  it('applies chained date offsets before formatting', () => {
    expect(renderTemplateString('{{date+1d}}', {}, NOON)).toBe('2026-07-26');
    expect(renderTemplateString('{{date-1M+2d:YYYY-MM-DD}}', {}, NOON)).toBe(
      '2026-06-27'
    );
  });

  it('applies text filters last', () => {
    expect(renderTemplateString('{{date:dddd|upper}}', {}, NOON, 'en')).toBe(
      'SATURDAY'
    );
    expect(
      renderTemplateString('{{name|slug}}', { name: 'Hello World!' })
    ).toBe('hello-world');
  });

  it('lets a context variable named date override the built-in', () => {
    // Provided value wins; its format specifier is ignored, as documented.
    expect(
      renderTemplateString('{{date:YYYY}}', { date: 'custom' }, NOON)
    ).toBe('custom');
  });

  it('renders {{uuid}} as a non-empty unique string', () => {
    const out = renderTemplateString('{{uuid}}-{{uuid}}', {}, NOON);
    const [a, b] = out.split('-');
    expect(a).not.toBe('');
    expect(a).not.toBe(b);
  });
});

describe('buildTemplateContext', () => {
  it('applies defaults and lets provided values win', () => {
    const t = meetingTemplate();
    t.variables = [
      { id: 'owner', labelKey: 'k', type: 'text', default: 'Nobody' }
    ];
    const ctx = buildTemplateContext(t, { owner: 'Ada' });
    expect(ctx.owner).toBe('Ada');
  });

  it('uses the default when no value is provided', () => {
    const t = meetingTemplate();
    t.variables = [
      { id: 'owner', labelKey: 'k', type: 'text', default: 'Nobody' }
    ];
    expect(buildTemplateContext(t).owner).toBe('Nobody');
  });

  it('does not inject date (resolved at render time instead)', () => {
    expect('date' in buildTemplateContext(meetingTemplate())).toBe(false);
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

  it('opens by default when open-on-create is unset', async () => {
    registerMeeting();
    await createNoteFromPluginTemplate(PLUGIN_ID, 'meeting', null);
    expect(requestOpenNote).toHaveBeenCalledWith('note-1');
  });

  it('does not open when the plugin open-on-create toggle is false', async () => {
    registerMeeting();
    settingValues.set(`plugins.${PLUGIN_ID}.open-on-create`, false);
    const id = await createNoteFromPluginTemplate(PLUGIN_ID, 'meeting', null);
    expect(id).toBe('note-1');
    expect(createNoteIn).toHaveBeenCalled();
    expect(requestOpenNote).not.toHaveBeenCalled();
  });

  it('creates a plugin-owned note kind through the app path', async () => {
    const noteKind = `plugin.${PLUGIN_ID}.document`;
    registerPlugin({
      id: PLUGIN_ID,
      name: 'Example',
      version: '1.0.0',
      runtime: 'luau',
      entry: 'main.luau',
      permissions: [
        'templates.contribute',
        'noteKinds.contribute',
        'notes.create'
      ],
      contributes: {
        i18n: { en: { 'templates.document.name': 'Document' } },
        noteKinds: [
          {
            id: 'document',
            labelKey: 'notes.document.label',
            render: { export: 'renderDocument' }
          }
        ],
        noteTemplates: [
          {
            id: 'document',
            labelKey: 'templates.document.name',
            noteKind,
            titleTemplate: 'Doc',
            bodyTemplate: 'Body'
          }
        ]
      }
    });
    await createNoteFromPluginTemplate(PLUGIN_ID, 'document', null);
    expect(createNoteIn).toHaveBeenCalledWith(null, 'Doc', noteKind, 'Body');
  });
});

describe('todayIsoDate', () => {
  it('formats the local date as YYYY-MM-DD', () => {
    // Local-time construction so the assertion holds in any timezone. Unlike
    // the previous UTC-based implementation, {{date}} reflects the user's own
    // calendar day (correct for daily notes near midnight).
    expect(todayIsoDate(new Date(2026, 0, 5, 23, 0, 0))).toBe('2026-01-05');
  });
});
