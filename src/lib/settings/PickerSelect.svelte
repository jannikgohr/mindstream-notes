<script lang="ts">
  /**
   * Themed dropdown for the `folder` / `tag` picker settings. Like
   * SettingSelect, but its items carry their own labels (folder names, tag
   * strings — not i18n values) and it always offers a leading "unset" choice so
   * a picker can be cleared. Emits '' for the unset choice.
   */
  import { Select } from 'bits-ui';
  import { Check, ChevronDown } from '@lucide/svelte';

  interface Item {
    value: string;
    label: string;
  }
  interface Props {
    value: string;
    items: Item[];
    onChange: (next: string) => void;
    /** Label for the leading empty choice (e.g. "None"). */
    unsetLabel: string;
    ariaLabel?: string;
  }
  let { value, items, onChange, unsetLabel, ariaLabel }: Props = $props();

  // The unset choice first, then the live options.
  const allItems = $derived<Item[]>([
    { value: '', label: unsetLabel },
    ...items
  ]);
  const currentLabel = $derived(
    allItems.find((i) => i.value === value)?.label ?? unsetLabel
  );
</script>

<Select.Root
  type="single"
  value={value ?? ''}
  onValueChange={(v) => onChange(v)}
  items={allItems}
>
  <Select.Trigger
    aria-label={ariaLabel}
    class="inline-flex h-8 w-56 items-center justify-between gap-2 rounded-md border border-input bg-background px-2 text-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    <span class="truncate">{currentLabel}</span>
    <ChevronDown class="size-3.5 shrink-0 text-muted-foreground" />
  </Select.Trigger>

  <Select.Portal>
    <Select.Content
      sideOffset={4}
      class="z-[360] max-h-[min(60vh,400px)] min-w-[var(--bits-select-anchor-width)] overflow-hidden rounded-md border border-border bg-popover text-sm text-popover-foreground shadow-lg focus:outline-none"
    >
      <Select.Viewport class="p-1">
        {#each allItems as item (item.value)}
          <Select.Item
            value={item.value}
            label={item.label}
            class="flex cursor-pointer select-none items-center justify-between gap-2 rounded-sm px-2 py-1.5 outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
          >
            {#snippet child({ props, selected })}
              <div {...props}>
                <span
                  class="truncate {item.value === ''
                    ? 'italic text-muted-foreground'
                    : ''}"
                >
                  {item.label}
                </span>
                {#if selected}
                  <Check class="size-3.5 text-muted-foreground" />
                {/if}
              </div>
            {/snippet}
          </Select.Item>
        {/each}
      </Select.Viewport>
    </Select.Content>
  </Select.Portal>
</Select.Root>
