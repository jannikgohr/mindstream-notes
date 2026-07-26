/**
 * Surfaces a notification when the integrity / signature gate has disabled one
 * or more third-party plugins ("not loaded because of changes"). A single,
 * stable notification lists the affected plugins; tapping it deep-links to the
 * Plugins settings overview where each can be re-approved. Cleared when nothing
 * is gated.
 */

import { tUi } from '$lib/settings/i18n.svelte';
import { openSettings } from '$lib/settings/store.svelte';
import {
  clearNotificationsByKind,
  upsertNotification
} from '$lib/notifications/store.svelte';
import { PLUGINS_CATEGORY_ID } from './settings-bridge';

const GATED_KIND = 'plugin-gated' as const;
/** Stable id so repeated discoveries refresh one notification, not stack. */
const GATED_ID = 'plugin-gated';

/** A plugin the gate disabled, for the notification body. */
export interface GatedPlugin {
  id: string;
  name: string;
}

/**
 * Report (or clear) the "plugins need re-approval" notification. Idempotent:
 * pass the current gated set on each discovery; an empty set clears it.
 */
export function reportGatedPlugins(gated: GatedPlugin[]): void {
  if (gated.length === 0) {
    clearNotificationsByKind(GATED_KIND);
    return;
  }
  const names = gated.map((g) => g.name).join(', ');
  upsertNotification({
    id: GATED_ID,
    kind: GATED_KIND,
    widgetType: 'generic',
    createdAt: Date.now(),
    data: {
      title: tUi('notifications.plugins.gated.title'),
      message: tUi('notifications.plugins.gated.message').replace(
        '{plugins}',
        names
      )
    },
    onOpen: () => openSettings(PLUGINS_CATEGORY_ID)
  });
}
