<script lang="ts">
  import { onDestroy, onMount } from 'svelte';

  let MetadataPanel = $state<any | null>(null);
  let alive = true;

  onMount(() => {
    void import('$lib/components/MetadataPanel.svelte').then((mod) => {
      if (alive) MetadataPanel = mod.default;
    });
  });

  onDestroy(() => {
    alive = false;
    MetadataPanel = null;
  });
</script>

{#if MetadataPanel}
  <MetadataPanel />
{/if}
