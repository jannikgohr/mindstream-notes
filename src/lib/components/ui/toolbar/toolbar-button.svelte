<script lang="ts">
  /**
   * Standard toolbar button. Wraps the shadcn Button with the toolbar's fixed
   * metrics so every editor's buttons match: a 36px (`size-9`) icon target
   * with a 16px icon (the Button base forces `[&_svg]:size-4`), `ghost` until
   * `active`, then filled (`secondary`).
   *
   * Pass-through: button attributes (`onclick`, `disabled`, `title`,
   * `aria-*`) and `bind:ref` flow to the underlying Button. `title` is
   * rendered by the shared tooltip action there instead of the native browser
   * tooltip. `aria-pressed` is intentionally NOT derived from `active` — only
   * genuine toggle buttons should expose it, so callers set it explicitly.
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
    /**
     * The action has nothing to do right now (Undo with an empty history).
     * Looks and announces as disabled and ignores clicks, but stays a live
     * pointer target. Editor toolbars need that instead of `disabled`: a
     * natively disabled button never runs the `holdFocus` handler, so tapping
     * it would blur the editor and collapse the mobile soft keyboard.
     */
    unavailable?: boolean;
    children: Snippet;
  };

  let {
    active = false,
    wide = false,
    holdFocus = false,
    unavailable = false,
    class: className,
    ref = $bindable(null),
    children,
    onpointerdown,
    onclick,
    ...rest
  }: Props = $props();

  // Param typed loosely (the underlying Button can be <a> or <button>, so its
  // handler type is a union); the forward call is cast to sidestep that.
  function handlePointerDown(event: PointerEvent) {
    if (holdFocus) event.preventDefault();
    (onpointerdown as ((e: PointerEvent) => void) | null | undefined)?.(event);
  }

  function handleClick(event: MouseEvent) {
    if (unavailable) return;
    (onclick as ((e: MouseEvent) => void) | null | undefined)?.(event);
  }
</script>

<Button
  bind:ref
  variant={active ? 'secondary' : 'ghost'}
  size={wide ? 'sm' : 'icon'}
  class={cn(
    wide ? 'h-9 shrink-0 gap-1 px-2' : 'size-9 shrink-0',
    unavailable &&
      'cursor-default opacity-50 hover:bg-transparent hover:text-inherit',
    className
  )}
  aria-disabled={unavailable || undefined}
  onpointerdown={handlePointerDown}
  onclick={handleClick}
  {...rest}
>
  {@render children()}
</Button>
