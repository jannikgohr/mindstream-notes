/**
 * Shared data for surfacing plugin note templates in create menus.
 *
 * Both the desktop file explorer (toolbar + context menu) and the mobile FAB
 * read from here, so a template appears identically everywhere and the label
 * always comes from plugin i18n. Only *enabled* plugins' templates are listed
 * (the registry's merged view already filters disabled/unapproved plugins).
 */

import { pluginById, pluginTemplate, pluginTemplates } from './registry.svelte';
import {
  resolvePluginString,
  resolvePluginStringOptional
} from './plugin-i18n';
import {
  createNoteFromPluginTemplate,
  renderPluginTemplate
} from './templates';
import {
  createNoteFromUserTemplate,
  renderUserTemplateBody,
  userTemplateEntries
} from '$lib/templates/user-templates';

/** A create-menu entry for one plugin template, labels already localized. */
export interface PluginTemplateEntry {
  pluginId: string;
  templateId: string;
  label: string;
  description?: string;
}

/** Localized entries for every enabled plugin template, in registry order. */
export function pluginTemplateEntries(): PluginTemplateEntry[] {
  return pluginTemplates().map(({ pluginId, template }) => ({
    pluginId,
    templateId: template.id,
    label: resolvePluginString(pluginId, template.labelKey),
    description: template.descriptionKey
      ? resolvePluginStringOptional(pluginId, template.descriptionKey)
      : undefined
  }));
}

/** True when at least one enabled plugin contributes a template. */
export function hasPluginTemplates(): boolean {
  return pluginTemplates().length > 0;
}

/**
 * Create + open a note from a template, swallowing failures with a console
 * error. Menu handlers are fire-and-forget, so this keeps a bad template from
 * throwing out of an onSelect and into the menu component.
 */
export async function runPluginTemplate(
  pluginId: string,
  templateId: string,
  parentId: string | null,
  title?: string
): Promise<void> {
  try {
    await createNoteFromPluginTemplate(
      pluginId,
      templateId,
      parentId,
      {},
      title
    );
  } catch (err) {
    console.error(
      '[plugins] template note creation failed',
      pluginId,
      templateId,
      err
    );
  }
}

/** The plugin-owned note kind a template creates, or null if it can't resolve. */
export function pluginTemplateNoteKind(
  pluginId: string,
  templateId: string
): string | null {
  return pluginTemplate(pluginId, templateId)?.template.noteKind ?? null;
}

/**
 * The title to seed a name-first draft with for a plugin template. Declarative
 * templates render their `titleTemplate` synchronously (a sensible placeholder,
 * e.g. "Untitled Typst document"); scripted templates can't render
 * synchronously, so fall back to the template's localized label.
 */
export function pluginTemplateDefaultTitle(
  pluginId: string,
  templateId: string
): string {
  const ref = pluginTemplate(pluginId, templateId);
  if (!ref) return '';
  const runtime = pluginById(pluginId)?.manifest.runtime;
  const useScript =
    !!ref.template.render && (runtime === 'luau' || runtime === 'wasm');
  if (!useScript) {
    try {
      return renderPluginTemplate(pluginId, ref.template).title;
    } catch {
      // Fall back to the label below.
    }
  }
  return resolvePluginString(pluginId, ref.template.labelKey);
}

/**
 * A unified create-menu entry: either a plugin-contributed template (the premade
 * ones) or a user template (a note designated via the folder/tag sources). The
 * menus render both from one list so a user's own templates sit alongside — or,
 * with "Show built-in templates" off, instead of — the premade set.
 */
export type TemplateMenuEntry =
  | ({ kind: 'plugin' } & PluginTemplateEntry)
  | { kind: 'user'; noteId: string; label: string; description?: string };

/**
 * Every template offered in the create menus: any plugin-contributed templates
 * followed by the user's own (folder/tag sourced), in that order.
 */
export function templateMenuEntries(): TemplateMenuEntry[] {
  const plugin: TemplateMenuEntry[] = pluginTemplateEntries().map((entry) => ({
    kind: 'plugin',
    ...entry
  }));
  const user: TemplateMenuEntry[] = userTemplateEntries().map((entry) => ({
    kind: 'user',
    noteId: entry.noteId,
    label: entry.label
  }));
  return [...plugin, ...user];
}

/** True when the create menus have at least one template to offer. */
export function hasTemplateEntries(): boolean {
  return templateMenuEntries().length > 0;
}

/**
 * The rendered markdown *body* a unified template entry produces, for inserting
 * into an existing note (the command palette's "Insert into note" action).
 * Placeholders (`{{date}}`, `{{title}}`, …) are interpolated exactly as for
 * note creation — the only difference is no note is created and the title is
 * discarded, since insertion drops content at the caret. Throws on a missing
 * plugin template so the caller can decide how to surface it.
 */
export async function renderTemplateEntryBody(
  entry: TemplateMenuEntry
): Promise<string> {
  if (entry.kind === 'plugin') {
    const ref = pluginTemplate(entry.pluginId, entry.templateId);
    if (!ref) {
      throw new Error(
        `No enabled template "${entry.templateId}" from plugin "${entry.pluginId}"`
      );
    }
    return renderPluginTemplate(entry.pluginId, ref.template).body;
  }
  return renderUserTemplateBody(entry.noteId);
}

/**
 * Create + open a note from a unified template entry (plugin or user),
 * swallowing failures like [`runPluginTemplate`] so a bad template never throws
 * out of a menu handler.
 */
export async function runTemplateEntry(
  entry: TemplateMenuEntry,
  parentId: string | null
): Promise<void> {
  try {
    if (entry.kind === 'plugin') {
      await createNoteFromPluginTemplate(
        entry.pluginId,
        entry.templateId,
        parentId
      );
    } else {
      await createNoteFromUserTemplate(entry.noteId, parentId);
    }
  } catch (err) {
    console.error('[templates] note creation failed', entry, err);
  }
}
