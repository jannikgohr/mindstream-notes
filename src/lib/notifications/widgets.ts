import type { NotificationWidgetComponent } from './types';
import GenericNotificationWidget from './GenericNotificationWidget.svelte';
import UpdateNotificationWidget from './UpdateNotificationWidget.svelte';

export const FALLBACK_NOTIFICATION_WIDGET =
  GenericNotificationWidget as unknown as NotificationWidgetComponent;

export const NOTIFICATION_WIDGETS: Record<string, NotificationWidgetComponent> =
  {
    generic:
      GenericNotificationWidget as unknown as NotificationWidgetComponent,
    update: UpdateNotificationWidget as unknown as NotificationWidgetComponent
  };
