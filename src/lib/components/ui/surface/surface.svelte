<script lang="ts">
  import { cn } from '$lib/utils';
  import { surfaceVariants } from './surface-variants';
  import type { SurfaceProps } from './surface-variants';

  let {
    as = 'div',
    variant = 'section',
    padding = 'none',
    ref = $bindable(null),
    class: className,
    children,
    ...rest
  }: SurfaceProps = $props();
</script>

<svelte:element
  this={as}
  bind:this={ref}
  class={cn(surfaceVariants({ variant, padding }), className)}
  {...rest}
>
  {@render children?.()}
</svelte:element>
