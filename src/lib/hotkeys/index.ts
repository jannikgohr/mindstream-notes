/**
 * Barrel for the hotkey module. Consumers (NoteEditor, FreeformNoteEditor,
 * settings panel, root layout) import from `$lib/hotkeys` rather than
 * reaching into individual files so internal restructuring stays
 * local.
 */

export {
  initHotkeys,
  pushActiveEditor,
  popActiveEditor,
  bindingFromEvent,
  type ActiveEditor
} from './manager.svelte';

export {
  HOTKEY_COMMANDS,
  COMMAND_BY_ID,
  MARKDOWN_ACTIONS,
  groupedCommands,
  type CommandDefinition,
  type GlobalCommand,
  type EditorCommand,
  type CommandGroup
} from './commands';

export {
  getBinding,
  setBinding,
  resetBinding,
  isCustomized,
  findCommandByBinding
} from './store.svelte';

export { displayBinding } from './format';
export { parseBinding, canonicalize, bindingsConflict } from './parse';
export { isMac } from './platform';

export type { Chord, CommandScope, EditorKind } from './types';
