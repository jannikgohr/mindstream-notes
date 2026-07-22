import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { listen } from '@tauri-apps/api/event';
import { setMode } from 'mode-watcher';
import { isTauri } from '$lib/api/core';
import { commandById } from '$lib/hotkeys/catalogue';
import { activeEditor, emitCommand } from '$lib/hotkeys/bus.svelte';
import { requestOpenNote } from '$lib/stores/open-note-intent.svelte';
import { importPdfIn } from '$lib/stores/tree.svelte';
import {
  documentEditCommandForNativeMenuCommand,
  hotkeyCommandForNativeMenuCommand,
  isNativeMenuCommand,
  NativeDocumentEditCommand,
  NativeMenuCommand,
  NativeUndoRedoAction,
  themeModeForNativeMenuCommand,
  undoRedoActionForNativeMenuCommand,
  undoRedoCommandId
} from '$lib/native-menu-commands';

const NATIVE_MENU_COMMAND_EVENT = 'native-menu-command';

interface NativeMenuCommandPayload {
  command: NativeMenuCommand;
}

let initialized = false;

export function initNativeMenuCommands(): void {
  if (initialized) return;
  initialized = true;
  if (!isTauri()) return;

  void listen<NativeMenuCommandPayload>(
    NATIVE_MENU_COMMAND_EVENT,
    async (event) => {
      if (!isNativeMenuCommand(event.payload?.command)) {
        console.warn('[native-menu] invalid command payload', event.payload);
        return;
      }
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

async function runNativeMenuCommand(command: NativeMenuCommand): Promise<void> {
  const hotkeyCommand = hotkeyCommandForNativeMenuCommand(command);
  if (hotkeyCommand) {
    emitHotkeyCommand(hotkeyCommand);
    return;
  }

  const themeMode = themeModeForNativeMenuCommand(command);
  if (themeMode) {
    setMode(themeMode);
    return;
  }

  const editCommand = documentEditCommandForNativeMenuCommand(command);
  if (editCommand) {
    runDocumentEditCommand(editCommand);
    return;
  }

  const undoRedoAction = undoRedoActionForNativeMenuCommand(command);
  if (undoRedoAction) {
    runUndoRedo(undoRedoAction);
    return;
  }

  if (command === NativeMenuCommand.ImportPdf) {
    await importPdfFromPicker();
    return;
  }

  console.warn('[native-menu] unknown command', command);
}

function emitHotkeyCommand(commandId: string): boolean {
  const command = commandById(commandId);
  if (!command) {
    console.warn('[native-menu] unknown hotkey command', commandId);
    return false;
  }
  return emitCommand(command);
}

function runUndoRedo(action: NativeUndoRedoAction): void {
  const editor = activeEditor();
  if (editor) {
    const commandId = undoRedoCommandId(editor.kind, action);
    if (commandId && emitHotkeyCommand(commandId)) return;
  }
  runDocumentEditCommand(action);
}

function runDocumentEditCommand(
  command: NativeDocumentEditCommand | NativeUndoRedoAction
): void {
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
