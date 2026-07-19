import type { EditorKind } from '$lib/hotkeys/types';

export type ThemeMode = 'light' | 'dark' | 'system';
export type NativeDocumentEditCommand = 'cut' | 'copy' | 'paste' | 'selectAll';
export type NativeUndoRedoAction = 'undo' | 'redo';

export function hotkeyCommandForNativeMenuCommand(
  command: string
): string | null {
  switch (command) {
    case 'open-settings':
      return 'global.openSettings';
    case 'new-markdown-note':
      return 'global.newMarkdownNote';
    case 'new-drawing':
      return 'global.newDrawing';
    case 'new-ink-note':
      return 'global.newInkNote';
    case 'toggle-sidebar':
      return 'global.toggleNoteOverview';
    case 'toggle-metadata':
      return 'global.toggleNoteMetadata';
    case 'search-notes':
      return 'global.openSearch';
    case 'show-keyboard-shortcuts':
      return 'global.showShortcutHelp';
    default:
      return null;
  }
}

export function themeModeForNativeMenuCommand(
  command: string
): ThemeMode | null {
  switch (command) {
    case 'theme-light':
      return 'light';
    case 'theme-dark':
      return 'dark';
    case 'theme-system':
      return 'system';
    default:
      return null;
  }
}

export function documentEditCommandForNativeMenuCommand(
  command: string
): NativeDocumentEditCommand | null {
  switch (command) {
    case 'cut':
    case 'copy':
    case 'paste':
      return command;
    case 'select-all':
      return 'selectAll';
    default:
      return null;
  }
}

export function undoRedoActionForNativeMenuCommand(
  command: string
): NativeUndoRedoAction | null {
  switch (command) {
    case 'undo':
    case 'redo':
      return command;
    default:
      return null;
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
