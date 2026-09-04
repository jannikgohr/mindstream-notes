/**
 * Runs the declarative **effects** a plugin's backend script returns — the "app performs,
 * the plugin only computes" half of the scripted-plugin contract.
 *
 * A toolbar button's click runs a backend export via `plugins_run_script`; the
 * return value is parsed into a closed {@link PluginEffect} union and executed
 * here against app-owned primitives (note creation, insertion, a context menu,
 * toasts). A script can only pick these effects — it never touches the DOM or
 * does I/O itself — and note creation is gated on the plugin's `notes.create`
 * permission, exactly like the declarative tier.
 *
 * The single mechanism gives a button either behaviour: return a terminal
 * effect for a one-shot action, or `openMenu` for a sub-menu (the Templates
 * picker enumerates its notes in the runtime and returns a menu of `createNoteFromNote`).
 */

import { pluginsRunScript } from '$lib/api/plugins';
import type { NoteKind } from '$lib/api';
import { createNoteIn, tree } from '$lib/stores/tree.svelte';
import { requestOpenNote } from '$lib/stores/open-note-intent.svelte';
import { insertMarkdownIntoActiveNote } from '$lib/hotkeys';
import { createNoteFromNote } from '$lib/templates/user-templates';
import { pushToast } from '$lib/components/toast.svelte';
import type { MenuItem } from '$lib/components/context-menu-types';
import { buildPluginContext } from './plugin-ctx';
import { openPluginMenu } from './plugin-menu.svelte';
import { pluginById, pluginNoteKind } from './registry.svelte';
import type {
  PluginEffect,
  PluginEffectMenuItem,
  PluginPermission,
  PluginToolbarButton
} from './types';

/** Viewport anchor for effects that need a position (a menu). */
export interface EffectAnchor {
  x: number;
  y: number;
}

/** Extra context for running an effect. */
export interface RunEffectOptions {
  /**
   * Folder the app should create notes in when the effect itself doesn't name
   * one — e.g. the folder a file-tree context menu was opened on. A `parentId`
   * on the effect still wins, so a plugin can target a specific folder itself.
   */
  defaultParentId?: string | null;
}

function pluginHasPermission(
  pluginId: string,
  permission: PluginPermission
): boolean {
  return (
    pluginById(pluginId)?.manifest.permissions.includes(permission) ?? false
  );
}

function requireCreate(pluginId: string): void {
  if (!pluginHasPermission(pluginId, 'notes.create')) {
    throw new Error(
      `Plugin "${pluginId}" is not permitted to create notes (missing notes.create)`
    );
  }
}

function requireCreateKind(pluginId: string, noteKind: string): void {
  if (noteKind === 'markdown') return;
  const ref = pluginNoteKind(noteKind);
  if (!ref || ref.pluginId !== pluginId) {
    throw new Error(
      `Plugin "${pluginId}" cannot create unsupported note kind "${noteKind}"`
    );
  }
}

/**
 * Validate an untrusted script return value into a {@link PluginEffect}, or
 * `null` if it isn't one we understand. Defensive: the script is sandboxed but
 * its JSON is still untrusted, so every field is shape-checked before use, and
 * `openMenu` items are parsed recursively.
 */
export function parsePluginEffect(value: unknown): PluginEffect | null {
  if (!value || typeof value !== 'object') return null;
  const e = value as Record<string, unknown>;
  const parentId = typeof e.parentId === 'string' ? e.parentId : null;
  switch (e.effect) {
    case 'none':
      return { effect: 'none' };
    case 'toast':
      if (typeof e.message !== 'string') return null;
      return {
        effect: 'toast',
        message: e.message,
        kind: e.kind === 'error' ? 'error' : 'info'
      };
    case 'createNote':
      if (typeof e.title !== 'string' || typeof e.body !== 'string')
        return null;
      if (typeof e.noteKind === 'string') {
        return {
          effect: 'createNote',
          title: e.title,
          body: e.body,
          noteKind: e.noteKind,
          parentId
        };
      }
      return {
        effect: 'createNote',
        title: e.title,
        body: e.body,
        parentId
      };
    case 'createNoteFromNote':
      if (typeof e.sourceNoteId !== 'string') return null;
      return {
        effect: 'createNoteFromNote',
        sourceNoteId: e.sourceNoteId,
        parentId
      };
    case 'insertMarkdown':
      if (typeof e.markdown !== 'string') return null;
      return { effect: 'insertMarkdown', markdown: e.markdown };
    case 'openMenu': {
      if (!Array.isArray(e.items)) return null;
      const items = [];
      for (const raw of e.items) {
        if (!raw || typeof raw !== 'object') continue;
        const label = (raw as Record<string, unknown>).label;
        const run = parsePluginEffect((raw as Record<string, unknown>).run);
        if (typeof label === 'string' && run) items.push({ label, run });
      }
      return { effect: 'openMenu', items };
    }
    default:
      return null;
  }
}

