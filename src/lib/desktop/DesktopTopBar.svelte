<script lang="ts">
  import { onMount } from 'svelte';
  import {
    PanelRight,
    Search as SearchIcon,
    Settings as SettingsIcon,
    SquareChevronRight
  } from '@jis3r/icons';
  import CuedIcon from '$lib/components/icons/CuedIcon.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Separator } from '$lib/components/ui/separator';
  import ThemeToggle from '$lib/components/ThemeToggle.svelte';
  import VaultSwitcher from '$lib/components/VaultSwitcher.svelte';
  import WindowControls from '$lib/components/WindowControls.svelte';
  import NotificationCenter from '$lib/notifications/NotificationCenter.svelte';
  import { ui, toggleLeftSidebar, toggleRightSidebar } from '$lib/state.svelte';
  import { openSettings } from '$lib/settings/store.svelte';
  import { openSearch } from '$lib/search/store.svelte';
  import { openCommandPalette } from '$lib/command-palette/store.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import {
    initWindowChrome,
    windowChrome
  } from '$lib/window/decorations.svelte';

  onMount(() => {
    initWindowChrome();
  });
</script>

{#if windowChrome.customDecorations}
  <header
    data-tauri-drag-region
    class="flex h-10 shrink-0 select-none items-center gap-1 border-b border-border bg-surface-0 px-2"
  >
    {@render TopBarContent(true)}
  </header>
{:else}
  <header
    class="flex h-10 shrink-0 select-none items-center gap-1 border-b border-border bg-surface-0 px-2"
  >
    {@render TopBarContent(false)}
  </header>
{/if}

{#snippet TopBarContent(customDecorations = false)}
  <Button
    variant="ghost"
    size="icon"
    onclick={toggleLeftSidebar}
    title={ui.leftSidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
    aria-label={tUi('topBar.toggleLeftSidebar')}
  >
    <!--
      One glyph for both rails: the left button mirrors `panel-right`
      rather than pulling in a second icon, so the two toggles animate
      identically and the divider always nudges towards its own edge.
      The nudge fires on the toggle, never on hover.
    -->
    <CuedIcon
      icon={PanelRight}
      cue={ui.leftSidebarOpen}
      duration={300}
      class="-scale-x-100"
    />
  </Button>
  <Separator orientation="vertical" class="mx-1 h-5" />
  {#if customDecorations}
    <span data-tauri-drag-region class="text-xs font-medium text-foreground">
      Mindstream Notes
    </span>

    <Separator orientation="vertical" class="mx-1 h-5" />
  {/if}
  <VaultSwitcher />

  {#if customDecorations}
    <div data-tauri-drag-region class="flex-1"></div>
  {:else}
    <div class="flex-1"></div>
  {/if}

  <Button
    variant="ghost"
    size="icon"
    onclick={openSearch}
    title={tUi('search.open')}
    aria-label={tUi('search.open')}
  >
    <CuedIcon icon={SearchIcon} size={16} />
  </Button>
  <Button
    variant="ghost"
    size="icon"
    onclick={openCommandPalette}
    title={tUi('commandPalette.open')}
    aria-label={tUi('commandPalette.open')}
  >
    <CuedIcon icon={SquareChevronRight} size={16} />
  </Button>
  <NotificationCenter />
  <Button
    variant="ghost"
    size="icon"
    onclick={() => openSettings()}
    title={tUi('topBar.settings')}
    aria-label={tUi('topBar.openSettings')}
  >
    <CuedIcon icon={SettingsIcon} size={16} />
  </Button>
  <ThemeToggle />
  <Button
    variant="ghost"
    size="icon"
    onclick={toggleRightSidebar}
    title={ui.rightSidebarOpen ? tUi('sidebar.hide') : tUi('sidebar.show')}
    aria-label={ui.rightSidebarOpen ? tUi('sidebar.hide') : tUi('sidebar.show')}
  >
    <CuedIcon icon={PanelRight} cue={ui.rightSidebarOpen} duration={300} />
  </Button>

  {#if customDecorations}
    <Separator orientation="vertical" class="mx-1 h-5" />
    <WindowControls />
  {/if}
{/snippet}
