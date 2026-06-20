/**
 * Catalogue-drift guards.
 *
 * The hotkey module spreads its state across four authored surfaces:
 *
 *   - `HOTKEY_COMMANDS` lists every bindable command with its scope,
 *     default binding, and i18n key.
 *   - `MARKDOWN_ACTIONS` maps each markdown command id to a `(ctx) =>`
 *     callback the NoteEditor adapter dispatches.
 *   - Global commands carry their `run()` inline on the catalogue
 *     entry.
 *   - `defaultBinding` strings get re-parsed at every keypress.
 *
 * Each of these can drift independently — add a command but forget the
 * action, rename an id and orphan a row in either direction, ship a
 * typo'd default that silently never matches. The runtime warns when
 * it notices, but the warning lands on whatever user happens to press
 * the broken shortcut first.
 *
 * These tests promote those four kinds of drift from "runtime warn"
 * to "CI fail at PR review". One test per failure mode so a single
 * `pnpm test` line tells you exactly which invariant got broken.
 */

import { describe, expect, it } from 'vitest';
import {
  commandById,
  GLOBAL_SHORTCUT_COMMAND_IDS,
  GLOBAL_SHORTCUT_ONLY_COMMAND_IDS,
  groupedCommands,
  HOTKEY_COMMANDS,
  isGlobalShortcutCommand,
  isGlobalShortcutOnlyCommand,
  MARKDOWN_ACTIONS
} from './commands';
import { parseBinding } from './parse';