function pluginEffectMenuItems(
  pluginId: string,
  items: PluginEffectMenuItem[],
  anchor?: EffectAnchor,
  opts?: RunEffectOptions
): MenuItem[] {
  return items.map((it) => {
    const noteKind =
      it.run.effect === 'createNote'
        ? (it.run.noteKind ?? 'markdown')
        : it.run.effect === 'createNoteFromNote'
          ? tree.notesById?.[it.run.sourceNoteId]?.note_kind
          : undefined;
    const pluginKind = pluginNoteKind(noteKind);
    return {
      label: it.label,
      noteKind,
      pluginIcon: pluginKind?.contribution?.icon
        ? {
            pluginId: pluginKind.pluginId,
            file: pluginKind.contribution.icon
          }
        : undefined,
      onSelect: () => void runPluginEffect(pluginId, it.run, anchor, opts)
    };
  });
}

/**
 * Convert a parsed plugin effect into context-menu data. `openMenu` becomes real
 * submenu children, so host menus can expose plugin-owned menus on hover.
 */
export function menuItemFromPluginEffect(
  pluginId: string,
  id: string,
  label: string,
  effect: PluginEffect,
  anchor?: EffectAnchor,
  opts?: RunEffectOptions
): MenuItem {
  if (effect.effect === 'openMenu') {
    return {
      id,
      label,
      children: pluginEffectMenuItems(pluginId, effect.items, anchor, opts)
    };
  }
  return {
    id,
    label,
    onSelect: () => void runPluginEffect(pluginId, effect, anchor, opts)
  };
}

/** Perform one parsed effect. Note-creating effects require `notes.create`. */
export async function runPluginEffect(
  pluginId: string,
  effect: PluginEffect,
  anchor?: EffectAnchor,
  opts?: RunEffectOptions
): Promise<void> {
  const parentId = (e: { parentId?: string | null }) =>
    e.parentId ?? opts?.defaultParentId ?? null;
  switch (effect.effect) {
    case 'none':
      return;
    case 'toast':
      pushToast(effect.message, {
        variant: effect.kind === 'error' ? 'error' : 'info'
      });
      return;
    case 'createNote': {
      requireCreate(pluginId);
      const noteKind = effect.noteKind ?? 'markdown';
      requireCreateKind(pluginId, noteKind);
      const id = await createNoteIn(
        parentId(effect),
        effect.title,
        noteKind as NoteKind,
        effect.body
      );
      requestOpenNote(id);
      return;
    }
    case 'createNoteFromNote':
      requireCreate(pluginId);
      await createNoteFromNote(effect.sourceNoteId, parentId(effect));
      return;
    case 'insertMarkdown':
      insertMarkdownIntoActiveNote(effect.markdown);
      return;
    case 'openMenu': {
      const items = pluginEffectMenuItems(pluginId, effect.items, anchor, opts);
      openPluginMenu(anchor?.x ?? 0, anchor?.y ?? 0, items);
      return;
    }
  }
}

/**
 * Run a toolbar button's backend export and return its parsed effect without
 * performing it. Host surfaces use this when they need to render plugin-owned
 * `openMenu` effects as native submenus rather than opening a second menu later.
 */
export async function pluginButtonEffect(
  pluginId: string,
  button: PluginToolbarButton
): Promise<PluginEffect | null> {
  if (button.action.type !== 'script') {
    console.error(
      '[plugins] toolbar button is not a script action',
      pluginId,
      button.id
    );
    return null;
  }
  try {
    const ctx = buildPluginContext();
    const raw = await pluginsRunScript(pluginId, button.action.export, ctx);
    const effect = parsePluginEffect(raw);
    if (!effect) {
      console.error(
        '[plugins] toolbar button returned an invalid effect',
        pluginId,
        button.id,
        raw
      );
      return null;
    }
    return effect;
  } catch (err) {
    console.error('[plugins] toolbar button failed', pluginId, button.id, err);
    return null;
  }
}

/**
 * Run a toolbar button: build its context, invoke its backend export, and perform
 * the returned effect. Fire-and-forget (menu/toolbar handlers), so failures are
 * logged rather than thrown out of the click handler. `anchor` positions an
 * `openMenu` effect under the button.
 */
export async function runPluginButton(
  pluginId: string,
  button: PluginToolbarButton,
  anchor?: EffectAnchor,
  opts?: RunEffectOptions
): Promise<void> {
  const effect = await pluginButtonEffect(pluginId, button);
  if (effect) {
    await runPluginEffect(pluginId, effect, anchor, opts);
  }
}
