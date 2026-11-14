<script lang="ts">
  let { label = 'Loaded' } = $props();
  import { onMount } from 'svelte';
  onMount(() => {
    document.dispatchEvent(new Event('lazy-mount'));
    return () => document.dispatchEvent(new Event('lazy-unmount'));
  });
</script>

{#if label}
  <span data-testid="lazy-child">{label}</span>
{/if}
