import type { NotificationWidgetComponent } from './types';
import { lazyComponent } from '$lib/components/lazy-component';

export type NotificationWidgetLoader =
  () => Promise<NotificationWidgetComponent>;

export const FALLBACK_NOTIFICATION_WIDGET_LOADER: NotificationWidgetLoader =
  lazyComponent(() => import('./GenericNotificationWidget.svelte'));

export const NOTIFICATION_WIDGET_LOADERS: Record<
  string,
  NotificationWidgetLoader
> = {
  generic: FALLBACK_NOTIFICATION_WIDGET_LOADER,
  update: lazyComponent(() => import('./UpdateNotificationWidget.svelte')),
  'share-invite': lazyComponent(
    () => import('./ShareInviteNotificationWidget.svelte')
  )
};