describe('catalogue consistency', () => {
  it('every markdown command has a registered action', () => {
    // Forgotten MARKDOWN_ACTIONS entries become `[NoteEditor] unknown
    // markdown command id` warnings at first press, which is exactly
    // when the user notices. Surface it before merge instead.
    const missing: string[] = [];
    for (const cmd of HOTKEY_COMMANDS) {
      if (cmd.scope !== 'editor' || cmd.editorKind !== 'markdown') continue;
      if (!(cmd.id in MARKDOWN_ACTIONS)) missing.push(cmd.id);
    }
    expect(missing).toEqual([]);
  });

  it('every markdown action maps to a real command', () => {
    // The reverse drift: a renamed command leaves a stale
    // MARKDOWN_ACTIONS entry that's unreachable but loads / takes up
    // bundle space. Catching it means the table truly mirrors the
    // catalogue.
    const markdownIds = new Set(
      HOTKEY_COMMANDS.filter(
        (c) => c.scope === 'editor' && c.editorKind === 'markdown'
      ).map((c) => c.id)
    );
    const stale: string[] = [];
    for (const id of Object.keys(MARKDOWN_ACTIONS)) {
      if (!markdownIds.has(id)) stale.push(id);
    }
    expect(stale).toEqual([]);
  });

  it('every non-null default binding parses', () => {
    // A typo here (e.g. `mod-alt+1` instead of `mod+alt+1`) makes the
    // manager silently skip the command forever — `getBinding`
    // returns the unparseable string and `parseBinding` returns null
    // inside `findMatchingCommand`, which then `continue`s. The
    // command is dead from the user's perspective with no error.
    const invalid: string[] = [];
    for (const cmd of HOTKEY_COMMANDS) {
      if (cmd.defaultBinding === null) continue;
      if (parseBinding(cmd.defaultBinding) === null) {
        invalid.push(`${cmd.id}: "${cmd.defaultBinding}"`);
      }
    }
    expect(invalid).toEqual([]);
  });

  it('every global command carries a run() function', () => {
    // GlobalCommand's `run` is declared on the TypeScript interface
    // but at the catalogue authoring site nothing forces it to be a
    // function (could be undefined if a refactor strips it). The bus
    // calls `cmd.run()` directly; a missing run would throw "is not
    // a function" on first press.
    const missing: string[] = [];
    for (const cmd of HOTKEY_COMMANDS) {
      if (cmd.scope !== 'global') continue;
      if (typeof (cmd as { run?: unknown }).run !== 'function') {
        missing.push(cmd.id);
      }
    }
    expect(missing).toEqual([]);
  });

  it('registers only native global shortcut commands in the global shortcut set', () => {
    expect([...GLOBAL_SHORTCUT_COMMAND_IDS]).toEqual([
      'global.newMarkdownNote',
      'global.newDrawing',
      'global.newInkNote',
      'global.showApp'
    ]);
    for (const id of GLOBAL_SHORTCUT_COMMAND_IDS) {
      expect(commandById(id)?.scope).toBe('global');
      expect(isGlobalShortcutCommand(id)).toBe(true);
    }
  });

  it('marks show app as the only global-shortcut-only command', () => {
    expect([...GLOBAL_SHORTCUT_ONLY_COMMAND_IDS]).toEqual(['global.showApp']);
    expect(isGlobalShortcutOnlyCommand('global.showApp')).toBe(true);
    expect(isGlobalShortcutOnlyCommand('global.newMarkdownNote')).toBe(false);
  });

  it('command ids are unique', () => {
    // COMMAND_BY_ID is built with Object.fromEntries, which silently
    // keeps the LAST duplicate and drops the rest. Duplicates produce
    // a "the wrong command fires" symptom that's hard to track down
    // without explicit checking here.
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const cmd of HOTKEY_COMMANDS) {
      if (seen.has(cmd.id)) duplicates.push(cmd.id);
      seen.add(cmd.id);
    }
    expect(duplicates).toEqual([]);
  });

  it('commandById returns the matching definition', () => {
    // The null-safe lookup helper is the contract for non-keyboard
    // callers. Keep its happy and miss paths covered so a regression
    // (e.g. someone replacing `?? null` with an unsafe cast) shows up.
    expect(commandById('editor.markdown.bold')?.id).toBe(
      'editor.markdown.bold'
    );
    expect(commandById('global.openSettings')?.scope).toBe('global');
  });

  it('commandById returns null for unknown ids', () => {
    expect(commandById('totally.made.up')).toBeNull();
    expect(commandById('')).toBeNull();
  });

  it('no two commands ship the same default binding', () => {
    // Conflicting defaults would mean the first matching command in
    // `findMatchingCommand`'s iteration wins, and the second is
    // effectively dead on a fresh install. The user could only reach
    // the second by rebinding it manually. Catalogue authors should
    // pick non-overlapping defaults.
    const byBinding = new Map<string, string[]>();
    for (const cmd of HOTKEY_COMMANDS) {
      if (!cmd.defaultBinding) continue;
      const list = byBinding.get(cmd.defaultBinding) ?? [];
      list.push(cmd.id);
      byBinding.set(cmd.defaultBinding, list);
    }
    const collisions: string[] = [];
    for (const [binding, ids] of byBinding) {
      if (ids.length > 1) collisions.push(`${binding} → ${ids.join(', ')}`);
    }
    expect(collisions).toEqual([]);
  });

  it('shows ordered list before bullet list in markdown hotkey groups', () => {
    const markdownGroup = groupedCommands().find(
      (group) => group.scope === 'editor' && group.editorKind === 'markdown'
    );
    const ids = markdownGroup?.commands.map((cmd) => cmd.id) ?? [];

    expect(ids.indexOf('editor.markdown.orderedList')).toBeGreaterThanOrEqual(
      0
    );
    expect(ids.indexOf('editor.markdown.bulletList')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('editor.markdown.orderedList')).toBeLessThan(
      ids.indexOf('editor.markdown.bulletList')
    );
  });

  it('ships non-code advanced markdown toolbar actions unset by default', () => {
    const advancedIds = [
      'editor.markdown.imageBlock',
      'editor.markdown.table',
      'editor.markdown.math',
      'editor.markdown.mermaidDiagram'
    ];

    for (const id of advancedIds) {
      expect(commandById(id)?.defaultBinding).toBeNull();
    }
  });

  it('ships ink toolbar actions unset by default', () => {
    const inkIds = [
      'editor.ink.pen',
      'editor.ink.eraser',
      'editor.ink.undo',
      'editor.ink.redo',
      'editor.ink.toggleFingerDrawing',
      'editor.ink.togglePageTheme',
      'editor.ink.togglePageBackground',
      'editor.ink.clear'
    ];

    for (const id of inkIds) {
      const command = commandById(id);
      expect(command).toMatchObject({
        scope: 'editor',
        editorKind: 'ink',
        defaultBinding: null
      });
    }
  });

  it('ships pdf toolbar actions unset by default', () => {
    const pdfIds = [
      'editor.pdf.select',
      'editor.pdf.highlight',
      'editor.pdf.comment',
      'editor.pdf.pen',
      'editor.pdf.signature',
      'editor.pdf.deleteAnnotation',
      'editor.pdf.undo',
      'editor.pdf.redo',
      'editor.pdf.toggleComments',
      'editor.pdf.toggleNavigator',
      'editor.pdf.previousPage',
      'editor.pdf.nextPage',
      'editor.pdf.export',
      'editor.pdf.zoomOut',
      'editor.pdf.toggleZoomMenu',
      'editor.pdf.zoomIn'
    ];

    for (const id of pdfIds) {
      const command = commandById(id);
      expect(command).toMatchObject({
        scope: 'editor',
        editorKind: 'pdf',
        defaultBinding: null
      });
    }
  });
});
