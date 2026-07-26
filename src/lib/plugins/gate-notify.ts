/**
 * Surfaces notifications when the integrity / signature gate has disabled one or
 * more third-party plugins. Two distinct cases, each its own notification so the
 * message matches what actually happened:
 *
 *   - **new** — a third-party plugin was discovered but never approved. It won't
 *     load until the user reviews and approves it.
 *   - **changed** — a plugin the user *had* approved no longer matches its
 *     accepted hash / signer. It won't load until it's reviewed and re-approved.
 *
 * Both deep-link to the Plugins settings overview where each can be approved.
 * Each notification is stable (one id) and idempotent: pass the current gated
 * set on every discovery; an empty subset clears that notification.
 */

import { tUi } from '$lib/settings/i18n.svelte';
import type { I18nBundle } from '$lib/settings/types';
import { openSettings } from '$lib/settings/store.svelte';
import {
  clearNotificationsByKind,
  upsertNotification
} from '$lib/notifications/store.svelte';
import type { NotificationKind } from '$lib/notifications/types';
import { PLUGINS_CATEGORY_ID } from './settings-bridge';

/** Which gate a plugin fell into — drives which notification it feeds. */
export type GatedReason = 'new' | 'changed';

/** A plugin the gate disabled, for the notification body. */
export interface GatedPlugin {
  id: string;
  name: string;
  reason: GatedReason;
}

interface CategoryConfig {
  id: string;
  kind: NotificationKind;
  titleKey: keyof I18nBundle['ui'];
  messageKey: keyof I18nBundle['ui'];
}

// Kept as the original kind/id for continuity (existing notifications refresh).
const CHANGED: CategoryConfig = {
  id: 'plugin-gated',
  kind: 'plugin-gated',
  titleKey: 'notifications.plugins.gated.title',
  messageKey: 'notifications.plugins.gated.message'
};
const NEW: CategoryConfig = {
  id: 'plugin-new',
  kind: 'plugin-new',
  titleKey: 'notifications.plugins.new.title',
  messageKey: 'notifications.plugins.new.message'
};

/** Upsert (or clear) one category's notification from its gated sublist. */
function report(list: GatedPlugin[], cfg: CategoryConfig): void {
  if (list.length === 0) {
    clearNotificationsByKind(cfg.kind);
    return;
  }
  const names = list.map((g) => g.name).join(', ');
  upsertNotification({
    id: cfg.id,
    kind: cfg.kind,
    widgetType: 'generic',
    createdAt: Date.now(),
    data: {
      title: tUi(cfg.titleKey),
      message: tUi(cfg.messageKey).replace('{plugins}', names)
    },
    onOpen: () => openSettings(PLUGINS_CATEGORY_ID)
  });
}

/**
 * Report (or clear) the plugin-gate notifications. Idempotent: pass the current
 * gated set on each discovery. Splits the set by `reason` so a newly-installed
 * plugin and a previously-approved-but-changed one get their own message; an
 * empty subset clears that category's notification.
 */
export function reportGatedPlugins(gated: GatedPlugin[]): void {
  report(
    gated.filter((g) => g.reason === 'changed'),
    CHANGED
  );
  report(
    gated.filter((g) => g.reason === 'new'),
    NEW
  );
}
