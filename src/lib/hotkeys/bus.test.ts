/**
 * Tests for the command bus — the editor-stack and command-dispatch
 * primitives that sit between the keydown manager and any concrete
 * editor adapter.
 *
 * Each test creates throw-away listeners with synthetic hosts so the
 * stack state is fully controlled, and `afterEach` unregisters
 * anything left behind. The module-level `editorStack` and
 * `registered` set in `bus.svelte.ts` are shared across tests
 * otherwise.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerEditor,
  unregisterEditor,
  activeEditor,
  emitCommand,
  searchActiveNote,
  runActiveEditorCommand,
  SEARCH_ACTIVE_NOTE_COMMAND,
  APP_REDO_COMMAND,
  APP_UNDO_COMMAND,
  type EditorListener
} from './bus.svelte';
import { COMMAND_BY_ID } from './catalogue';
import { settingsDialog, closeSettings } from '$lib/settings/store.svelte';

const owned: EditorListener[] = [];

function makeListener(
  kind: EditorListener['kind'],
  onCommand?: EditorListener['onCommand'],
  noteId?: string
): EditorListener {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return {
    kind,
    host,
    noteId,
    onCommand: onCommand ?? (() => true)
  };
}

/** Register a listener and remember it so afterEach can sweep it. */
function track(listener: EditorListener): EditorListener {
  owned.push(listener);
  registerEditor(listener);
  return listener;
}

afterEach(() => {
  for (const l of owned) {
    unregisterEditor(l);
    l.host.remove();
  }
  owned.length = 0;
  // Tests that emit `global.openSettings` flip this; ensure it
  // doesn't leak across tests.
  if (settingsDialog.open) closeSettings();
});

describe('bus.editorStack', () => {
  it('pushes onto an empty stack', () => {
    const a = track(makeListener('markdown'));
    expect(activeEditor()).toBe(a);
  });

  it('returns null when nothing is registered', () => {
    expect(activeEditor()).toBeNull();
  });

  it('latest registration becomes active', () => {
    const a = track(makeListener('markdown'));
    const b = track(makeListener('freeform'));
    expect(activeEditor()).toBe(b);
    unregisterEditor(b);
    expect(activeEditor()).toBe(a);
  });

  it('re-registering an existing listener re-promotes it to top', () => {
    // Mirrors the focusin scenario: two notes open in dockview, the
    // user clicks back into the older one. Without re-promotion,
    // editor hotkeys would keep firing into the wrong note.
    const a = track(makeListener('markdown'));
    const b = track(makeListener('freeform'));
    expect(activeEditor()).toBe(b);
    registerEditor(a);
    expect(activeEditor()).toBe(a);
  });

  it('unregisterEditor is idempotent', () => {
    const a = track(makeListener('markdown'));
    unregisterEditor(a);
    // Second call must not throw and must leave the stack consistent.
    expect(() => unregisterEditor(a)).not.toThrow();
    expect(activeEditor()).toBeNull();
  });

  it('unregister returned by registerEditor pops the listener', () => {
    const a = makeListener('markdown');
    owned.push(a);
    const teardown = registerEditor(a);
    expect(activeEditor()).toBe(a);
    teardown();
    expect(activeEditor()).toBeNull();
  });
});

