<script lang="ts">
  import { onMount } from 'svelte';
  import {
    PanelLeft,
    PanelRight,
    Minus,
    Square,
    Copy,
    X
  } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import { Separator } from '$lib/components/ui/separator';
  import ThemeToggle from './ThemeToggle.svelte';
  import {
    ui,
    toggleLeftSidebar,
    toggleRightSidebar
  } from '$lib/state.svelte';

  /** Lazy-import the Tauri window API so the SPA still loads in a plain browser. */
  type WindowApi = {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    onResized?: (cb: () => void) => Promise<() => void>;
  };

  let appWindow = $state<WindowApi | null>(null);
  let isMaximized = $state(false);

  onMount(async () => {
    if (typeof window === 'undefined') return;
    if (!('__TAURI_INTERNALS__' in window)) return;
    try {
      const mod = await import('@tauri-apps/api/window');
      const w = mod.getCurrentWindow();
      appWindow = {
        minimize: () => w.minimize(),
        toggleMaximize: () => w.toggleMaximize(),
        close: () => w.close(),
        isMaximized: () => w.isMaximized()
      };
      isMaximized = await w.isMaximized();
      const unlisten = await w.onResized(async () => {
        isMaximized = await w.isMaximized();
      });
      return () => unlisten();
    } catch (err) {
      console.warn('[TopBar] Tauri window API unavailable', err);
    }
  });
</script>

<header
  data-tauri-drag-region
  class="flex h-10 shrink-0 select-none items-center gap-1 border-b border-border bg-card px-2"
>
  <!-- Left controls: sidebar toggles + brand -->
  <Button
    variant="ghost"
    size="icon"
    onclick={toggleLeftSidebar}
    title={ui.leftSidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
    aria-label="Toggle left sidebar"
  >
    <PanelLeft class="size-4" />
  </Button>
  <Separator orientation="vertical" class="mx-1 h-5" />
  <span data-tauri-drag-region class="text-xs font-medium text-muted-foreground">
    Notes
  </span>

  <!-- Spacer that also acts as a drag region -->
  <div data-tauri-drag-region class="flex-1"></div>

  <!-- Right controls -->
  <ThemeToggle />
  <Button
    variant="ghost"
    size="icon"
    onclick={toggleRightSidebar}
    title={ui.rightSidebarOpen ? 'Hide metadata' : 'Show metadata'}
    aria-label="Toggle right sidebar"
  >
    <PanelRight class="size-4" />
  </Button>

  {#if appWindow}
    <Separator orientation="vertical" class="mx-1 h-5" />
    <Button
      variant="ghost"
      size="icon"
      onclick={() => appWindow?.minimize()}
      title="Minimize"
      aria-label="Minimize"
    >
      <Minus class="size-4" />
    </Button>
    <Button
      variant="ghost"
      size="icon"
      onclick={() => appWindow?.toggleMaximize()}
      title={isMaximized ? 'Restore' : 'Maximize'}
      aria-label={isMaximized ? 'Restore' : 'Maximize'}
    >
      {#if isMaximized}
        <Copy class="size-4 rotate-180" />
      {:else}
        <Square class="size-4" />
      {/if}
    </Button>
    <Button
      variant="ghost"
      size="icon"
      class="hover:bg-destructive hover:text-destructive-foreground"
      onclick={() => appWindow?.close()}
      title="Close"
      aria-label="Close"
    >
      <X class="size-4" />
    </Button>
  {/if}
</header>
