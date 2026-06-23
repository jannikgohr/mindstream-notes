/**
 * Catalogue of every keyboard-bindable command.
 *
 * One static list, two consumers:
 *
 *   - The hotkey manager iterates this to know what `dispatch` calls
 *     are legal and what default binding each id has.
 *   - The settings panel iterates it to render a row per command,
 *     grouped by `scope` / `editorKind`.
 *
 * Defaults follow the convention the user asked for: Google Docs for
 * headings (`Mod+Alt+0..6`) and list types (`Mod+Shift+7..9`), Notion
 * for inline marks (`Mod+B`, `Mod+I`) which Google Docs and most other
 * editors also agree on.
 *
 * Negative-space rules baked into the catalogue:
 *
 *   1. Editor commands MUST carry an `editorKind`. The settings UI uses
 *      that to group them and the manager uses it to refuse dispatch
 *      to the wrong editor kind. Global commands MUST NOT carry one.
 *
 *   2. `defaultBinding` is the only thing that's allowed to be `null`
 *      — it represents "no default; user can assign one". `null` is
 *      NOT a way to delete a command; remove its row from this list
 *      to do that.
 *
 *   3. Global commands carry their `run` callback inline (they don't
 *      depend on any editor). Editor commands omit `run` — the
 *      editor adapter is the one that knows how to perform them. This
 *      asymmetry is enforced at the type level (see the
 *      `CommandDefinition` union below).
 *
 *   4. Every command id must be unique. The reverse-lookup map in the
 *      store assumes uniqueness; duplicates would silently overwrite
 *      each other.
 */

import { openSettings } from '$lib/settings/store.svelte';
import { openSearch } from '$lib/search/store.svelte';
import { searchActiveNote } from './bus.svelte';
import { openShortcutHelp } from './help.svelte';
import {
  openRightSidebar,
  toggleLeftSidebar,
  toggleRightSidebar,
  ui
} from '$lib/state.svelte';
import type { CommandScope, EditorKind } from './types';

interface BaseCommand {
  id: string;
  labelKey: string;
  defaultBinding: string | null;
}

export interface GlobalCommand extends BaseCommand {
  scope: 'global';
  /**
   * Direct invocation. Runs synchronously from the manager's keydown
   * handler — keep these cheap and side-effect-safe (no async I/O
   * without a yielded `void` Promise) because the listener is on the
   * capture phase and a throw would suppress the default handling
   * without re-firing.
   *
   * Return `false` to mean "not handled" so the manager lets the
   * keystroke fall through to the browser/OS (used by "search active
   * note", which should only swallow Mod+F when it actually opens find).
   * Returning void counts as handled.
   */
  run: () => boolean | void;
}

export interface EditorCommand extends BaseCommand {
  scope: 'editor';
  editorKind: EditorKind;
}

export type CommandDefinition = GlobalCommand | EditorCommand;

type RootNoteKind = 'markdown' | 'freeform' | 'ink';

function runCreateRootNote(kind: RootNoteKind) {
  void import('./create-root-note')
    .then(({ createRootNote }) => createRootNote(kind))
    .catch((err) => {
      console.error('[hotkeys] failed to create note', kind, err);
    });
}

const ADD_TAG_HOTKEY_EVENT = 'mindstream:hotkeys:add-tag';

function requestAddTag() {
  openRightSidebar();
  if (!ui.activeNoteId || typeof window === 'undefined') return;
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent(ADD_TAG_HOTKEY_EVENT));
  }, 0);
}

function runShowApp() {
  void import('$lib/api/window').then(({ focusMainWindow }) =>
    focusMainWindow()
  );
}

export const GLOBAL_SHORTCUT_COMMAND_IDS = [
  'global.newMarkdownNote',
  'global.newDrawing',
  'global.newInkNote',
  'global.showApp'
] as const;

const GLOBAL_SHORTCUT_COMMAND_ID_SET = new Set<string>(
  GLOBAL_SHORTCUT_COMMAND_IDS
);

export const GLOBAL_SHORTCUT_ONLY_COMMAND_IDS = ['global.showApp'] as const;

const GLOBAL_SHORTCUT_ONLY_COMMAND_ID_SET = new Set<string>(
  GLOBAL_SHORTCUT_ONLY_COMMAND_IDS
);

