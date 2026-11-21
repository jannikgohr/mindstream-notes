/**
 * Plugin tab views as main-area panels. The layout shell that owns the tabs
 * subscribes; the `openTabView` effect asks it to open one. A view's panel id
 * is `view:<pluginId>:<viewId>`, so a view has at most one tab.
 */

import { tUi } from '$lib/settings/i18n.svelte';

type OpenTabViewHandler = (pluginId: string, viewId: string) => void;
const handlers = new Set<OpenTabViewHandler>();

export function tabViewPanelId(pluginId: string, viewId: string): string {
  return `view:${pluginId}:${viewId}`;
}

/** Handle open requests. Returns the unsubscribe. */
export function onOpenTabView(handler: OpenTabViewHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/** Open or bring forward a tab view, or throw where there are no tabs. */
export function openTabView(pluginId: string, viewId: string): void {
  if (handlers.size === 0) throw new Error(tUi('plugins.tabViewUnavailable'));
  for (const handler of handlers) handler(pluginId, viewId);
}
