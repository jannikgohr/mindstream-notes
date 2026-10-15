<script lang="ts">
  import { openNotification } from './store.svelte';
  import type { AppNotification } from './types';

  interface GenericData {
    title?: string;
    message?: string;
  }

  interface Props {
    notification: AppNotification<GenericData>;
    onClose?: () => void;
  }

  let { notification, onClose }: Props = $props();

  async function handleOpen() {
    await openNotification(notification.id);
    onClose?.();
  }
</script>

<button
  type="button"
  class="block w-full rounded-md px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  onclick={handleOpen}
>
  <!-- A title or message can hold a name someone else chose, a folder's or
       a server's address, and one without a space in it must not run out of
       the panel. -->
  <span class="block text-sm font-medium break-words">
    {notification.data.title ?? 'Notification'}
  </span>
  {#if notification.data.message}
    <span class="mt-0.5 block text-xs text-muted-foreground break-words">
      {notification.data.message}
    </span>
  {/if}
</button>
