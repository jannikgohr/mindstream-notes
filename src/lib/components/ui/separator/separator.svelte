<script lang="ts">
  import { cn } from '$lib/utils';
  import type { HTMLAttributes } from 'svelte/elements';

  type Orientation = 'horizontal' | 'vertical';

  interface Props extends HTMLAttributes<HTMLDivElement> {
    orientation?: Orientation;
    class?: string;
  }

  let {
    orientation = 'horizontal',
    class: className,
    ...rest
  }: Props = $props();
</script>

<div
  role="separator"
  aria-orientation={orientation}
  class={cn(
    'shrink-0 bg-border',
    orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
    className
  )}
  {...rest}
></div>
