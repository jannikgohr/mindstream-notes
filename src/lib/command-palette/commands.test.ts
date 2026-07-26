import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The aggregator reads from the hotkeys barrel, the plugin layers, and i18n.
// Mock all of them so the test exercises the palette's *assembly* logic
// (which commands are included, how templates fan out) without dragging in the
// real hotkey manager / plugin registry / DOM.
const h = vi.hoisted(() => ({
  commands: [] as { id: string; scope: string; labelKey: string }[],
  templates: [] as {
    kind: 'plugin' | 'user';
    label: string;
    description?: string;
    pluginId?: string;
    templateId?: string;
    noteId?: string;
  }[],
  active: null as { kind: string; noteId?: string } | null,
  emitCommand: vi.fn(),
  insertMarkdown: vi.fn(),
  runTemplateEntry: vi.fn(),
  renderTemplateEntryBody: vi.fn()
}));

vi.mock('$lib/hotkeys', () => ({
  allHotkeyCommands: () => h.commands,
  isGlobalShortcutOnlyCommand: (c: string | { id: string }) =>
    (typeof c === 'string' ? c : c.id) === 'global.showApp',
  getBinding: (id: string) => (id === 'global.openSettings' ? 'mod+,' : null),
  displayBinding: (b: string | null) => (b ? b.toUpperCase() : null),
  emitCommand: h.emitCommand,
  activeEditor: () => h.active,
  insertMarkdownIntoActiveNote: h.insertMarkdown
}));

vi.mock('$lib/plugins/hotkeys', () => ({
  pluginCommandLabel: (id: string) =>
    id.startsWith('plugin.') ? `Plugin: ${id}` : undefined
}));

vi.mock('$lib/plugins/menu', () => ({
  templateMenuEntries: () => h.templates,
  runTemplateEntry: h.runTemplateEntry,
  renderTemplateEntryBody: h.renderTemplateEntryBody
}));

vi.mock('$lib/settings/i18n.svelte', () => ({
  tUi: (key: string) => {
    if (key === 'commandPalette.template.newNote')
      return 'New note from {name}';
    if (key === 'commandPalette.template.insert')
      return 'Insert {name} into note';
    return key; // app-command labels resolve to their labelKey here
  }
}));

import { paletteCommands } from './commands';

beforeEach(() => {
  h.commands = [];
  h.templates = [];
  h.active = null;
  h.emitCommand.mockReset();
  h.insertMarkdown.mockReset();
  h.runTemplateEntry.mockReset();
  h.renderTemplateEntryBody.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe('application commands', () => {
  beforeEach(() => {
    h.commands = [
      {
        id: 'global.openSettings',
        scope: 'global',
        labelKey: 'hotkeys.command.global.openSettings'
      },
      { id: 'global.showApp', scope: 'global', labelKey: 'x' },
      { id: 'global.openCommandPalette', scope: 'global', labelKey: 'x' },
      {
        id: 'editor.markdown.bold',
        scope: 'editor',
        labelKey: 'x'
      },
      {
        id: 'plugin.demo.hello',
        scope: 'global',
        labelKey: 'plugins.demo.hello'
      }
    ];
  });

  it('includes global built-in and plugin commands', () => {
    const ids = paletteCommands().map((c) => c.id);
    expect(ids).toContain('global.openSettings');
    expect(ids).toContain('plugin.demo.hello');
  });

  it('excludes the global-shortcut-only command and the palette opener', () => {
    const ids = paletteCommands().map((c) => c.id);
    expect(ids).not.toContain('global.showApp');
    expect(ids).not.toContain('global.openCommandPalette');
  });

  it('excludes editor-scope commands', () => {
    const ids = paletteCommands().map((c) => c.id);
    expect(ids).not.toContain('editor.markdown.bold');
  });

  it('resolves plugin labels through plugin i18n and shows the bound hint', () => {
    const cmds = paletteCommands();
    const plugin = cmds.find((c) => c.id === 'plugin.demo.hello');
    const settings = cmds.find((c) => c.id === 'global.openSettings');
    expect(plugin?.label).toBe('Plugin: plugin.demo.hello');
    expect(settings?.hint).toBe('MOD+,');
    expect(cmds.find((c) => c.id === 'plugin.demo.hello')?.hint).toBeNull();
  });

  it('run() dispatches the command through the bus', () => {
    const settings = paletteCommands().find(
      (c) => c.id === 'global.openSettings'
    );
    settings?.run();
    expect(h.emitCommand).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'global.openSettings' })
    );
  });
});

describe('template commands', () => {
  beforeEach(() => {
    h.templates = [
      { kind: 'user', noteId: 'n1', label: 'Daily' },
      {
        kind: 'plugin',
        pluginId: 'com.x',
        templateId: 'meeting',
        label: 'Meeting'
      }
    ];
  });

  it('offers a "new note" action for every template, insert only when a markdown editor is active', () => {
    h.active = null;
    let ids = paletteCommands().map((c) => c.id);
    expect(ids).toContain('template.new.user:n1');
    expect(ids).toContain('template.new.com.x:meeting');
    expect(ids).not.toContain('template.insert.user:n1');

    h.active = { kind: 'markdown', noteId: 'n1' };
    ids = paletteCommands().map((c) => c.id);
    expect(ids).toContain('template.insert.user:n1');
    expect(ids).toContain('template.insert.com.x:meeting');
  });

  it('does not offer insert when the active editor is not markdown', () => {
    h.active = { kind: 'ink', noteId: 'n1' };
    const ids = paletteCommands().map((c) => c.id);
    expect(ids.some((id) => id.startsWith('template.insert.'))).toBe(false);
  });

  it('interpolates the template name into the localized labels', () => {
    h.active = { kind: 'markdown', noteId: 'n1' };
    const cmds = paletteCommands();
    expect(cmds.find((c) => c.id === 'template.new.user:n1')?.label).toBe(
      'New note from Daily'
    );
    expect(cmds.find((c) => c.id === 'template.insert.user:n1')?.label).toBe(
      'Insert Daily into note'
    );
  });

  it('"new note" run() delegates to runTemplateEntry with no parent', () => {
    const cmd = paletteCommands().find((c) => c.id === 'template.new.user:n1');
    cmd?.run();
    expect(h.runTemplateEntry).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'user', noteId: 'n1' }),
      null
    );
  });

  it('"insert" run() renders the body and inserts it into the note that was active', async () => {
    h.active = { kind: 'markdown', noteId: 'n1' };
    h.renderTemplateEntryBody.mockResolvedValue('BODY');
    const cmd = paletteCommands().find(
      (c) => c.id === 'template.insert.user:n1'
    );
    cmd?.run();
    await vi.waitFor(() =>
      expect(h.insertMarkdown).toHaveBeenCalledWith('BODY', 'n1')
    );
  });
});
