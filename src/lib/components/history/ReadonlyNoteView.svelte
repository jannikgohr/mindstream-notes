<script lang="ts">
  /**
   * Renders a markdown string as a read-only Milkdown (Crepe) document — used
   * for the "Current note" and "Note from {date}" tabs of the history modal.
   * A minimal Crepe (no collab / upload / wikilink plumbing): it only has to
   * render. `asset:` image URLs won't resolve here (no AssetBridge), so images
   * in a historical snapshot show as broken — acceptable for a preview.
   */
  import { onDestroy, onMount } from 'svelte';
  import { Crepe } from '@milkdown/crepe';

  interface Props {
    markdown: string;
  }
  let { markdown }: Props = $props();

  let host = $state<HTMLDivElement | null>(null);
  let crepe: Crepe | null = null;

  onMount(async () => {
    if (!host) return;
    const instance = new Crepe({ root: host, defaultValue: markdown });
    crepe = instance;
    try {
      await instance.create();
      instance.setReadonly(true);
    } catch (err) {
      console.error('[history] read-only render failed', err);
    }
  });

  onDestroy(() => {
    crepe?.destroy();
    crepe = null;
  });
</script>

<div bind:this={host} class="milkdown-readonly h-full overflow-y-auto"></div>