describe('bus.emitCommand', () => {
  describe('global scope', () => {
    it('runs the inline run() callback and reports handled', () => {
      // `global.openSettings` is the easiest catalogue entry to
      // observe without mocking: its run() flips a $state flag we
      // can check directly. The afterEach hook restores it.
      const cmd = COMMAND_BY_ID['global.openSettings'];
      expect(settingsDialog.open).toBe(false);
      expect(emitCommand(cmd)).toBe(true);
      expect(settingsDialog.open).toBe(true);
    });

    it('reports unhandled when run() throws and catches the error', () => {
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      // Synthesize a global command that throws so we can hit the
      // catch path without monkey-patching a catalogue entry.
      const cmd = {
        id: 'test.throwing-global',
        scope: 'global' as const,
        labelKey: 'never.rendered',
        defaultBinding: null,
        run: () => {
          throw new Error('boom');
        }
      };
      expect(emitCommand(cmd)).toBe(false);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('editor scope', () => {
    it('routes the command id to the active editor of matching kind', () => {
      const onCommand = vi.fn(() => true);
      track(makeListener('markdown', onCommand));
      const cmd = COMMAND_BY_ID['editor.markdown.bold'];
      expect(emitCommand(cmd)).toBe(true);
      expect(onCommand).toHaveBeenCalledWith('editor.markdown.bold');
    });

    it("returns false when active editor's kind differs from command's", () => {
      const onCommand = vi.fn(() => true);
      track(makeListener('freeform', onCommand));
      const cmd = COMMAND_BY_ID['editor.markdown.bold'];
      expect(emitCommand(cmd)).toBe(false);
      expect(onCommand).not.toHaveBeenCalled();
    });

    it('returns false when no editor is registered', () => {
      const cmd = COMMAND_BY_ID['editor.markdown.bold'];
      expect(emitCommand(cmd)).toBe(false);
    });

    it('treats listener void return as handled (handle-by-default)', () => {
      // Most listeners just do the work; making them return `true`
      // explicitly everywhere is ceremony. The bus treats anything
      // other than `false` as handled, including `undefined`.
      const onCommand = vi.fn(() => undefined);
      track(makeListener('markdown', onCommand));
      const cmd = COMMAND_BY_ID['editor.markdown.bold'];
      expect(emitCommand(cmd)).toBe(true);
    });

    it('respects an explicit false return as unhandled', () => {
      // This is how the freeform stub declines markdown commands:
      // it's registered as the active editor (so it displaces
      // markdown on the stack) but returns false to let the manager
      // fall through.
      track(makeListener('markdown', () => false));
      const cmd = COMMAND_BY_ID['editor.markdown.bold'];
      expect(emitCommand(cmd)).toBe(false);
    });

    it('catches listener exceptions and reports unhandled', () => {
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      track(
        makeListener('markdown', () => {
          throw new Error('listener boom');
        })
      );
      const cmd = COMMAND_BY_ID['editor.markdown.bold'];
      expect(emitCommand(cmd)).toBe(false);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});

describe('bus.runActiveEditorCommand', () => {
  it('routes shared app-level editor commands to the active editor', () => {
    const onCommand = vi.fn(() => true);
    track(makeListener('markdown', onCommand));
    expect(runActiveEditorCommand(APP_UNDO_COMMAND)).toBe(true);
    expect(onCommand).toHaveBeenCalledWith(APP_UNDO_COMMAND);
  });

  it('returns false when no editor is registered', () => {
    expect(runActiveEditorCommand(APP_REDO_COMMAND)).toBe(false);
  });
});

describe('bus.searchActiveNote', () => {
  it('routes to the editor for the active note, not the focus-stack top', () => {
    // The PDF note is open but its tab was switched to without clicking
    // into the body, so a markdown editor is still on top of the focus
    // stack. The find command must still reach the PDF.
    const pdfHandled = vi.fn(() => true);
    track(makeListener('pdf', pdfHandled, 'note-pdf'));
    const mdHandled = vi.fn(() => true);
    track(makeListener('markdown', mdHandled, 'note-md'));
    expect(activeEditor()?.noteId).toBe('note-md'); // markdown is on top

    expect(searchActiveNote('note-pdf')).toBe(true);
    expect(pdfHandled).toHaveBeenCalledWith(SEARCH_ACTIVE_NOTE_COMMAND);
    expect(mdHandled).not.toHaveBeenCalled();
  });

  it('falls back to the active editor when no noteId is given', () => {
    const handled = vi.fn(() => true);
    track(makeListener('pdf', handled, 'note-pdf'));
    expect(searchActiveNote()).toBe(true);
    expect(handled).toHaveBeenCalledWith(SEARCH_ACTIVE_NOTE_COMMAND);
  });

  it('returns false when the target editor does not handle find', () => {
    // Lets the global command fall through to the browser's own find
    // instead of swallowing the keystroke for nothing.
    track(makeListener('markdown', () => false, 'note-md'));
    expect(searchActiveNote('note-md')).toBe(false);
  });

  it('returns false when no editor is registered', () => {
    expect(searchActiveNote('whatever')).toBe(false);
  });

  it('the global command falls through when find is unhandled', () => {
    // emitCommand must propagate the run()'s `false` so the manager
    // skips preventDefault and the browser find still works.
    track(makeListener('markdown', () => false, 'note-md'));
    const cmd = COMMAND_BY_ID['global.searchActiveNote'];
    expect(emitCommand(cmd)).toBe(false);
  });
});
