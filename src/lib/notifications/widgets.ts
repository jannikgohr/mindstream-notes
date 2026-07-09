import type { NotificationWidgetComponent } from './types';

export type NotificationWidgetLoader =
  () => Promise<NotificationWidgetComponent>;

export const FALLBACK_NOTIFICATION_WIDGET_LOADER: NotificationWidgetLoader =
  () =>
    import('./GenericNotificationWidget.svelte').then(
      (mod) => mod.default as unknown as NotificationWidgetComponent
    );

export const NOTIFICATION_WIDGET_LOADERS: Record<
  string,
  NotificationWidgetLoader
> = {
  generic: FALLBACK_NOTIFICATION_WIDGET_LOADER,
  update: () =>
    import('./UpdateNotificationWidget.svelte').then(
      (mod) => mod.default as unknown as NotificationWidgetComponent
    ),
  'collaboration-invite': () =>
    import('./CollaborationInviteNotificationWidget.svelte').then(
      (mod) => mod.default as unknown as NotificationWidgetComponent
    ),
  'share-bundle': () =>
    import('./ShareBundleNotificationWidget.svelte').then(
      (mod) => mod.default as unknown as NotificationWidgetComponent
    )
};
