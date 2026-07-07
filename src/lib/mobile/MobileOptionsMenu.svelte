<script lang="ts">
  /**
   * Unified mobile options control: an avatar button (with an unread
   * notification indicator) sitting right of the search bar, opening a
   * dropdown with Settings / Notifications / Vaults.
   *
   * Nav-stack ownership: the whole subsystem — the popover plus whichever
   * surface it reveals (the global settings dialog, the notification
   * centre, the vault switcher) — holds exactly ONE history entry while
   * anything is open (see `anyOpen` + the effect below). That keeps the
   * Android system back button race-free: one press collapses the open
   * surface (or the popover), a second returns to the note list. Picking
   * a menu item is a same-level swap, not a new history level, so it
   * never stacks entries or double-pushes `pushState`.
   *
   * Settings reuses the existing global dialog (openSettings /
   * settingsDialog, rendered by LazyMobileSettingsDialog); the other two
   * surfaces are controlled children hosted here.
   */
  import { onMount } from 'svelte';
  import { Bell, CircleUserRound, Settings, Vault } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { notificationState } from '$lib/notifications/store.svelte';
  import {
    closeSettings,
    openSettings,
    settingsDialog
  } from '$lib/settings/store.svelte';
  import { closeNavOverlay, openNavOverlay } from './state.svelte';
  import MobileNotificationCenter from './MobileNotificationCenter.svelte';
  import MobileVaultSwitcher from './MobileVaultSwitcher.svelte';

  type Surface = 'notifications' | 'vaults';

  let menuOpen = $state(false);
  let surface = $state<Surface | null>(null);
  let root = $state<HTMLDivElement | null>(null);

  const NAV_ID = 'mobile-options';

  const notificationCount = $derived(notificationState.items.length);
  const countLabel = $derived(
    notificationCount > 99 ? '99+' : String(notificationCount)
  );

  // One nav entry backs the entire menu subsystem: the popover, both
  // hosted surfaces, and the global settings dialog. `navHeld` is a
  // non-reactive mirror so the effect acquires / releases the entry
  // exactly once per open↔closed transition.
  const anyOpen = $derived(menuOpen || surface !== null || settingsDialog.open);
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

  /**
   * The nav-stack back handler: collapse every level the subsystem owns.
   * Runs when the Android back button pops our history entry.
   */
  function dismissAll() {
    menuOpen = false;
    surface = null;
    if (settingsDialog.open) closeSettings();
  }

  function toggleMenu() {
    menuOpen = !menuOpen;
  }

  function pickSettings() {
    menuOpen = false;
    surface = null;
    openSettings();
  }

  function pickNotifications() {
    menuOpen = false;
    surface = 'notifications';
  }

  function pickVaults() {
    menuOpen = false;
    surface = 'vaults';
  }

  function closeSurface() {
    surface = null;
  }

  // Outside-pointerdown + Escape close the popover. The surfaces are
  // bits-ui dialogs that own their own dismissal, so this only guards
  // the lightweight dropdown.
  function onDocPointerDown(event: PointerEvent) {
    if (!menuOpen || !root) return;
    if (event.target instanceof Node && !root.contains(event.target)) {
      menuOpen = false;
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && menuOpen) menuOpen = false;
  }

  onMount(() => {
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onKeydown);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('keydown', onKeydown);
    };
  });
</script>

<div bind:this={root} class="relative shrink-0">
  <Button
    variant="ghost"
    onclick={toggleMenu}
    title={tUi('options.open')}
    aria-label={tUi('options.open')}
    aria-expanded={menuOpen}
    class="relative size-12 shrink-0 rounded-full border border-input p-0 [&_svg]:size-8"
  >
    <CircleUserRound strokeWidth={1} />
    {#if notificationCount > 0}
      <span
        class="absolute right-1 top-1 min-w-4 rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground"
      >
        {countLabel}
      </span>
    {/if}
  </Button>

  {#if menuOpen}
    <div
      class="absolute right-0 top-[calc(100%+0.375rem)] z-300 w-56 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
      role="menu"
    >
      <button
        type="button"
        role="menuitem"
        class="flex w-full items-center gap-3 px-3 py-3 text-left text-sm hover:bg-accent hover:text-accent-foreground"
        onclick={pickSettings}
      >
        <Settings class="size-5 shrink-0 text-muted-foreground" />
        <span>{tUi('options.settings')}</span>
      </button>

      <button
        type="button"
        role="menuitem"
        class="flex w-full items-center gap-3 px-3 py-3 text-left text-sm hover:bg-accent hover:text-accent-foreground"
        onclick={pickNotifications}
      >
        <Bell class="size-5 shrink-0 text-muted-foreground" />
        <span class="flex-1">{tUi('options.notifications')}</span>
        {#if notificationCount > 0}
          <span
            class="min-w-5 rounded-full bg-primary px-1.5 text-center text-xs font-semibold leading-5 text-primary-foreground"
          >
            {countLabel}
          </span>
        {/if}
      </button>

      <button
        type="button"
        role="menuitem"
        class="flex w-full items-center gap-3 px-3 py-3 text-left text-sm hover:bg-accent hover:text-accent-foreground"
        onclick={pickVaults}
      >
        <Vault class="size-5 shrink-0 text-muted-foreground" />
        <span>{tUi('options.vaults')}</span>
      </button>
    </div>
  {/if}
</div>

<MobileNotificationCenter
  open={surface === 'notifications'}
  onClose={closeSurface}
/>
<MobileVaultSwitcher open={surface === 'vaults'} onClose={closeSurface} />
