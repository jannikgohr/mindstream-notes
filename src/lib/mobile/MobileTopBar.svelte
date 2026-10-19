<script lang="ts">
  /**
   * Home-screen top bar, the desktop header's layout on a phone: the vault
   * tile (switches vaults), the search pill, then notifications and settings.
   * The editor screen renders its own header (see MobileEditor.svelte).
   *
   * Search opens the global SearchDialog (mounted at the root layout) so
   * desktop and mobile share scoring, snippets and match highlighting.
   *
   * Nav-stack ownership: everything this bar opens — the notification
   * centre, the vault switcher and the global settings dialog — holds
   * exactly ONE history entry while any of it is open (see `anyOpen` and
   * the effect below). The Android back button then closes the open surface
   * with one press and a second returns to the note list; switching from one
   * surface to another is a same-level swap, never a new history entry.
   */
  import { Bell, Search, Settings } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import VaultTile from '$lib/components/VaultTile.svelte';
  import { currentProfile } from '$lib/stores/profiles.svelte';
  import { notificationState } from '$lib/notifications/store.svelte';
  import { openSearch } from '$lib/search/store.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import {
    closeSettings,
    openSettings,
    settingsDialog
  } from '$lib/settings/store.svelte';
  import { closeNavOverlay, openNavOverlay } from './state.svelte';
  import MobileNotificationCenter from './MobileNotificationCenter.svelte';
  import MobileVaultSwitcher from './MobileVaultSwitcher.svelte';

  type Surface = 'notifications' | 'vaults';

  let surface = $state<Surface | null>(null);

  const NAV_ID = 'mobile-top-bar';
  const vault = $derived(currentProfile());
  const notificationCount = $derived(notificationState.items.length);
  const countLabel = $derived(
    notificationCount > 99 ? '99+' : String(notificationCount)
  );

  // `navHeld` is a non-reactive mirror so the effect acquires and releases
  // the history entry exactly once per open/closed transition.
  const anyOpen = $derived(surface !== null || settingsDialog.open);
  let navHeld = false;
  $effect(() => {
    if (anyOpen && !navHeld) {
      navHeld = true;
      openNavOverlay(NAV_ID, dismissAll);
    } else if (!anyOpen && navHeld) {
      navHeld = false;
      closeNavOverlay(NAV_ID);
    }
  });

  /** The back handler: close everything this bar owns. */
  function dismissAll() {
    surface = null;
    if (settingsDialog.open) closeSettings();
  }

  function show(next: Surface) {
    if (settingsDialog.open) closeSettings();
    surface = next;
  }

  function showSettings() {
    surface = null;
    openSettings();
  }
</script>

<header
  class="flex shrink-0 select-none items-center gap-1.5 border-b border-border bg-surface-0 px-3 py-2"
>
  <button
    type="button"
    onclick={() => show('vaults')}
    aria-label={tUi('vault.switch')}
    title={vault?.name ?? tUi('vault.switch')}
    class="mr-0.5 grid size-10 shrink-0 place-items-center rounded-lg hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    <VaultTile
      id={vault?.id ?? ''}
      name={vault?.name ?? ''}
      color={vault?.color}
      class="size-8 rounded-lg text-sm"
    />
  </button>

  <button
    type="button"
    onclick={openSearch}
    aria-label={tUi('search.notes.label')}
    class="flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-full border border-border bg-surface-1 px-3.5 text-left text-sm text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    <Search class="size-4 shrink-0" />
    <span class="truncate">{tUi('search.notes.placeholder')}</span>
  </button>

  <Button
    variant="ghost"
    size="icon"
    onclick={() => show('notifications')}
    title={tUi('options.notifications')}
    aria-label={tUi('options.notifications')}
    class="relative size-10 shrink-0 text-muted-foreground [&_svg]:size-5"
  >
    <Bell />
    {#if notificationCount > 0}
      <span
        class="absolute right-1 top-1 min-w-4 rounded-full bg-accent-brand px-1 text-[10px] font-semibold leading-4 text-accent-brand-foreground"
      >
        {countLabel}
      </span>
    {/if}
  </Button>
  <Button
    variant="ghost"
    size="icon"
    onclick={showSettings}
    title={tUi('options.settings')}
    aria-label={tUi('options.settings')}
    class="size-10 shrink-0 text-muted-foreground [&_svg]:size-5"
  >
    <Settings />
  </Button>
</header>

<MobileNotificationCenter
  open={surface === 'notifications'}
  onClose={() => (surface = null)}
/>
<MobileVaultSwitcher
  open={surface === 'vaults'}
  onClose={() => (surface = null)}
/>
