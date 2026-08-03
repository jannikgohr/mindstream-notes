import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  runScript:
    vi.fn<(id: string, ex: string, input: unknown) => Promise<unknown>>(),
  createNoteIn: vi.fn(async () => 'note-new'),
  requestOpenNote: vi.fn(),
  insertMarkdown: vi.fn(),
  createNoteFromNote: vi.fn(async () => 'note-copy'),
  pushToast: vi.fn(),
  openPluginMenu: vi.fn(),
  // plugin id -> granted permissions
  perms: {} as Record<string, string[]>
}));

vi.mock('$lib/api/plugins', () => ({ pluginsRunScript: h.runScript }));
vi.mock('$lib/stores/tree.svelte', () => ({
  createNoteIn: h.createNoteIn,
  tree: {
    collectionsById: {
      f1: { id: 'f1', name: 'Work', parent_collection_id: null }
    }
  }
}));
vi.mock('$lib/stores/open-note-intent.svelte', () => ({
  requestOpenNote: h.requestOpenNote
}));
vi.mock('$lib/hotkeys', () => ({
  insertMarkdownIntoActiveNote: h.insertMarkdown
}));
vi.mock('$lib/templates/user-templates', () => ({
  createNoteFromNote: h.createNoteFromNote
}));
vi.mock('$lib/components/toast.svelte', () => ({ pushToast: h.pushToast }));
vi.mock('$lib/settings/store.svelte', () => ({
  getSettingValue: (key: string) => `val:${key}`
}));
vi.mock('$lib/settings/i18n.svelte', () => ({
  get i18n() {
    return { language: 'en' };
  }
}));
vi.mock('$lib/state.svelte', () => ({ ui: { activeNoteId: 'active-1' } }));
vi.mock('./plugin-menu.svelte', () => ({ openPluginMenu: h.openPluginMenu }));
vi.mock('./registry.svelte', () => ({
  pluginById: (id: string) => ({
    manifest: {
      permissions: h.perms[id] ?? [],
      contributes: {
        settings: [
          { sectionId: 's', titleKey: 't', settings: [{ id: 'source-folder' }] }
        ]
      }
    }
  })
}));

import {
  menuItemFromPluginEffect,
  parsePluginEffect,
  runPluginButton,
  runPluginEffect
} from './effects';
import { buildPluginContext } from './plugin-ctx';

beforeEach(() => {
  vi.clearAllMocks();
  h.perms = {};
});

describe('parsePluginEffect', () => {
  it('accepts the known variants', () => {
    expect(parsePluginEffect({ effect: 'none' })).toEqual({ effect: 'none' });
    expect(
      parsePluginEffect({ effect: 'createNote', title: 'T', body: 'B' })
    ).toEqual({ effect: 'createNote', title: 'T', body: 'B', parentId: null });
    expect(
      parsePluginEffect({ effect: 'createNoteFromNote', sourceNoteId: 'n1' })
    ).toEqual({
      effect: 'createNoteFromNote',
      sourceNoteId: 'n1',
      parentId: null
    });
  });

  it('rejects malformed effects', () => {
    expect(parsePluginEffect(null)).toBeNull();
    expect(parsePluginEffect({ effect: 'nope' })).toBeNull();
    expect(parsePluginEffect({ effect: 'createNote', title: 'T' })).toBeNull();
    expect(parsePluginEffect({ effect: 'toast' })).toBeNull();
  });

  it('parses an openMenu recursively, dropping bad items', () => {
    const parsed = parsePluginEffect({
      effect: 'openMenu',
      items: [
        {
          label: 'A',
          run: { effect: 'createNoteFromNote', sourceNoteId: 'n1' }
        },
        { label: 'bad', run: { effect: 'garbage' } },
        { notALabel: true }
      ]
    });
    expect(parsed).toEqual({
      effect: 'openMenu',
      items: [
        {
          label: 'A',
          run: {
            effect: 'createNoteFromNote',
            sourceNoteId: 'n1',
            parentId: null
          }
        }
      ]
    });
  });
});

