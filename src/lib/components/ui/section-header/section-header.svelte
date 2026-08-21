<script lang="ts">
  import { cn } from '$lib/utils';
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  /**
   * The small uppercase label that titles a region of a panel — METADATA,
   * ORGANIZATION, DATES, TAGS, HISTORY, and so on.
   *
   * Before this existed the same label was spelled four different ways across
   * NoteSidebar, NoteLinksSection, NoteHistorySection and TagsSection (which
   * used `text-xs` where the others used `text-[11px]`), which is a large part
   * of why the two sidebars read as unrelated designs. One component, one
   * spelling.
   *
   * `as` sets the heading level so the document outline stays correct — the
   * visual treatment is identical at every level and must not be used to imply
   * hierarchy.
   */
  interface Props extends HTMLAttributes<HTMLHeadingElement> {
    as?: 'h2' | 'h3' | 'h4' | 'h5';
    class?: string;
    children: Snippet;
  }

  let { as = 'h3', class: className, children, ...rest }: Props = $props();
</script>

<svelte:element
  this={as}
  class={cn(
    'flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground',
    className
  )}
  {...rest}
>
  {@render children()}
</svelte:element>
