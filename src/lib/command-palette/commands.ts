/**
 * Assembles the command-palette entry list from the app's existing command
 * surfaces. Two sections today:
 *
 *   - **application** — every global-scope hotkey command (built-in *and*
 *     plugin-contributed, since plugin commands are global). Each is runnable
 *     from the palette whether or not the user bound a hotkey to it; the
 *     current binding, if any, is shown as a hint. Global-shortcut-only
 *     commands (Show app) and the palette's own opener are excluded.
 *
 *   - **templates** — every template offered in the create menus (plugin +
 *     user folder/tag sources). Each yields a "New note from …" entry, and —
 *     when a markdown editor is active — an "Insert … into note" entry that
 *     drops the template's rendered body at the caret of the current note.
 *
 * Rebuilt on each call (like `groupedCommands()` / `templateMenuEntries()`) so
 * it reflects the live set of enabled plugins, bindings, and the active editor.
 * The palette component calls this once when it opens.
 */

import {
  activeEditor,
  allHotkeyCommands,
  displayBinding,
  emitCommand,
  getBinding,
  insertMarkdownIntoActiveNote,
  isGlobalShortcutOnlyCommand
} from '$lib/hotkeys';
import { pluginCommandLabel } from '$lib/plugins/hotkeys';
import {
  renderTemplateEntryBody,
  runTemplateEntry,
  templateMenuEntries,
  type TemplateMenuEntry
} from '$lib/plugins/menu';
import { tUi } from '$lib/settings/i18n.svelte';

export type PaletteSection = 'application' | 'templates';

/** One runnable row in the command palette. */
export interface PaletteCommand {
  /** Stable, unique id — used as the `#each` key and for selection tracking. */
  id: string;
  /** Localized, ready-to-render label. */
  label: string;
  section: PaletteSection;
  /** Extra text folded into the fuzzy match (descriptions, synonyms). */
  keywords?: string;
  /** Displayed keyboard shortcut, when the command has one bound. */
  hint?: string | null;
  /** Perform the action. The palette closes itself before calling this. */
  run: () => void;
}

/** The palette's own opener — never listed inside the palette itself. */
const OPEN_PALETTE_COMMAND_ID = 'global.openCommandPalette';

/** A stable per-entry key so plugin and user templates never collide. */
function templateKey(entry: TemplateMenuEntry): string {
  return entry.kind === 'plugin'
    ? `${entry.pluginId}:${entry.templateId}`
    : `user:${entry.noteId}`;
}

/** Substitute the localized `{name}` placeholder in a template action label. */
function withName(key: Parameters<typeof tUi>[0], name: string): string {
  return tUi(key).replace('{name}', name);
}

/** Global-scope hotkey commands as palette entries. */
function applicationCommands(): PaletteCommand[] {
  const out: PaletteCommand[] = [];
  for (const cmd of allHotkeyCommands()) {
    if (cmd.scope !== 'global') continue;
    if (isGlobalShortcutOnlyCommand(cmd)) continue;
    if (cmd.id === OPEN_PALETTE_COMMAND_ID) continue;
    out.push({
      id: cmd.id,
      label: pluginCommandLabel(cmd.id) ?? tUi(cmd.labelKey),
      section: 'application',
      hint: displayBinding(getBinding(cmd.id)),
      run: () => {
        emitCommand(cmd);
      }
    });
  }
  return out;
}

/** Template create/insert actions as palette entries. */
function templateCommands(): PaletteCommand[] {
  // Capture the active editor now (when the palette is built), not when an
  // insert runs: the render is async, so the target note is pinned to the one
  // that was focused as the palette opened rather than whatever is active when
  // the promise resolves.
  const target = activeEditor();
  const canInsert = target?.kind === 'markdown';
  const targetNoteId = target?.noteId;
  const out: PaletteCommand[] = [];
  for (const entry of templateMenuEntries()) {
    const key = templateKey(entry);
    out.push({
      id: `template.new.${key}`,
      label: withName('commandPalette.template.newNote', entry.label),
      section: 'templates',
      keywords: entry.description,
      run: () => {
        void runTemplateEntry(entry, null);
      }
    });
    if (canInsert) {
      out.push({
        id: `template.insert.${key}`,
        label: withName('commandPalette.template.insert', entry.label),
        section: 'templates',
        keywords: entry.description,
        run: () => {
          void renderTemplateEntryBody(entry)
            .then((body) => insertMarkdownIntoActiveNote(body, targetNoteId))
            .catch((err) => {
              console.error(
                '[command-palette] template insert failed',
                key,
                err
              );
            });
        }
      });
    }
  }
  return out;
}

/** The full palette entry list, freshly built from the live app state. */
export function paletteCommands(): PaletteCommand[] {
  return [...applicationCommands(), ...templateCommands()];
}
