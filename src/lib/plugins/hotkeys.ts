/**
 * Adapts plugin command contributions into the app's hotkey system.
 *
 * A plugin command is app-local only: it becomes a `global`-scope
 * {@link GlobalCommand} whose `run()` performs the app-owned action (currently
 * just `createTemplateNote`). It is deliberately NOT registered as a native /
 * global OS shortcut — it dispatches through the same in-app keydown path as
 * built-in application commands, with the same collision handling.
 *
 * The app-wide command id is `plugin.<pluginId>.<localId>`, matching the
 * namespacing used everywhere else. Labels resolve through plugin i18n (via
 * {@link pluginCommandLabel}) rather than the core `tUi` bundle.
 */

import type { GlobalCommand } from '$lib/hotkeys/catalogue';
import { pluginCommands } from './registry.svelte';
import { resolvePluginString } from './plugin-i18n';
import { runPluginTemplate } from './menu';

/** The app-wide hotkey command id for a plugin-local command id. */
export function pluginHotkeyCommandId(
  pluginId: string,
  localId: string
): string {
  return `plugin.${pluginId}.${localId}`;
}

/**
 * Every enabled plugin command as a dispatchable global command. Rebuilt on
 * each call from the live registry, so disabling a plugin drops its commands
 * out of the catalogue's merged views on the next read.
 */
export function pluginHotkeyCommands(): GlobalCommand[] {
  return pluginCommands().map(({ pluginId, command }) => ({
    id: pluginHotkeyCommandId(pluginId, command.id),
    scope: 'global',
    labelKey: `plugins.${pluginId}.${command.labelKey}`,
    defaultBinding: command.defaultBinding ?? null,
    run: () => {
      // The action union is closed and app-owned — a plugin can't smuggle in
      // arbitrary behaviour, only pick one of the handlers the app provides.
      if (command.action.type === 'createTemplateNote') {
        void runPluginTemplate(pluginId, command.action.templateId, null);
      }
    }
  }));
}

/**
 * Localized label for a plugin command id, or `undefined` when the id isn't a
 * plugin command. The hotkey UI uses this to resolve plugin command labels
 * through plugin i18n while still falling back to `tUi` for built-ins.
 */
export function pluginCommandLabel(commandId: string): string | undefined {
  for (const { pluginId, command } of pluginCommands()) {
    if (pluginHotkeyCommandId(pluginId, command.id) === commandId) {
      return resolvePluginString(pluginId, command.labelKey);
    }
  }
  return undefined;
}
