<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { Loader2 } from '@lucide/svelte';
  import { Bell } from '@jis3r/icons';
  import CuedIcon from '$lib/components/icons/CuedIcon.svelte';
  import { Button } from '$lib/components/ui/button';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { prefersReducedMotion } from '$lib/reduce-motion.svelte';
  import {
    notificationState,
    scanForCollectionInviteNotifications,
    scanForUpdateNotifications
  } from './store.svelte';
  import LazyNotificationWidget from './LazyNotificationWidget.svelte';

  let open = $state(false);
  let root: HTMLDivElement | null = $state(null);

  /**
   * The bell rings when something new arrives — nothing else. It keys
   * off ids that weren't in the list before rather than off the count
   * (which also moves on dismissal) and rather than off hover (which
   * says nothing about notifications at all).
   *
   * The ring is latched here instead of being handed to `CuedIcon` as
   * a cue because an update scan swaps the bell out for a spinner:
   * the notification lands while the spinner is up, so the bell has to
   * mount mid-ring and pick the animation up from `ringing`.
   *
   * `seen` and `ringHandle` are plain `let`s — effect bookkeeping, not
   * state; making them reactive would re-run the effect on every write
   * and cancel the ring timer before it fires.
   */
  let ringing = $state(false);
  let seen: Set<string> | undefined;
  let ringHandle: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    const ids = notificationState.items.map((item) => item.id);
    if (seen === undefined) {
      // First run: whatever is already in the list counts as seen, so
      // notifications restored at startup don't ring.
      seen = new Set(ids);
      return;
    }
    const previous = seen;
    seen = new Set(ids);
    if (!ids.some((id) => !previous.has(id))) return;
    if (prefersReducedMotion()) return;
    clearTimeout(ringHandle);
    ringing = true;
    // Matches the jis3r Bell's 1.1 s keyframes.
    ringHandle = setTimeout(() => {
      ringing = false;
    }, 1100);
  });

  onDestroy(() => clearTimeout(ringHandle));

  const notificationCount = $derived(notificationState.items.length);
  const countLabel = $derived(
    notificationCount > 99 ? '99+' : notificationCount
  );

  function toggle() {
    open = !open;
  }

  function close() {
    open = false;
  }

  function handleDocumentPointerDown(event: PointerEvent) {
    if (!open || !root) return;
    if (event.target instanceof Node && !root.contains(event.target)) {
      open = false;
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') open = false;
  }

  onMount(() => {
    void scanForUpdateNotifications();
    void scanForCollectionInviteNotifications();
    document.addEventListener('pointerdown', handleDocumentPointerDown, true);
    document.addEventListener('keydown', handleKeydown);
    return () => {
      document.removeEventListener(
        'pointerdown',
        handleDocumentPointerDown,
        true
      );
      document.removeEventListener('keydown', handleKeydown);
    };
  });
</script>

<div bind:this={root} class="relative">
  <Button
    class="relative"
    variant="ghost"
    size="icon"
    onclick={toggle}
    title={tUi('notifications.open')}
    aria-label={tUi('notifications.open')}
    aria-expanded={open}
  >
    {#if notificationState.updateScanPending}
      <Loader2 class="size-4 animate-spin" />
    {:else}
      <CuedIcon icon={Bell} animate={ringing} />
    {/if}
    {#if notificationCount > 0}
      <span
        class="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground"
      >
        {countLabel}
      </span>
    {/if}
  </Button>

  {#if open}
    <div
      class="absolute right-0 top-[calc(100%+0.375rem)] z-300 w-80 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
    >
      <div class="border-b border-border px-3 py-2">
        <p class="text-sm font-semibold">{tUi('notifications.title')}</p>
      </div>

      <div class="max-h-96 overflow-y-auto p-1">
        {#if notificationState.items.length === 0}
          <p class="px-3 py-5 text-center text-xs text-muted-foreground">
            {tUi('notifications.empty')}
          </p>
        {:else}
          {#each notificationState.items as notification (notification.id)}
            <LazyNotificationWidget {notification} onClose={close} />
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</div>
