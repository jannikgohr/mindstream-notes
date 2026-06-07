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
  type EditorListener
} from './bus.svelte';

export {
  HOTKEY_COMMANDS,
  GLOBAL_SHORTCUT_COMMAND_IDS,
  COMMAND_BY_ID,
  commandById,
  isGlobalShortcutCommand,
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
  findCommandByBinding
} from './store.svelte';

export { displayBinding, ariaKeyShortcut, tauriAccelerator } from './format';
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
