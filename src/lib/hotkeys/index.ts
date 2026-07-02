/**
 * Barrel for the hotkey module. Consumers (NoteEditor, FreeformNoteEditor,
 * settings panel, root layout, toolbar) import from `$lib/hotkeys` rather
 * than reaching into individual files so internal restructuring stays
 * local.
 */

export { initHotkeys, bindingFromEvent } from './manager.svelte';

export {
  registerEditor,
  unregisterEditor,
  emitCommand,
  activeEditor,
  searchActiveNote,
  runActiveEditorCommand,
  SEARCH_ACTIVE_NOTE_COMMAND,
  APP_UNDO_COMMAND,
  APP_REDO_COMMAND,
  type EditorListener
} from './bus.svelte';

export {
  HOTKEY_COMMANDS,
  GLOBAL_SHORTCUT_COMMAND_IDS,
  GLOBAL_SHORTCUT_ONLY_COMMAND_IDS,
  COMMAND_BY_ID,
  commandById,
  isGlobalShortcutCommand,
  isGlobalShortcutOnlyCommand,
  MARKDOWN_ACTIONS,
  groupedCommands,
  type CommandDefinition,
  type GlobalCommand,
  type EditorCommand,
  type CommandGroup
} from './commands';

export {
  hotkeys,
  getBinding,
  setBinding,
  resetBinding,
  isCustomized,
  findCommandByBinding,
  commandsCanCollide,
  HotkeyBindingConflictError
} from './store.svelte';

export {
  displayBinding,
  ariaKeyShortcut,
  tauriAccelerator,
  globalShortcutAccelerator,
  globalShortcutSupportReason,
  type GlobalShortcutUnsupportedReason
} from './format';
export { parseBinding, canonicalize, bindingsConflict } from './parse';
export { wellKnownConflict } from './collisions';
export {
  shortcutHelp,
  openShortcutHelp,
  closeShortcutHelp
} from './help.svelte';
export { syncGlobalShortcuts, teardownGlobalShortcuts } from './global.svelte';
export { isMac } from './platform';

export type { Chord, CommandScope, EditorKind } from './types';
