<script lang="ts">
  import { onMount } from 'svelte';
  // A copy of src-tauri/icons/64x64.png: the dev server cannot serve src-tauri.
  import appIcon from './app-icon.png';
  import {
    PanelRight,
    Search as SearchIcon,
    Settings as SettingsIcon,
    SquareChevronRight
  } from '@jis3r/icons';
  import CuedIcon from '$lib/components/icons/CuedIcon.svelte';
  import { Button } from '$lib/components/ui/button';
  import ThemeToggle from '$lib/components/ThemeToggle.svelte';
  import VaultSwitcher from '$lib/components/VaultSwitcher.svelte';
  import WindowControls from '$lib/components/WindowControls.svelte';
  import NotificationCenter from '$lib/notifications/NotificationCenter.svelte';
  import {
    ui,
    toggleLeftSidebar,
    toggleRightSidebar,
    rightSidebarShown
  } from '$lib/state.svelte';
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
    class="desktop-topbar grid h-13 shrink-0 select-none grid-cols-[minmax(max-content,1fr)_auto_minmax(max-content,1fr)] items-center border-b border-border bg-surface-0"
  >
    {@render TopBarContent(true)}
  </header>
{:else}
  <header
    class="desktop-topbar grid h-13 shrink-0 select-none grid-cols-[minmax(max-content,1fr)_auto_minmax(max-content,1fr)] items-center border-b border-border bg-surface-0"
  >
    {@render TopBarContent(false)}
  </header>
{/if}

{#snippet TopBarContent(customDecorations = false)}
  <!-- Three cells: brand and sidebar toggle, search, actions. The outer
       columns share the spare width, so search sits on the window's centre
       and stays put when the sidebar opens, closes or changes width. A side
       that outgrows its half pushes it over instead of overlapping it.
       "deep" makes every empty pixel of the bar move the window; buttons
       still block the drag. -->
  <div
    data-tauri-drag-region={customDecorations ? 'deep' : undefined}
    class="flex h-full min-w-0 items-center"
  >
    <!-- Sized to the sidebar, with the toggle beside the title so collapsing
         the sidebar does not move it out from under the pointer. Collapsed,
         the vault switcher follows the toggle at about the spacing between
         the title and the toggle. -->
    <div
      data-tauri-drag-region={customDecorations ? 'deep' : undefined}
      class="flex h-full shrink-0 items-center gap-2.5 overflow-hidden pl-5 {ui.leftSidebarOpen
        ? 'pr-5'
        : 'pr-1'}"
      style:width={ui.leftSidebarOpen ? `${ui.leftSidebarWidth}px` : undefined}
    >
      <!-- The icon is a light tile: a hairline ring keeps it a tile on the light
           chrome too, instead of a bare glyph there and a white block in dark. -->
      <img
        src={appIcon}
        alt=""
        draggable="false"
        class="size-6 shrink-0 rounded-md ring-1 ring-border"
      />
      <span class="truncate text-base font-semibold tracking-tight"
        >mindstream<span class="text-accent-brand">.</span></span
      >
      <Button
        variant="ghost"
        size="icon"
        onclick={toggleLeftSidebar}
        title={ui.leftSidebarOpen
          ? tUi('topBar.hideLeftSidebar')
          : tUi('topBar.showLeftSidebar')}
        aria-label={tUi('topBar.toggleLeftSidebar')}
        aria-expanded={ui.leftSidebarOpen}
        class="shrink-0 text-muted-foreground"
      >
        <CuedIcon
          icon={PanelRight}
          cue={ui.leftSidebarOpen}
          duration={300}
          class="-scale-x-100"
        />
      </Button>
    </div>
    <!-- Popovers open inside the bar; a press on their padding must not
         start a window drag. -->
    {#if !ui.leftSidebarOpen}<div
        data-tauri-drag-region="false"
        class="min-w-0 max-w-60 shrink-0 pr-3"
      >
        <VaultSwitcher />
      </div>{/if}
  </div>
  <Button
    variant="outline"
    size="sm"
    onclick={openSearch}
    title={tUi('search.open')}
    aria-label={tUi('search.open')}
    class="desktop-search h-8 justify-start gap-2 border-border bg-surface-1 text-xs font-normal text-muted-foreground shadow-none"
  >
    <CuedIcon icon={SearchIcon} size={14} />
    <span class="hidden sm:inline">{tUi('search.open')}</span>
  </Button>
  <div
    data-tauri-drag-region={customDecorations ? 'deep' : undefined}
    class="flex h-full min-w-0 items-center justify-end gap-2 pl-3 pr-3"
  >
    <Button
      variant="ghost"
      size="icon"
      onclick={openCommandPalette}
      title={tUi('commandPalette.open')}
      aria-label={tUi('commandPalette.open')}
    >
      <CuedIcon icon={SquareChevronRight} size={16} />
    </Button>
    <div data-tauri-drag-region="false" class="contents">
      <NotificationCenter />
    </div>
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
      disabled={!ui.activeNoteId}
      title={ui.rightSidebarOpen ? tUi('sidebar.hide') : tUi('sidebar.show')}
      aria-label={ui.rightSidebarOpen
        ? tUi('sidebar.hide')
        : tUi('sidebar.show')}
      aria-expanded={rightSidebarShown()}
    >
      <CuedIcon icon={PanelRight} cue={rightSidebarShown()} duration={300} />
    </Button>

    {#if customDecorations}
      <WindowControls separated />
    {/if}
  </div>
{/snippet}
