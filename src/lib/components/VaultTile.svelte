<script lang="ts">
  /**
   * A vault's letter tile on its named colour. The name is always shown
   * beside it, so the tile is decoration for screen readers.
   */
  import { cn } from '$lib/utils';
  import { vaultColor, vaultTileLetter } from '$lib/vaults/tile';

  let {
    id,
    name,
    color,
    class: className = ''
  }: {
    id: string;
    name: string;
    color?: string | null;
    class?: string;
  } = $props();
</script>

<span
  aria-hidden="true"
  class={cn(
    'grid size-4.5 shrink-0 place-items-center rounded-[5px] text-[10.5px] font-bold leading-none',
    className
  )}
  style:background-color={`var(--named-${vaultColor({ id, color })})`}
  style:color="var(--named-foreground)">{vaultTileLetter(name)}</span
>
