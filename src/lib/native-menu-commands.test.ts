import { describe, expect, it } from 'vitest';
import {
  documentEditCommandForNativeMenuCommand,
  hotkeyCommandForNativeMenuCommand,
  isNativeMenuCommand,
  NativeDocumentEditCommand,
  NativeMenuCommand,
  NativeUndoRedoAction,
  ThemeMode,
  themeModeForNativeMenuCommand,
  undoRedoActionForNativeMenuCommand,
  undoRedoCommandId
} from './native-menu-commands';

describe('native menu command mapping', () => {
  it.each([
    [NativeMenuCommand.OpenSettings, 'global.openSettings'],
    [NativeMenuCommand.NewMarkdownNote, 'global.newMarkdownNote'],
    [NativeMenuCommand.NewDrawing, 'global.newDrawing'],
    [NativeMenuCommand.NewInkNote, 'global.newInkNote'],
    [NativeMenuCommand.ToggleSidebar, 'global.toggleNoteOverview'],
    [NativeMenuCommand.ToggleMetadata, 'global.toggleNoteMetadata'],
    [NativeMenuCommand.SearchNotes, 'global.openSearch'],
    [NativeMenuCommand.ShowKeyboardShortcuts, 'global.showShortcutHelp']
  ])('maps %s to %s', (nativeCommand, hotkeyCommand) => {
    expect(hotkeyCommandForNativeMenuCommand(nativeCommand)).toBe(
      hotkeyCommand
    );
  });

  it('ignores commands that are not hotkey-bus commands', () => {
    expect(
      hotkeyCommandForNativeMenuCommand(NativeMenuCommand.ImportPdf)
    ).toBeNull();
    expect(
      hotkeyCommandForNativeMenuCommand(NativeMenuCommand.ThemeDark)
    ).toBeNull();
  });

  it.each([
    [NativeMenuCommand.ThemeLight, ThemeMode.Light],
    [NativeMenuCommand.ThemeDark, ThemeMode.Dark],
    [NativeMenuCommand.ThemeSystem, ThemeMode.System]
  ] as const)('maps %s to theme mode %s', (nativeCommand, mode) => {
    expect(themeModeForNativeMenuCommand(nativeCommand)).toBe(mode);
  });

  it('maps document edit commands to execCommand names', () => {
    expect(documentEditCommandForNativeMenuCommand(NativeMenuCommand.Cut)).toBe(
      NativeDocumentEditCommand.Cut
    );
    expect(
      documentEditCommandForNativeMenuCommand(NativeMenuCommand.Copy)
    ).toBe(NativeDocumentEditCommand.Copy);
    expect(
      documentEditCommandForNativeMenuCommand(NativeMenuCommand.Paste)
    ).toBe(NativeDocumentEditCommand.Paste);
    expect(
      documentEditCommandForNativeMenuCommand(NativeMenuCommand.SelectAll)
    ).toBe(NativeDocumentEditCommand.SelectAll);
    expect(
      documentEditCommandForNativeMenuCommand(NativeMenuCommand.Undo)
    ).toBeNull();
  });

  it('recognizes undo/redo native commands', () => {
    expect(undoRedoActionForNativeMenuCommand(NativeMenuCommand.Undo)).toBe(
      NativeUndoRedoAction.Undo
    );
    expect(undoRedoActionForNativeMenuCommand(NativeMenuCommand.Redo)).toBe(
      NativeUndoRedoAction.Redo
    );
    expect(
      undoRedoActionForNativeMenuCommand(NativeMenuCommand.Cut)
    ).toBeNull();
  });

  it('rejects unknown wire commands before dispatch', () => {
    expect(isNativeMenuCommand('theme-high-contrast')).toBe(false);
    expect(isNativeMenuCommand('history')).toBe(false);
  });

  it.each([
    ['markdown', NativeUndoRedoAction.Undo, 'editor.markdown.undo'],
    ['markdown', NativeUndoRedoAction.Redo, 'editor.markdown.redo'],
    ['ink', NativeUndoRedoAction.Undo, 'editor.ink.undo'],
    ['pdf', NativeUndoRedoAction.Redo, 'editor.pdf.redo']
  ] as const)('maps %s %s to %s', (kind, action, commandId) => {
    expect(undoRedoCommandId(kind, action)).toBe(commandId);
  });

  it('does not invent undo/redo commands for editors without native mapping', () => {
    expect(undoRedoCommandId('freeform', NativeUndoRedoAction.Undo)).toBeNull();
    expect(undoRedoCommandId('drawing', NativeUndoRedoAction.Redo)).toBeNull();
  });
});
