/**
 * Plugin sidebar views as left-sidebar sources. A view's source id is
 * `plugin:<pluginId>:<viewId>`; plugin ids are dotted and view ids are slugs,
 * so neither contains the separator.
 */

import {
  pluginSidebarViews,
  type PluginSidebarViewRef
} from './registry.svelte';

export type PluginViewSource = `plugin:${string}`;

export function sidebarViewSource(
  pluginId: string,
  viewId: string
): PluginViewSource {
  return `plugin:${pluginId}:${viewId}`;
}

/** The enabled view a source id names, or `undefined` once it's gone. */
export function sidebarViewForSource(
  source: string
): PluginSidebarViewRef | undefined {
  if (!source.startsWith('plugin:')) return undefined;
  return pluginSidebarViews().find(
    (ref) => sidebarViewSource(ref.pluginId, ref.view.id) === source
  );
}

type ActionListener = (actionId: string) => void;
const listeners = new Map<string, Set<ActionListener>>();

/** Deliver an action-row click to the view drawn for `source`. */
export function sendSidebarViewAction(source: string, actionId: string): void {
  for (const listener of listeners.get(source) ?? []) listener(actionId);
}

/** Listen for action-row clicks meant for `source`. Returns the unsubscribe. */
export function onSidebarViewAction(
  source: string,
  listener: ActionListener
): () => void {
  let set = listeners.get(source);
  if (!set) listeners.set(source, (set = new Set()));
  set.add(listener);
  return () => set.delete(listener);
}
