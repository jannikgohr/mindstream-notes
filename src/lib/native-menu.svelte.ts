import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { listen } from '@tauri-apps/api/event';
import { setMode } from 'mode-watcher';
import { isTauri } from '$lib/api/core';
import { commandById } from '$lib/hotkeys/catalogue';
import { activeEditor, emitCommand } from '$lib/hotkeys/bus.svelte';
import type { EditorKind } from '$lib/hotkeys/types';
import { requestOpenNote } from '$lib/stores/open-note-intent.svelte';
import { importPdfIn } from '$lib/stores/tree.svelte';

const NATIVE_MENU_COMMAND_EVENT = 'native-menu-command';

interface NativeMenuCommandPayload {
  command: string;
}

let initialized = false;

export function initNativeMenuCommands(): void {
  if (initialized) return;
  initialized = true;
  if (!isTauri()) return;

  void listen<NativeMenuCommandPayload>(
    NATIVE_MENU_COMMAND_EVENT,
    async (event) => {
      if (!(await isCurrentWindowFocused())) return;
      await runNativeMenuCommand(event.payload.command);
    }
  ).catch((err) => {
    console.warn('[native-menu] listener unavailable', err);
  });
}

async function isCurrentWindowFocused(): Promise<boolean> {
  try {
    return await getCurrentWebviewWindow().isFocused();
  } catch {
    return true;
  }
}

async function runNativeMenuCommand(command: string): Promise<void> {
  switch (command) {
    case 'open-settings':
      emitHotkeyCommand('global.openSettings');
      return;
    case 'new-markdown-note':
      emitHotkeyCommand('global.newMarkdownNote');
      return;
    case 'new-drawing':
      emitHotkeyCommand('global.newDrawing');
      return;
    case 'new-ink-note':
      emitHotkeyCommand('global.newInkNote');
      return;
    case 'import-pdf':
      await importPdfFromPicker();
      return;
    case 'undo':
      runUndoRedo('undo');
      return;
    case 'redo':
      runUndoRedo('redo');
      return;
    case 'cut':
      runDocumentEditCommand('cut');
      return;
    case 'copy':
      runDocumentEditCommand('copy');
      return;
    case 'paste':
      runDocumentEditCommand('paste');
      return;
    case 'select-all':
      runDocumentEditCommand('selectAll');
      return;
    case 'toggle-sidebar':
      emitHotkeyCommand('global.toggleNoteOverview');
      return;
    case 'toggle-metadata':
      emitHotkeyCommand('global.toggleNoteMetadata');
      return;
    case 'search-notes':
      emitHotkeyCommand('global.openSearch');
      return;
    case 'theme-light':
      setMode('light');
      return;
    case 'theme-dark':
      setMode('dark');
      return;
    case 'theme-system':
      setMode('system');
      return;
    case 'show-keyboard-shortcuts':
      emitHotkeyCommand('global.showShortcutHelp');
      return;
    default:
      console.warn('[native-menu] unknown command', command);
  }
}

function emitHotkeyCommand(commandId: string): boolean {
  const command = commandById(commandId);
  if (!command) {
    console.warn('[native-menu] unknown hotkey command', commandId);
    return false;
  }
  return emitCommand(command);
}

function runUndoRedo(action: 'undo' | 'redo'): void {
  const editor = activeEditor();
  if (editor) {
    const commandId = undoRedoCommandId(editor.kind, action);
    if (commandId && emitHotkeyCommand(commandId)) return;
  }
  runDocumentEditCommand(action);
}

function undoRedoCommandId(
  kind: EditorKind,
  action: 'undo' | 'redo'
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
      return null;
  }
}

function runDocumentEditCommand(command: string): void {
  try {
    document.execCommand(command);
  } catch (err) {
    console.warn('[native-menu] edit command failed', command, err);
  }
}

async function importPdfFromPicker(): Promise<void> {
  const file = await pickPdfFile();
  if (!file) return;
  const id = await importPdfIn(null, file);
  requestOpenNote(id);
}

function pickPdfFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,.pdf';
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.style.top = '-9999px';
    document.body.appendChild(input);

    let resolved = false;
    const finish = (file: File | null) => {
      if (resolved) return;
      resolved = true;
      input.remove();
      resolve(file);
    };

    input.addEventListener('change', () => {
      finish(input.files?.[0] ?? null);
    });
    input.addEventListener('cancel', () => finish(null));
    window.setTimeout(() => {
      if (document.body.contains(input) && document.activeElement !== input) {
        input.addEventListener('focusout', () => finish(null), { once: true });
      }
    }, 0);
    input.click();
  });
}
