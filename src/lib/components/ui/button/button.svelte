<script lang="ts">
  /**
   * Minimal port of the shadcn-svelte Button. Renders an <a> if href is set,
   * otherwise a <button>. Use the shadcn CLI to overwrite this with the full
   * component when you want loading states, icon variants, etc.
   *
   * Variants and types live in ./button-variants.ts so plain `tsc`
   * (which only sees the default export of a `.svelte` file via the
   * ambient shim) can still resolve them.
   */
  import { cn } from '$lib/utils';
  import { buttonVariants, type ButtonProps } from './button-variants';

  let {
    class: className,
    variant = 'default',
    size = 'default',
    ref = $bindable(null),
    href = undefined,
    type = 'button',
    children,
    ...restProps
  }: ButtonProps = $props();
</script>

{#if href}
  <a
    bind:this={ref}
    class={cn(buttonVariants({ variant, size }), className)}
    {href}
    {...restProps}
  >
    {@render children?.()}
  </a>
{:else}
  <button
    bind:this={ref}
    class={cn(buttonVariants({ variant, size }), className)}
    {type}
    {...restProps}
  >
    {@render children?.()}
  </button>
{/if}
