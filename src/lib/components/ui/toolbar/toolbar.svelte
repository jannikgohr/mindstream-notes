<script lang="ts">
  /**
   * Toolbar surface — the shared chrome for every in-app editor toolbar
   * (markdown, PDF, and later ink). Promoted from EditorToolbar so the note
   * editors stop each hand-rolling their own bar styling and button metrics.
   *
   * It is purely the visual row: `flex items-center gap-0.5` with `px-1`
   * gutters. Chrome that varies by placement — the desktop `border-b
   * bg-background`, a floating pill's `rounded-full shadow`, `justify-between`
   * for split left/right groups — is the caller's job via `class`, so the same
   * primitive drops into a docked bar or a floating overlay without forking.
   */
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils';

  type Props = HTMLAttributes<HTMLDivElement> & {
    /**
     * Collapse the row's vertical padding so the bar's height equals the
     * button height (36px). Docked desktop bars set this to line up with the
     * surrounding 36px chrome; a floating pill leaves it off for breathing
     * room around the buttons.
     */
    dense?: boolean;
    /** Bind the underlying row element, e.g. to drive a ToolbarScrollbar. */
    ref?: HTMLDivElement | null;
    children: Snippet;
  };

  let {
    dense = false,
    class: className,
    ref = $bindable(null),
    children,
    ...rest
  }: Props = $props();
</script>

<div
  bind:this={ref}
  role="toolbar"
  class={cn(
    'flex items-center gap-0.5 px-1',
    dense ? 'py-0' : 'py-1',
    className
  )}
  {...rest}
>
  {@render children()}
</div>
