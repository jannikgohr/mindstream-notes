<script lang="ts">
  /**
   * Root → … → leaf breadcrumb that collapses middle segments when it
   * doesn't fit. Mirrors the shadcn breadcrumb ellipsis convention:
   * keep the first and last segment, replace items at index 2..n-1 with
   * "…". If the collapsed form still overflows, the first and last
   * segments truncate with their own ellipses (the leaf shrinks first
   * because flex distributes shrink to whichever child has the most
   * room to give).
   *
   * Detection: a hidden absolutely-positioned span renders the full
   * breadcrumb at its natural width; we compare that to the visible
   * container's clientWidth via a ResizeObserver, so dragging the
   * sidebar resize handle re-evaluates instantly.
   */
  import { ChevronRight } from 'lucide-svelte';
  import type { Collection } from '$lib/api';

  interface Props {
    path: Collection[];
  }
  let { path }: Props = $props();

  let containerEl: HTMLDivElement | undefined = $state();
  let measureEl: HTMLSpanElement | undefined = $state();
  let collapsed = $state(false);

  function recompute() {
    if (!containerEl || !measureEl) return;
    // 1px slack to avoid sub-pixel jitter that would oscillate the state.
    collapsed = measureEl.offsetWidth > containerEl.clientWidth + 1;
  }

  $effect(() => {
    if (!containerEl) return;
    const ro = new ResizeObserver(recompute);
    ro.observe(containerEl);
    recompute();
    return () => ro.disconnect();
  });

  // Re-measure when the path itself changes (e.g. moving notes between folders).
  $effect(() => {
    void path;
    queueMicrotask(recompute);
  });
</script>

{#if path.length === 0}
  <div class="text-right text-muted-foreground">Root</div>
{:else}
  <div
    bind:this={containerEl}
    class="relative flex min-w-0 items-center overflow-hidden"
  >
    <!-- Off-flow measurement copy of the natural-width breadcrumb. Position
         doesn't affect offsetWidth, so leaving it at left-0 is fine. -->
    <span
      bind:this={measureEl}
      aria-hidden="true"
      class="invisible pointer-events-none absolute left-0 top-0 flex items-center whitespace-nowrap"
    >
      {#each path as c, i (c.id)}
        {#if i > 0}
          <ChevronRight class="mx-0.5 h-3 w-3 text-muted-foreground/60" />
        {/if}
        <span>{c.name}</span>
      {/each}
    </span>

    <!-- flex-1 + justify-end: when content fits, items right-anchor; when it
         doesn't, items still fill the cell and the truncate-able children
         shrink instead of the row clipping from the wrong side. -->
    <div
      class="flex min-w-0 flex-1 items-center justify-end whitespace-nowrap"
    >
      {#if collapsed && path.length > 2}
        <span class="min-w-0 truncate">{path[0].name}</span>
        <ChevronRight class="mx-0.5 h-3 w-3 shrink-0 text-muted-foreground/60" />
        <span class="shrink-0 text-muted-foreground">…</span>
        <ChevronRight class="mx-0.5 h-3 w-3 shrink-0 text-muted-foreground/60" />
        <span class="min-w-0 truncate">{path[path.length - 1].name}</span>
      {:else}
        {#each path as c, i (c.id)}
          {#if i > 0}
            <ChevronRight
              class="mx-0.5 h-3 w-3 shrink-0 text-muted-foreground/60"
            />
          {/if}
          <span
            class={i === path.length - 1 ? 'min-w-0 truncate' : 'shrink-0'}
            >{c.name}</span
          >
        {/each}
      {/if}
    </div>
  </div>
{/if}