export function isGlobalShortcutCommand(
  command: CommandDefinition | string
): boolean {
  const id = typeof command === 'string' ? command : command.id;
  return GLOBAL_SHORTCUT_COMMAND_ID_SET.has(id);
}

export function isGlobalShortcutOnlyCommand(
  command: CommandDefinition | string
): boolean {
  const id = typeof command === 'string' ? command : command.id;
  return GLOBAL_SHORTCUT_ONLY_COMMAND_ID_SET.has(id);
}

/* --- Command catalogue ----------------------------------------------------- */

/**
 * The canonical list. Order is the order rows appear in the settings
 * UI within each group — kept hand-curated rather than alphabetical so
 * related operations stay visually adjacent (all six headings in a
 * row, the three list types together, etc.).
 */
export const HOTKEY_COMMANDS: CommandDefinition[] = [
  // --- Global ---------------------------------------------------------------
  {
    id: 'global.newMarkdownNote',
    scope: 'global',
    labelKey: 'hotkeys.command.global.newMarkdownNote',
    defaultBinding: 'mod+alt+n',
    run: () => runCreateRootNote('markdown')
  },
  {
    id: 'global.newDrawing',
    scope: 'global',
    labelKey: 'hotkeys.command.global.newDrawing',
    defaultBinding: 'mod+alt+d',
    run: () => runCreateRootNote('freeform')
  },
  {
    id: 'global.newInkNote',
    scope: 'global',
    labelKey: 'hotkeys.command.global.newInkNote',
    defaultBinding: 'mod+alt+i',
    run: () => runCreateRootNote('ink')
  },
  {
    id: 'global.openSettings',
    scope: 'global',
    labelKey: 'hotkeys.command.global.openSettings',
    // Mod+, — the universal "open preferences" shortcut on macOS and the
    // de-facto convention almost everywhere else (VS Code, Chrome).
    defaultBinding: 'mod+,',
    run: () => openSettings()
  },
  {
    id: 'global.openSearch',
    scope: 'global',
    labelKey: 'hotkeys.command.global.openSearch',
    // Mod+Shift+F — Joplin's convention for global note search. Plain
    // Mod+F is reserved for in-document find (browser/editor convention),
    // so we add Shift to disambiguate.
    defaultBinding: 'mod+shift+f',
    run: () => openSearch()
  },
  {
    id: 'global.searchActiveNote',
    scope: 'global',
    labelKey: 'hotkeys.command.global.searchActiveNote',
    // Mod+F — the universal in-document find shortcut. Routed through the
    // bus to the active note's editor, so it's authored once at app
    // level rather than per editor kind. Returns the editor's handled
    // flag so an unhandled Mod+F falls through to the browser's find.
    defaultBinding: 'mod+f',
    run: () => searchActiveNote(ui.activeNoteId)
  },
  {
    id: 'global.toggleNoteOverview',
    scope: 'global',
    labelKey: 'hotkeys.command.global.toggleNoteOverview',
    defaultBinding: null,
    run: () => toggleLeftSidebar()
  },
  {
    id: 'global.toggleNoteMetadata',
    scope: 'global',
    labelKey: 'hotkeys.command.global.toggleNoteMetadata',
    defaultBinding: null,
    run: () => toggleRightSidebar()
  },
  {
    id: 'global.addTag',
    scope: 'global',
    labelKey: 'hotkeys.command.global.addTag',
    defaultBinding: null,
    run: () => requestAddTag()
  },
  {
    id: 'global.showShortcutHelp',
    scope: 'global',
    labelKey: 'hotkeys.command.global.showShortcutHelp',
    // Shift+? — Gmail / GitHub / Notion convention for "show shortcuts".
    // The user types `?` (which already requires Shift on most layouts);
    // the matcher's strict modifier check requires us to encode the
    // shift explicitly so the chord doesn't accidentally fire on
    // layouts where `?` is produced without Shift.
    defaultBinding: 'shift+?',
    run: () => openShortcutHelp()
  },
  {
    id: 'global.showApp',
    scope: 'global',
    labelKey: 'hotkeys.command.global.showApp',
    defaultBinding: null,
    run: () => runShowApp()
  },

  // --- Markdown editor ------------------------------------------------------
  {
    id: 'editor.markdown.undo',
    scope: 'editor',
    editorKind: 'markdown',
    labelKey: 'hotkeys.command.editor.markdown.undo',
    defaultBinding: 'mod+z'
  },
  {
    id: 'editor.markdown.redo',
    scope: 'editor',
    editorKind: 'markdown',
    labelKey: 'hotkeys.command.editor.markdown.redo',
    // Mod+Shift+Z is the universal redo on macOS and works on
    // Windows/Linux too. We deliberately do NOT ship Ctrl+Y as a second
    // default — the user can add it from settings if they want, and
    // sticking to a single default keeps the conflict surface clean.
    defaultBinding: 'mod+shift+z'
  },
  {
    id: 'editor.markdown.bold',
    scope: 'editor',
    editorKind: 'markdown',
    labelKey: 'hotkeys.command.editor.markdown.bold',
    defaultBinding: 'mod+b'
  },
  {
    id: 'editor.markdown.italic',
    scope: 'editor',
    editorKind: 'markdown',
    labelKey: 'hotkeys.command.editor.markdown.italic',
    defaultBinding: 'mod+i'
  },
  {
    id: 'editor.markdown.paragraph',
    scope: 'editor',
    editorKind: 'markdown',
    labelKey: 'hotkeys.command.editor.markdown.paragraph',
    // Google Docs convention: Mod+Alt+0 returns to normal text.
    defaultBinding: 'mod+alt+0'
  },
  {
    id: 'editor.markdown.h1',
    scope: 'editor',
    editorKind: 'markdown',
    labelKey: 'hotkeys.command.editor.markdown.h1',
    defaultBinding: 'mod+alt+1'
  },
  {
    id: 'editor.markdown.h2',
    scope: 'editor',
    editorKind: 'markdown',
    labelKey: 'hotkeys.command.editor.markdown.h2',
    defaultBinding: 'mod+alt+2'
  },
  {
    id: 'editor.markdown.h3',
    scope: 'editor',
    editorKind: 'markdown',
    labelKey: 'hotkeys.command.editor.markdown.h3',
    defaultBinding: 'mod+alt+3'
  },
  {
    id: 'editor.markdown.h4',
    scope: 'editor',
    editorKind: 'markdown',
    labelKey: 'hotkeys.command.editor.markdown.h4',
    defaultBinding: 'mod+alt+4'
  },
  {
    id: 'editor.markdown.h5',
    scope: 'editor',
    editorKind: 'markdown',
    labelKey: 'hotkeys.command.editor.markdown.h5',
    defaultBinding: 'mod+alt+5'
  },
  {
    id: 'editor.markdown.h6',
    scope: 'editor',
    editorKind: 'markdown',
    labelKey: 'hotkeys.command.editor.markdown.h6',
    defaultBinding: 'mod+alt+6'
  },
  {
    id: 'editor.markdown.orderedList',
    scope: 'editor',
    editorKind: 'markdown',
    labelKey: 'hotkeys.command.editor.markdown.orderedList',
    defaultBinding: 'mod+shift+7'
  },
  {
    id: 'editor.markdown.bulletList',
    scope: 'editor',
    editorKind: 'markdown',
    labelKey: 'hotkeys.command.editor.markdown.bulletList',
    // Google Docs convention: Shift+8 on the number row maps to the
    // bullet glyph for typists who learned by symbol position.
    defaultBinding: 'mod+shift+8'
  },
  {
    id: 'editor.markdown.taskList',
    scope: 'editor',
    editorKind: 'markdown',
    labelKey: 'hotkeys.command.editor.markdown.taskList',
    defaultBinding: 'mod+shift+9'
  },
  {
    id: 'editor.markdown.imageBlock',
    scope: 'editor',
    editorKind: 'markdown',
    labelKey: 'hotkeys.command.editor.markdown.imageBlock',
    defaultBinding: null
  },
  {
    id: 'editor.markdown.codeBlock',
    scope: 'editor',
    editorKind: 'markdown',
    labelKey: 'hotkeys.command.editor.markdown.codeBlock',
    // No truly universal default for "code block" — Notion uses
    // Mod+Shift+C, VS Code uses Mod+K Ctrl+K, Google Docs has nothing
    // specific. We pick Notion's because it composes well with the
    // existing inline shortcuts and reads cleanly.
    defaultBinding: 'mod+shift+c'
  },
  {
    id: 'editor.markdown.table',
    scope: 'editor',
    editorKind: 'markdown',
    labelKey: 'hotkeys.command.editor.markdown.table',
    defaultBinding: null
  },
  {
    id: 'editor.markdown.math',
    scope: 'editor',
    editorKind: 'markdown',
    labelKey: 'hotkeys.command.editor.markdown.math',
    defaultBinding: null
  },
  {
    id: 'editor.markdown.mermaidDiagram',
    scope: 'editor',
    editorKind: 'markdown',
    labelKey: 'hotkeys.command.editor.markdown.mermaidDiagram',
    defaultBinding: null
  },

  // --- Ink editor -----------------------------------------------------------
  {
    id: 'editor.ink.pen',
    scope: 'editor',
    editorKind: 'ink',
    labelKey: 'hotkeys.command.editor.ink.pen',
    defaultBinding: null
  },
  {
    id: 'editor.ink.eraser',
    scope: 'editor',
    editorKind: 'ink',
    labelKey: 'hotkeys.command.editor.ink.eraser',
    defaultBinding: null
  },
  {
    id: 'editor.ink.lasso',
    scope: 'editor',
    editorKind: 'ink',
    labelKey: 'hotkeys.command.editor.ink.lasso',
    defaultBinding: null
  },
  {
    id: 'editor.ink.undo',
    scope: 'editor',
    editorKind: 'ink',
    labelKey: 'hotkeys.command.editor.ink.undo',
    defaultBinding: null
  },
  {
    id: 'editor.ink.redo',
    scope: 'editor',
    editorKind: 'ink',
    labelKey: 'hotkeys.command.editor.ink.redo',
    defaultBinding: null
  },
  {
    id: 'editor.ink.toggleFingerDrawing',
    scope: 'editor',
    editorKind: 'ink',
    labelKey: 'hotkeys.command.editor.ink.toggleFingerDrawing',
    defaultBinding: null
  },
  {
    id: 'editor.ink.togglePageTheme',
    scope: 'editor',
    editorKind: 'ink',
    labelKey: 'hotkeys.command.editor.ink.togglePageTheme',
    defaultBinding: null
  },
  {
    id: 'editor.ink.togglePageBackground',
    scope: 'editor',
    editorKind: 'ink',
    labelKey: 'hotkeys.command.editor.ink.togglePageBackground',
    defaultBinding: null
  },
  {
    id: 'editor.ink.clear',
    scope: 'editor',
    editorKind: 'ink',
    labelKey: 'hotkeys.command.editor.ink.clear',
    defaultBinding: null
  },

  // --- PDF viewer -----------------------------------------------------------
  {
    id: 'editor.pdf.select',
    scope: 'editor',
    editorKind: 'pdf',
    labelKey: 'hotkeys.command.editor.pdf.select',
    defaultBinding: null
  },
  {
    id: 'editor.pdf.highlight',
    scope: 'editor',
    editorKind: 'pdf',
    labelKey: 'hotkeys.command.editor.pdf.highlight',
    defaultBinding: null
  },
  {
    id: 'editor.pdf.comment',
    scope: 'editor',
    editorKind: 'pdf',
    labelKey: 'hotkeys.command.editor.pdf.comment',
    defaultBinding: null
  },
  {
    id: 'editor.pdf.pen',
    scope: 'editor',
    editorKind: 'pdf',
    labelKey: 'hotkeys.command.editor.pdf.pen',
    defaultBinding: null
  },
  {
    id: 'editor.pdf.signature',
    scope: 'editor',
    editorKind: 'pdf',
    labelKey: 'hotkeys.command.editor.pdf.signature',
    defaultBinding: null
  },
  {
    id: 'editor.pdf.deleteAnnotation',
    scope: 'editor',
    editorKind: 'pdf',
    labelKey: 'hotkeys.command.editor.pdf.deleteAnnotation',
    defaultBinding: null
  },
  {
    id: 'editor.pdf.undo',
    scope: 'editor',
    editorKind: 'pdf',
    labelKey: 'hotkeys.command.editor.pdf.undo',
    defaultBinding: null
  },
  {
    id: 'editor.pdf.redo',
    scope: 'editor',
    editorKind: 'pdf',
    labelKey: 'hotkeys.command.editor.pdf.redo',
    defaultBinding: null
  },
  {
    id: 'editor.pdf.toggleComments',
    scope: 'editor',
    editorKind: 'pdf',
    labelKey: 'hotkeys.command.editor.pdf.toggleComments',
    defaultBinding: null
  },
  {
    id: 'editor.pdf.toggleNavigator',
    scope: 'editor',
    editorKind: 'pdf',
    labelKey: 'hotkeys.command.editor.pdf.toggleNavigator',
    defaultBinding: null
  },
  {
    id: 'editor.pdf.previousPage',
    scope: 'editor',
    editorKind: 'pdf',
    labelKey: 'hotkeys.command.editor.pdf.previousPage',
    defaultBinding: null
  },
  {
    id: 'editor.pdf.nextPage',
    scope: 'editor',
    editorKind: 'pdf',
    labelKey: 'hotkeys.command.editor.pdf.nextPage',
    defaultBinding: null
  },
  {
    id: 'editor.pdf.export',
    scope: 'editor',
    editorKind: 'pdf',
    labelKey: 'hotkeys.command.editor.pdf.export',
    defaultBinding: null
  },
  {
    id: 'editor.pdf.zoomOut',
    scope: 'editor',
    editorKind: 'pdf',
    labelKey: 'hotkeys.command.editor.pdf.zoomOut',
    defaultBinding: null
  },
  {
    id: 'editor.pdf.toggleZoomMenu',
    scope: 'editor',
    editorKind: 'pdf',
    labelKey: 'hotkeys.command.editor.pdf.toggleZoomMenu',
    defaultBinding: null
  },
  {
    id: 'editor.pdf.zoomIn',
    scope: 'editor',
    editorKind: 'pdf',
    labelKey: 'hotkeys.command.editor.pdf.zoomIn',
    defaultBinding: null
  }
];

