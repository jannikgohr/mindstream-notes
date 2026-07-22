import type { EditorKind } from '$lib/hotkeys/types';

export enum NativeMenuCommand {
  OpenSettings = 'openSettings',
  NewMarkdownNote = 'newMarkdownNote',
  NewDrawing = 'newDrawing',
  NewInkNote = 'newInkNote',
  ImportPdf = 'importPdf',
  Undo = 'undo',
  Redo = 'redo',
  Cut = 'cut',
  Copy = 'copy',
  Paste = 'paste',
  SelectAll = 'selectAll',
  ToggleSidebar = 'toggleSidebar',
  ToggleMetadata = 'toggleMetadata',
  SearchNotes = 'searchNotes',
  ThemeLight = 'themeLight',
  ThemeDark = 'themeDark',
  ThemeSystem = 'themeSystem',
  ShowKeyboardShortcuts = 'showKeyboardShortcuts'
}

export enum ThemeMode {
  Light = 'light',
  Dark = 'dark',
  System = 'system'
}

export enum NativeDocumentEditCommand {
  Cut = 'cut',
  Copy = 'copy',
  Paste = 'paste',
  SelectAll = 'selectAll'
}

export enum NativeUndoRedoAction {
  Undo = 'undo',
  Redo = 'redo'
}

export function isNativeMenuCommand(
  value: unknown
): value is NativeMenuCommand {
  return (
    typeof value === 'string' &&
    (Object.values(NativeMenuCommand) as string[]).includes(value)
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled native menu command: ${String(value)}`);
}

export function hotkeyCommandForNativeMenuCommand(
  command: NativeMenuCommand
): string | null {
  switch (command) {
    case NativeMenuCommand.OpenSettings:
      return 'global.openSettings';
    case NativeMenuCommand.NewMarkdownNote:
      return 'global.newMarkdownNote';
    case NativeMenuCommand.NewDrawing:
      return 'global.newDrawing';
    case NativeMenuCommand.NewInkNote:
      return 'global.newInkNote';
    case NativeMenuCommand.ToggleSidebar:
      return 'global.toggleNoteOverview';
    case NativeMenuCommand.ToggleMetadata:
      return 'global.toggleNoteMetadata';
    case NativeMenuCommand.SearchNotes:
      return 'global.openSearch';
    case NativeMenuCommand.ShowKeyboardShortcuts:
      return 'global.showShortcutHelp';
    case NativeMenuCommand.ImportPdf:
    case NativeMenuCommand.Undo:
    case NativeMenuCommand.Redo:
    case NativeMenuCommand.Cut:
    case NativeMenuCommand.Copy:
    case NativeMenuCommand.Paste:
    case NativeMenuCommand.SelectAll:
    case NativeMenuCommand.ThemeLight:
    case NativeMenuCommand.ThemeDark:
    case NativeMenuCommand.ThemeSystem:
      return null;
    default:
      return assertNever(command);
  }
}

export function themeModeForNativeMenuCommand(
  command: NativeMenuCommand
): ThemeMode | null {
  switch (command) {
    case NativeMenuCommand.ThemeLight:
      return ThemeMode.Light;
    case NativeMenuCommand.ThemeDark:
      return ThemeMode.Dark;
    case NativeMenuCommand.ThemeSystem:
      return ThemeMode.System;
    case NativeMenuCommand.OpenSettings:
    case NativeMenuCommand.NewMarkdownNote:
    case NativeMenuCommand.NewDrawing:
    case NativeMenuCommand.NewInkNote:
    case NativeMenuCommand.ImportPdf:
    case NativeMenuCommand.Undo:
    case NativeMenuCommand.Redo:
    case NativeMenuCommand.Cut:
    case NativeMenuCommand.Copy:
    case NativeMenuCommand.Paste:
    case NativeMenuCommand.SelectAll:
    case NativeMenuCommand.ToggleSidebar:
    case NativeMenuCommand.ToggleMetadata:
    case NativeMenuCommand.SearchNotes:
    case NativeMenuCommand.ShowKeyboardShortcuts:
      return null;
    default:
      return assertNever(command);
  }
}

export function documentEditCommandForNativeMenuCommand(
  command: NativeMenuCommand
): NativeDocumentEditCommand | null {
  switch (command) {
    case NativeMenuCommand.Cut:
      return NativeDocumentEditCommand.Cut;
    case NativeMenuCommand.Copy:
      return NativeDocumentEditCommand.Copy;
    case NativeMenuCommand.Paste:
      return NativeDocumentEditCommand.Paste;
    case NativeMenuCommand.SelectAll:
      return NativeDocumentEditCommand.SelectAll;
    case NativeMenuCommand.OpenSettings:
    case NativeMenuCommand.NewMarkdownNote:
    case NativeMenuCommand.NewDrawing:
    case NativeMenuCommand.NewInkNote:
    case NativeMenuCommand.ImportPdf:
    case NativeMenuCommand.Undo:
    case NativeMenuCommand.Redo:
    case NativeMenuCommand.ToggleSidebar:
    case NativeMenuCommand.ToggleMetadata:
    case NativeMenuCommand.SearchNotes:
    case NativeMenuCommand.ThemeLight:
    case NativeMenuCommand.ThemeDark:
    case NativeMenuCommand.ThemeSystem:
    case NativeMenuCommand.ShowKeyboardShortcuts:
      return null;
    default:
      return assertNever(command);
  }
}

export function undoRedoActionForNativeMenuCommand(
  command: NativeMenuCommand
): NativeUndoRedoAction | null {
  switch (command) {
    case NativeMenuCommand.Undo:
      return NativeUndoRedoAction.Undo;
    case NativeMenuCommand.Redo:
      return NativeUndoRedoAction.Redo;
    case NativeMenuCommand.OpenSettings:
    case NativeMenuCommand.NewMarkdownNote:
    case NativeMenuCommand.NewDrawing:
    case NativeMenuCommand.NewInkNote:
    case NativeMenuCommand.ImportPdf:
    case NativeMenuCommand.Cut:
    case NativeMenuCommand.Copy:
    case NativeMenuCommand.Paste:
    case NativeMenuCommand.SelectAll:
    case NativeMenuCommand.ToggleSidebar:
    case NativeMenuCommand.ToggleMetadata:
    case NativeMenuCommand.SearchNotes:
    case NativeMenuCommand.ThemeLight:
    case NativeMenuCommand.ThemeDark:
    case NativeMenuCommand.ThemeSystem:
    case NativeMenuCommand.ShowKeyboardShortcuts:
      return null;
    default:
      return assertNever(command);
  }
}

export function undoRedoCommandId(
  kind: EditorKind,
  action: NativeUndoRedoAction
): string | null {
  switch (kind) {
    case 'markdown':
      return `editor.markdown.${action}`;
    case 'ink':
      return `editor.ink.${action}`;
    case 'pdf':
      return `editor.pdf.${action}`;
    case 'freeform':
    case 'drawing':
    case 'kanban':
      return null;
  }
}
