import { describe, expect, it } from 'vitest';
import {
  documentEditCommandForNativeMenuCommand,
  hotkeyCommandForNativeMenuCommand,
  themeModeForNativeMenuCommand,
  undoRedoActionForNativeMenuCommand,
  undoRedoCommandId
} from './native-menu-commands';

describe('native menu command mapping', () => {
  it.each([
    ['open-settings', 'global.openSettings'],
    ['new-markdown-note', 'global.newMarkdownNote'],
    ['new-drawing', 'global.newDrawing'],
    ['new-ink-note', 'global.newInkNote'],
    ['toggle-sidebar', 'global.toggleNoteOverview'],
    ['toggle-metadata', 'global.toggleNoteMetadata'],
    ['search-notes', 'global.openSearch'],
    ['show-keyboard-shortcuts', 'global.showShortcutHelp']
  ])('maps %s to %s', (nativeCommand, hotkeyCommand) => {
    expect(hotkeyCommandForNativeMenuCommand(nativeCommand)).toBe(
      hotkeyCommand
    );
  });

  it('ignores commands that are not hotkey-bus commands', () => {
    expect(hotkeyCommandForNativeMenuCommand('import-pdf')).toBeNull();
    expect(hotkeyCommandForNativeMenuCommand('theme-dark')).toBeNull();
    expect(hotkeyCommandForNativeMenuCommand('unknown')).toBeNull();
  });

  it.each([
    ['theme-light', 'light'],
    ['theme-dark', 'dark'],
    ['theme-system', 'system']
  ] as const)('maps %s to theme mode %s', (nativeCommand, mode) => {
    expect(themeModeForNativeMenuCommand(nativeCommand)).toBe(mode);
  });

  it('maps document edit commands to execCommand names', () => {
    expect(documentEditCommandForNativeMenuCommand('cut')).toBe('cut');
    expect(documentEditCommandForNativeMenuCommand('copy')).toBe('copy');
    expect(documentEditCommandForNativeMenuCommand('paste')).toBe('paste');
    expect(documentEditCommandForNativeMenuCommand('select-all')).toBe(
      'selectAll'
    );
    expect(documentEditCommandForNativeMenuCommand('undo')).toBeNull();
  });

  it('recognizes undo/redo native commands', () => {
    expect(undoRedoActionForNativeMenuCommand('undo')).toBe('undo');
    expect(undoRedoActionForNativeMenuCommand('redo')).toBe('redo');
    expect(undoRedoActionForNativeMenuCommand('cut')).toBeNull();
  });

  it.each([
    ['markdown', 'undo', 'editor.markdown.undo'],
    ['markdown', 'redo', 'editor.markdown.redo'],
    ['ink', 'undo', 'editor.ink.undo'],
    ['pdf', 'redo', 'editor.pdf.redo']
  ] as const)('maps %s %s to %s', (kind, action, commandId) => {
    expect(undoRedoCommandId(kind, action)).toBe(commandId);
  });

  it('does not invent undo/redo commands for editors without native mapping', () => {
    expect(undoRedoCommandId('freeform', 'undo')).toBeNull();
    expect(undoRedoCommandId('drawing', 'redo')).toBeNull();
  });
});
