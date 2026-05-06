<script lang="ts">
  /**
   * Frameless-window control trio: minimize / maximize-or-restore / close.
   *
   * Talks to whatever `getCurrentWindow()` returns, so it works correctly
   * whether mounted in the main window or a spawned popout — each window
   * has its own webview and its own currentWindow handle.
   *
   * Renders nothing if Tauri's window API isn't reachable (e.g. `pnpm dev`
   * in a plain browser). That keeps the SPA usable outside the desktop
   * shell without a try/catch at every callsite.
   */
  import { onMount } from 'svelte';
  import { Copy, Minus, Square, X } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';

  type WindowApi = {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
  };

  let appWindow = $state<WindowApi | null>(null);
  let isMaximized = $state(false);
  let unlistenResize: (() => void) | null = null;

  onMount(() => {
    void setup();
    return () => {
      unlistenResize?.();
      unlistenResize = null;
    };
  });

  async function setup() {
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
      unlistenResize = await w.onResized(async () => {
        isMaximized = await w.isMaximized();
      });
    } catch (err) {
      console.warn('[WindowControls] Tauri window API unavailable', err);
    }
  }
</script>

{#if appWindow}
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
