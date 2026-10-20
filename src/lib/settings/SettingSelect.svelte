<script lang="ts">
  /**
   * Themed dropdown for the settings dialog's `type: 'select'` rows.
   * Replaces the native `<select>` — that one inherits the OS picker
   * (white background on Windows, native sheet on Android) which clashes
   * with the rest of the dialog. bits-ui's Select gives us full styling
   * control plus keyboard support + focus trap.
   *
   * `value` is bound — parent `commit()` runs on every change. The
   * trigger renders the active option's translated label, falling back
   * to the raw value when an i18n entry is missing. An optional `icon`
   * leads the trigger label.
   */
  import type { Component } from 'svelte';
  import { Select } from 'bits-ui';
  import { Check, ChevronDown } from '@lucide/svelte';
  import { cn } from '$lib/utils';
  import { tValue } from './i18n.svelte';

  interface Props {
    settingId: string;
    value: string;
    options: string[];
    onChange: (next: string) => void;
    ariaLabel?: string;
    class?: string;
    disabled?: boolean;
    touchFriendly?: boolean;
    icon?: Component;
  }
  let {
    settingId,
    value,
    options,
    onChange,
    ariaLabel,
    class: className,
    disabled = false,
    touchFriendly = false,
    icon: Icon
  }: Props = $props();

  const currentLabel = $derived(value ? tValue(settingId, value) : '');
</script>

<Select.Root
  type="single"
  {disabled}
  value={value ?? ''}
  onValueChange={(v) => onChange(v)}
  items={options.map((o) => ({ value: o, label: tValue(settingId, o) }))}
>
  <Select.Trigger
    aria-label={ariaLabel}
    class={cn(
      'inline-flex h-8 w-44 items-center justify-between gap-2 rounded-md border border-input bg-background px-2 text-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
      className
    )}
  >
    <span class="flex min-w-0 items-center gap-1.5">
      {#if Icon}<Icon
          class="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />{/if}
      <span class="truncate">{currentLabel || '—'}</span>
    </span>
    <ChevronDown class="size-3.5 shrink-0 text-muted-foreground" />
  </Select.Trigger>

  <Select.Portal>
    <Select.Content
      sideOffset={4}
      class="z-[360] max-h-[min(60vh,400px)] min-w-[var(--bits-select-anchor-width)] overflow-hidden rounded-md border border-border-strong bg-popover text-sm text-popover-foreground shadow-overlay focus:outline-none"
    >
      <Select.Viewport class="p-1">
        {#each options as opt (opt)}
          <Select.Item
            value={opt}
            label={tValue(settingId, opt)}
            class={cn(
              touchFriendly && 'min-h-11',
              'flex cursor-pointer select-none items-center justify-between gap-2 rounded-sm px-2 py-1.5 outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50'
            )}
          >
            {#snippet child({ props, selected })}
              <div {...props}>
                <span class="truncate">{tValue(settingId, opt)}</span>
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
