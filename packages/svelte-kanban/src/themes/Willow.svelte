<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Willow } from '@svar-ui/svelte-core';
  import './willow.css';
  import './wxi-icons.css';

  let { fonts = false, children }: { fonts?: boolean; children?: Snippet } =
    $props();
</script>

{#if children}
  <Willow {fonts}>{@render children()}</Willow>
{:else}
  <Willow {fonts} />
{/if}
