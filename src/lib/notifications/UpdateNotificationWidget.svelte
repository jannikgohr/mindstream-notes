<script lang="ts">
  import { Download, X } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import { dismissNotification, openNotification } from './store.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import type { AppNotification, UpdateNotificationData } from './types';

  interface Props {
    notification: AppNotification<UpdateNotificationData>;
    onClose?: () => void;
  }

  let { notification, onClose }: Props = $props();

  async function handleInstall() {
    await openNotification(notification.id);
    onClose?.();
  }

  function dismiss(event: MouseEvent) {
    event.stopPropagation();
    dismissNotification(notification.id);
  }
</script>

<div class="rounded-md px-3 py-2 hover:bg-accent/60">
  <div class="flex items-start gap-2">
    <Download class="mt-0.5 size-4 shrink-0 text-primary" />
    <div class="min-w-0 flex-1">
      <p class="text-sm font-medium">{tUi('notifications.update.title')}</p>
      <p class="mt-0.5 text-xs text-muted-foreground">
        {tUi('notifications.update.message')
          .replace('{from}', notification.data.currentVersion)
          .replace('{to}', notification.data.version)}
      </p>
      <Button class="mt-2 h-7 px-2 text-xs" size="sm" onclick={handleInstall}>
        {tUi('updater.install')}
      </Button>
    </div>
    <button
      type="button"
      class="rounded-md p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title={tUi('notifications.dismiss')}
      aria-label={tUi('notifications.dismiss')}
      onclick={dismiss}
    >
      <X class="size-3.5" />
    </button>
  </div>
</div>
