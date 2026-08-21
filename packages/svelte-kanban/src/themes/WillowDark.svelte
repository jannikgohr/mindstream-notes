<script lang="ts">
  import type { Snippet } from 'svelte';
  import { WillowDark } from '@svar-ui/svelte-core';
  import './willow-dark.css';
  import './wxi-icons.css';

  let { fonts = false, children }: { fonts?: boolean; children?: Snippet } =
    $props();
</script>

{#if children}
  <WillowDark {fonts}>{@render children()}</WillowDark>
{:else}
  <WillowDark {fonts} />
{/if}
