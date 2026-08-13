/**
 * A single app-level context menu that plugin effects can open.
 *
 * The shared `ContextMenu` is otherwise driven by component-local state; a
 * plugin's `openMenu` effect isn't tied to any one component, so it pushes its
 * items here and a root-mounted host (`PluginMenuHost.svelte`) renders them.
 * Kept tiny — a menu doesn't need to survive a close.
 */

import type { MenuItem } from '$lib/components/context-menu-types';

export const pluginMenu = $state<{
  open: boolean;
  x: number;
  y: number;
  items: (MenuItem | 'separator')[];
}>({ open: false, x: 0, y: 0, items: [] });

/** Open the plugin context menu at viewport coords `(x, y)` with `items`. */
export function openPluginMenu(
  x: number,
  y: number,
  items: (MenuItem | 'separator')[]
): void {
  pluginMenu.x = x;
  pluginMenu.y = y;
  pluginMenu.items = items;
  pluginMenu.open = true;
}

export function closePluginMenu(): void {
  pluginMenu.open = false;
  pluginMenu.items = [];
}
