<script lang="ts">
  /**
   * A vault's letter tile. The name is always shown beside it, so the tile
   * is decoration for screen readers. `vaultIds` is the whole vault list in
   * creation order, so tiles in one list never share a colour.
   */
  import { cn } from '$lib/utils';
  import {
    vaultTileColor,
    vaultTileLetter,
    vaultTileSlots
  } from '$lib/vaults/tile';

  let {
    id,
    name,
    vaultIds,
    class: className = ''
  }: {
    id: string;
    name: string;
    vaultIds: readonly string[];
    class?: string;
  } = $props();

  const slot = $derived(vaultTileSlots(vaultIds).get(id) ?? vaultTileColor(id));
</script>

<span
  aria-hidden="true"
  class={cn(
    'grid size-4.5 shrink-0 place-items-center rounded-[5px] text-[10.5px] font-bold leading-none',
    className
  )}
  style:background-color={`var(--vault-tile-${slot})`}
  style:color="var(--vault-tile-foreground)">{vaultTileLetter(name)}</span
>
