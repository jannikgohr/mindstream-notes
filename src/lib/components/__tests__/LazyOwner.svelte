<script lang="ts">
  import type { Component } from 'svelte';
  import { createLazyComponent } from '../lazy-component.svelte';
  let {
    when,
    load,
    keepMountedWhenInactive = false
  }: {
    when: () => boolean;
    load: () => Promise<{ default: Component }>;
    keepMountedWhenInactive?: boolean;
  } = $props();
  const lazy = createLazyComponent({
    when: () => when(),
    load: () => load(),
    get keepMountedWhenInactive() {
      return keepMountedWhenInactive;
    }
  });
</script>

<div data-testid="owner" data-loaded={!!lazy.component}>
  {#if lazy.component}
    <lazy.component />
  {/if}
</div>
