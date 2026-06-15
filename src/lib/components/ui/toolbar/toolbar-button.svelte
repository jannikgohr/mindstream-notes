<script lang="ts">
  /**
   * Standard toolbar button. Wraps the shadcn Button with the toolbar's fixed
   * metrics so every editor's buttons match: a 36px (`size-9`) icon target
   * with a 16px icon (the Button base forces `[&_svg]:size-4`), `ghost` until
   * `active`, then filled (`secondary`).
   *
   * Pass-through: all native button attributes (`onclick`, `disabled`,
   * `title`, `aria-*`) and `bind:ref` flow straight to the underlying button,
   * so callers keep full control of behaviour and accessibility. `aria-pressed`
   * is intentionally NOT derived from `active` — only genuine toggle buttons
   * should expose it, so callers set it explicitly.
   */
  import type { Snippet } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import type { ButtonProps } from '$lib/components/ui/button/button-variants';
  import { cn } from '$lib/utils';

  type Props = Omit<ButtonProps, 'variant' | 'size'> & {
    /** Pressed/selected → filled (`secondary`) instead of `ghost`. */
    active?: boolean;
    /**
     * Wider sizing for a trigger that holds an icon plus trailing content
     * (e.g. a chevron, or a value label like the PDF zoom control) instead of
     * a single centred icon.
     */
    wide?: boolean;
    /**
     * Suppress the default pointerdown focus steal. Editor toolbars set this so
     * tapping a button doesn't blur the editor (which would drop the selection
     * and collapse the mobile soft keyboard).
     */
    holdFocus?: boolean;
    children: Snippet;
  };

  let {
    active = false,
    wide = false,
    holdFocus = false,
    class: className,
    ref = $bindable(null),
    children,
    onpointerdown,
    ...rest
  }: Props = $props();

  // Param typed loosely (the underlying Button can be <a> or <button>, so its
  // handler type is a union); the forward call is cast to sidestep that.
  function handlePointerDown(event: PointerEvent) {
    if (holdFocus) event.preventDefault();
    (onpointerdown as ((e: PointerEvent) => void) | null | undefined)?.(event);
  }
</script>

<Button
  bind:ref
  variant={active ? 'secondary' : 'ghost'}
  size={wide ? 'sm' : 'icon'}
  class={cn(wide ? 'h-9 shrink-0 gap-1 px-2' : 'size-9 shrink-0', className)}
  onpointerdown={handlePointerDown}
  {...rest}
>
  {@render children()}
</Button>
