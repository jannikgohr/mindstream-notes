<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { ModeWatcher } from 'mode-watcher';

  let { children } = $props();

  // Suppress the webview's default right-click menu in production builds.
  // We have our own context menus (file tree); the webview's default just
  // shows debug entries like "Inspect Element" / "Reload" that aren't part
  // of the product UX. Stays enabled in dev so DevTools remain reachable.
  onMount(() => {
    if (!import.meta.env.PROD) return;
    const block = (e: Event) => {
      // Custom menus call preventDefault() + stopPropagation() before this
      // listener runs, so they're already absent from the event stream.
      // Anything that bubbles up here is an unhandled right-click — kill it.
      e.preventDefault();
    };
    window.addEventListener('contextmenu', block);
    return () => window.removeEventListener('contextmenu', block);
  });
</script>

<ModeWatcher defaultMode="system" />

<div class="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
  {@render children()}
</div>
