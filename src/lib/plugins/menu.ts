/**
 * Shared data for surfacing plugin note templates in create menus.
 *
 * Both the desktop file explorer (toolbar + context menu) and the mobile FAB
 * read from here, so a template appears identically everywhere and the label
 * always comes from plugin i18n. Only *enabled* plugins' templates are listed
 * (the registry's merged view already filters disabled/unapproved plugins).
 */

import { pluginTemplates } from './registry.svelte';
import {
  resolvePluginString,
  resolvePluginStringOptional
} from './plugin-i18n';
import { createNoteFromPluginTemplate } from './templates';

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
  parentId: string | null
): Promise<void> {
  try {
    await createNoteFromPluginTemplate(pluginId, templateId, parentId);
  } catch (err) {
    console.error(
      '[plugins] template note creation failed',
      pluginId,
      templateId,
      err
    );
  }
}
