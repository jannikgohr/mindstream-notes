<script lang="ts">
  /**
   * Thin vertical divider between logical groups of toolbar buttons. Replaces
   * the per-toolbar bordered "segment box" look with one shared hairline so
   * grouping reads consistently across editors.
   */
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils';

  let { class: className, ...rest }: HTMLAttributes<HTMLDivElement> = $props();
</script>

<div
  role="separator"
  aria-orientation="vertical"
  class={cn('mx-1 h-5 w-px shrink-0 bg-border', className)}
  {...rest}
></div>