/**
 * Map id → definition. Built once at module load; the catalogue is
 * static so we don't need to invalidate.
 */
export const COMMAND_BY_ID: Record<string, CommandDefinition> =
  Object.fromEntries(HOTKEY_COMMANDS.map((c) => [c.id, c]));

/**
 * Null-safe lookup for non-keyboard callers (toolbar buttons,
 * command palette, future tray menus).
 *
 * Use this rather than reading from `COMMAND_BY_ID` directly so an
 * unknown / mistyped id surfaces as a `null` return — a runtime
 * TypeError on `cmd.run()` (because `COMMAND_BY_ID[badId]` is
 * `undefined`) is harder to debug than the missing branch you'd add
 * to handle `null` here.
 *
 * Calling pattern:
 *
 *     const cmd = commandById('editor.markdown.bold');
 *     if (cmd) emitCommand(cmd);
 *
 * That's the entire non-keyboard contract. The bus does scope routing
 * and error handling internally; callers shouldn't need to know about
 * `EditorListener`, `activeEditor`, or any of the dispatch internals.
 */
export function commandById(id: string): CommandDefinition | null {
  return COMMAND_BY_ID[id] ?? null;
}

/** Group commands for the settings UI. Order of groups itself matches
 *  the order ids first appear in HOTKEY_COMMANDS. Returns
 *  `[{ scope, editorKind, commands }]` so the rendering layer can
 *  iterate and never has to know about the underlying flat list. */
export interface CommandGroup {
  scope: CommandScope;
  editorKind: EditorKind | null;
  commands: CommandDefinition[];
}

export function groupedCommands(): CommandGroup[] {
  const groups = new Map<string, CommandGroup>();
  for (const cmd of HOTKEY_COMMANDS) {
    const editorKind = cmd.scope === 'editor' ? cmd.editorKind : null;
    const key = `${cmd.scope}:${editorKind ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      group = { scope: cmd.scope, editorKind, commands: [] };
      groups.set(key, group);
    }
    group.commands.push(cmd);
  }
  return Array.from(groups.values());
}
