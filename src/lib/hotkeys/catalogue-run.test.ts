/**
 * Global-command wiring.
 *
 * `catalogue.test.ts` is the drift guard (every id has a binding, an
 * action, etc.). This file is the complementary behaviour check: each
 * global command carries a `run()` callback, and this proves each one
 * delegates to the right app-level action. The delegated modules are all
 * mocked so the callbacks can be invoked in isolation, away from a live
 * editor stack or Tauri backend.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the (also-hoisted) vi.mock factories below can close over these
// spies without hitting the temporal-dead-zone of plain top-level `const`s.
const {
  openSettings,
  openSearch,
  openCommandPalette,
  runActiveEditorCommand,
  searchActiveNote,
  openShortcutHelp,
  openRightSidebar,
  toggleLeftSidebar,
  toggleRightSidebar,
  createRootNote,
  focusMainWindow,
  ui
} = vi.hoisted(() => ({
  openSettings: vi.fn(),
  openSearch: vi.fn(),
  openCommandPalette: vi.fn(),
  runActiveEditorCommand: vi.fn(),
  searchActiveNote: vi.fn(() => true),
  openShortcutHelp: vi.fn(),
  openRightSidebar: vi.fn(),
  toggleLeftSidebar: vi.fn(),
  toggleRightSidebar: vi.fn(),
  createRootNote: vi.fn(() => Promise.resolve()),
  focusMainWindow: vi.fn(() => Promise.resolve()),
  ui: { activeNoteId: 'note-1' as string | null }
}));

vi.mock('$lib/settings/store.svelte', () => ({ openSettings }));
vi.mock('$lib/search/store.svelte', () => ({ openSearch }));
vi.mock('$lib/command-palette/store.svelte', () => ({ openCommandPalette }));
vi.mock('./bus.svelte', () => ({
  APP_UNDO_COMMAND: 'app.undo',
  APP_REDO_COMMAND: 'app.redo',
  runActiveEditorCommand,
  searchActiveNote
}));
vi.mock('./help.svelte', () => ({ openShortcutHelp }));
vi.mock('$lib/state.svelte', () => ({
  ui,
  openRightSidebar,
  toggleLeftSidebar,
  toggleRightSidebar
}));
vi.mock('./create-root-note', () => ({ createRootNote }));
vi.mock('$lib/api/window', () => ({ focusMainWindow }));
vi.mock('$lib/plugins/hotkeys', () => ({ pluginHotkeyCommands: () => [] }));

import {
  HOTKEY_COMMANDS,
  NativeGlobalShortcutCommandId,
  nativeGlobalShortcutCommandId,
  type GlobalCommand
} from './catalogue';

/** Invoke the `run()` of a global command by id. */
function run(id: string): boolean | void {
  const cmd = HOTKEY_COMMANDS.find((c) => c.id === id);
  if (!cmd || cmd.scope !== 'global') {
    throw new Error(`no global command "${id}"`);
  }
  return (cmd as GlobalCommand).run();
}

// Let the dynamic-import `.then()` chains in the lazy commands settle.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('global command run() wiring', () => {
  beforeEach(() => {
    ui.activeNoteId = 'note-1';
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it.each([
    ['global.newMarkdownNote', 'markdown'],
    ['global.newDrawing', 'freeform'],
    ['global.newInkNote', 'ink']
  ])('%s creates a root note of the matching kind', async (id, kind) => {
    run(id);
    await flush();
    expect(createRootNote).toHaveBeenCalledWith(kind);
  });

  it('logs and swallows a create-root-note failure', async () => {
    const err = new Error('disk full');
    createRootNote.mockRejectedValueOnce(err);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    run('global.newMarkdownNote');
    await flush();

    expect(spy).toHaveBeenCalledWith(
      '[hotkeys] failed to create note',
      'markdown',
      err
    );
  });

  it('openSettings opens the settings panel', () => {
    run('global.openSettings');
    expect(openSettings).toHaveBeenCalledOnce();
  });

  it('openSearch opens global search', () => {
    run('global.openSearch');
    expect(openSearch).toHaveBeenCalledOnce();
  });

  it('openCommandPalette opens the palette', () => {
    run('global.openCommandPalette');
    expect(openCommandPalette).toHaveBeenCalledOnce();
  });

  it('searchActiveNote routes find to the active note and returns its flag', () => {
    const result = run('global.searchActiveNote');
    expect(searchActiveNote).toHaveBeenCalledWith('note-1');
    expect(result).toBe(true);
  });

  it('undo / redo dispatch the app-level editor commands', () => {
    run('global.undo');
    run('global.redo');
    expect(runActiveEditorCommand).toHaveBeenNthCalledWith(
      1,
      'app.undo',
      'note-1'
    );
    expect(runActiveEditorCommand).toHaveBeenNthCalledWith(
      2,
      'app.redo',
      'note-1'
    );
  });

  it('toggle commands flip the sidebars', () => {
    run('global.toggleNoteOverview');
    run('global.toggleNoteMetadata');
    expect(toggleLeftSidebar).toHaveBeenCalledOnce();
    expect(toggleRightSidebar).toHaveBeenCalledOnce();
  });

  it('addTag opens the right sidebar and dispatches the add-tag event', async () => {
    const listener = vi.fn();
    window.addEventListener('mindstream:hotkeys:add-tag', listener);

    run('global.addTag');
    expect(openRightSidebar).toHaveBeenCalledOnce();
    await flush();
    expect(listener).toHaveBeenCalledOnce();

    window.removeEventListener('mindstream:hotkeys:add-tag', listener);
  });

  it('addTag skips the event when no note is active', async () => {
    ui.activeNoteId = null;
    const listener = vi.fn();
    window.addEventListener('mindstream:hotkeys:add-tag', listener);

    run('global.addTag');
    await flush();

    expect(openRightSidebar).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener('mindstream:hotkeys:add-tag', listener);
  });

  it('showShortcutHelp opens the help overlay', () => {
    run('global.showShortcutHelp');
    expect(openShortcutHelp).toHaveBeenCalledOnce();
  });

  it('showApp focuses the main window', async () => {
    run('global.showApp');
    await flush();
    expect(focusMainWindow).toHaveBeenCalledOnce();
  });
});

describe('nativeGlobalShortcutCommandId', () => {
  it.each([
    ['global.newMarkdownNote', NativeGlobalShortcutCommandId.NewMarkdownNote],
    ['global.newDrawing', NativeGlobalShortcutCommandId.NewDrawing],
    ['global.newInkNote', NativeGlobalShortcutCommandId.NewInkNote],
    ['global.showApp', NativeGlobalShortcutCommandId.ShowApp]
  ])('maps %s to its native id', (id, native) => {
    expect(nativeGlobalShortcutCommandId(id)).toBe(native);
  });

  it('throws for a command that has no native global shortcut', () => {
    expect(() => nativeGlobalShortcutCommandId('global.openSettings')).toThrow(
      /Unknown global shortcut command/
    );
  });
});
