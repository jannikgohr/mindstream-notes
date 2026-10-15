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

  // Which widget to load depends on the kind of notice alone. Reading it
  // through a derived value keeps the effect below from running again when
  // the notice is replaced by a newer copy of itself, which a rescan of the
  // invitations does every time. Without it the widget was taken down and
  // put up again on each rescan: a button could be replaced under a click,
  // and an error the widget had just shown was gone.
  const widgetType = $derived(notification.widgetType);

  $effect(() => {
    const type = widgetType;
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
