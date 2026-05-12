<script lang="ts">
  /**
   * Mobile shell's top bar.
   *
   * Three slots, kept deliberately sparse compared to the desktop bar:
   *   left  — a back arrow when the editor is foreground (sidebar closed),
   *           otherwise empty. No app-name label.
   *   centre — empty drag region.
   *   right — Info (metadata overlay toggle, editor only), Theme, Settings.
   *
   * The bar sits inside the `safe-top` padded shell, so it never paints
   * under the Android status bar.
   */
  import {
    ArrowLeft,
    Info,
    Settings as SettingsIcon
  } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import ThemeToggle from '$lib/components/ThemeToggle.svelte';
  import { ui, toggleLeftSidebar, toggleRightSidebar } from '$lib/state.svelte';
  import { openSettings } from '$lib/settings/store.svelte';

  // Mobile treats `leftSidebarOpen` as the "tree screen is foreground"
  // signal — when true, the file explorer covers the screen and there is
  // no editor below to navigate back from.
  const editorForeground = $derived(!ui.leftSidebarOpen);
</script>

<header
  class="flex h-12 shrink-0 select-none items-center gap-1 border-b border-border bg-card px-2"
>
  {#if editorForeground}
    <Button
      variant="ghost"
      size="icon"
      onclick={toggleLeftSidebar}
      title="Back to notes"
      aria-label="Back to notes"
    >
      <ArrowLeft class="size-5" />
    </Button>
  {:else}
    <!-- Reserve the leading icon's footprint so the right-side cluster
         stays anchored at the same x as the editor-screen variant. -->
    <div class="size-9 shrink-0"></div>
  {/if}

  <div class="flex-1"></div>

  {#if editorForeground}
    <Button
      variant="ghost"
      size="icon"
      onclick={toggleRightSidebar}
      title={ui.rightSidebarOpen ? 'Hide note info' : 'Show note info'}
      aria-label="Toggle note info"
    >
      <Info class="size-5" />
    </Button>
  {/if}
  <ThemeToggle />
  <Button
    variant="ghost"
    size="icon"
    onclick={openSettings}
    title="Settings"
    aria-label="Open settings"
  >
    <SettingsIcon class="size-5" />
  </Button>
</header>
