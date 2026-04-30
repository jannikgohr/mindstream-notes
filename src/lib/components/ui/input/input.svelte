<script lang="ts" module>
  import type { HTMLInputAttributes } from 'svelte/elements';
  import type { WithElementRef } from 'bits-ui';

  /**
   * Standard shadcn-svelte text input. Drop-in replacement for
   * <input class="...">; pass any HTMLInputAttributes through and bind
   * `value` and/or `ref` as needed.
   */
  export type InputProps = WithElementRef<HTMLInputAttributes>;
</script>

<script lang="ts">
  import { cn } from '$lib/utils';

  let {
    class: className,
    value = $bindable(),
    type = 'text',
    ref = $bindable(null),
    ...restProps
  }: InputProps = $props();
</script>

<input
  bind:this={ref}
  bind:value
  {type}
  class={cn(
    'flex h-9 w-full rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
    className
  )}
  {...restProps}
/>
