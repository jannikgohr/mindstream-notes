<script lang="ts">
  import { onDestroy, onMount } from 'svelte';

  let { onClose }: { onClose?: () => void } = $props();

  let NoteSidebar = $state<any | null>(null);
  let alive = true;

  onMount(() => {
    void import('$lib/components/NoteSidebar.svelte').then((mod) => {
      if (alive) NoteSidebar = mod.default;
    });
  });

  onDestroy(() => {
    alive = false;
    NoteSidebar = null;
  });
</script>

{#if NoteSidebar}
  <NoteSidebar {onClose} />
{/if}