describe('runPluginEffect', () => {
  it('gates note creation on notes.create', async () => {
    await expect(
      runPluginEffect('p1', { effect: 'createNote', title: 'T', body: 'B' })
    ).rejects.toThrow(/notes\.create/);
    expect(h.createNoteIn).not.toHaveBeenCalled();

    h.perms.p1 = ['notes.create'];
    await runPluginEffect('p1', {
      effect: 'createNote',
      title: 'T',
      body: 'B'
    });
    expect(h.createNoteIn).toHaveBeenCalledWith(null, 'T', 'markdown', 'B');
    expect(h.requestOpenNote).toHaveBeenCalledWith('note-new');
  });

  it('runs toast + insertMarkdown without a permission', async () => {
    await runPluginEffect('p1', {
      effect: 'toast',
      message: 'hi',
      kind: 'error'
    });
    expect(h.pushToast).toHaveBeenCalledWith('hi', { variant: 'error' });
    await runPluginEffect('p1', { effect: 'insertMarkdown', markdown: '# x' });
    expect(h.insertMarkdown).toHaveBeenCalledWith('# x');
  });

  it('openMenu opens a menu whose items run their nested effect', async () => {
    h.perms.p1 = ['notes.create'];
    await runPluginEffect(
      'p1',
      {
        effect: 'openMenu',
        items: [
          {
            label: 'Daily',
            run: { effect: 'createNoteFromNote', sourceNoteId: 'n1' }
          }
        ]
      },
      { x: 10, y: 20 }
    );
    expect(h.openPluginMenu).toHaveBeenCalledTimes(1);
    const [x, y, items] = h.openPluginMenu.mock.calls[0];
    expect([x, y]).toEqual([10, 20]);
    await items[0].onSelect();
    expect(h.createNoteFromNote).toHaveBeenCalledWith('n1', null);
  });

  it('converts openMenu effects into submenu items with inherited defaults', async () => {
    h.perms.p1 = ['notes.create'];
    const item = menuItemFromPluginEffect(
      'p1',
      'templates',
      'New from template',
      {
        effect: 'openMenu',
        items: [
          {
            label: 'Daily',
            run: { effect: 'createNoteFromNote', sourceNoteId: 'n1' }
          }
        ]
      },
      undefined,
      { defaultParentId: 'folder-1' }
    );

    expect(item.children?.map((child) => child.label)).toEqual(['Daily']);
    item.children?.[0]?.onSelect?.();
    expect(h.createNoteFromNote).toHaveBeenCalledWith('n1', 'folder-1');
  });
});

describe('buildPluginContext', () => {
  it('carries the plugin settings, folders, active note and locale', () => {
    const ctx = buildPluginContext('p1') as Record<string, any>;
    expect(ctx.settings['source-folder']).toBe('val:plugins.p1.source-folder');
    expect(ctx.folders).toEqual([{ id: 'f1', name: 'Work', parentId: null }]);
    expect(ctx.activeNoteId).toBe('active-1');
    expect(ctx.locale).toBe('en');
  });
});

describe('runPluginButton', () => {
  const button = {
    id: 'b',
    location: 'file-tree' as const,
    labelKey: 'k',
    icon: 'i.svg',
    action: { type: 'script' as const, export: 'run' }
  };

  it('runs the script and performs the returned effect', async () => {
    h.runScript.mockResolvedValue({ effect: 'toast', message: 'done' });
    await runPluginButton('p1', button);
    expect(h.runScript).toHaveBeenCalledWith('p1', 'run', expect.any(Object));
    expect(h.pushToast).toHaveBeenCalledWith('done', { variant: 'info' });
  });

  it('logs and swallows an invalid effect / a thrown script', async () => {
    h.runScript.mockResolvedValue({ effect: 'garbage' });
    await expect(runPluginButton('p1', button)).resolves.toBeUndefined();
    h.runScript.mockRejectedValue(new Error('no runtime'));
    await expect(runPluginButton('p1', button)).resolves.toBeUndefined();
  });
});
