<script lang="ts">
  import type { NotificationWidgetComponent, AppNotification } from './types';
  import {
    FALLBACK_NOTIFICATION_WIDGET_LOADER,
    NOTIFICATION_WIDGET_LOADERS
  } from './widgets';

  interface Props {
    notification: AppNotification;
    onClose?: () => void;
  }

  let { notification, onClose }: Props = $props();

  let Widget = $state<NotificationWidgetComponent | null>(null);
  let loadToken = 0;

  $effect(() => {
    const type = notification.widgetType;
    const loader =
      NOTIFICATION_WIDGET_LOADERS[type] ?? FALLBACK_NOTIFICATION_WIDGET_LOADER;
    Widget = null;

    const token = ++loadToken;
    void loader()
      .then((component) => {
        if (token === loadToken) Widget = component;
      })
      .catch((err) => {
        if (token === loadToken) {
          console.error('[notifications] failed to load widget', type, err);
        }
      });

    return () => {
      loadToken++;
      Widget = null;
    };
  });
</script>

{#if Widget}
  <Widget {notification} {onClose} />
{/if}
