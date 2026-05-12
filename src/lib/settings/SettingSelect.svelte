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
   * to the raw value when an i18n entry is missing.
   */
  import { Select } from 'bits-ui';
  import { Check, ChevronDown } from 'lucide-svelte';
  import { tValue } from './i18n.svelte';

  interface Props {
    settingId: string;
    value: string;
    options: string[];
    onChange: (next: string) => void;
    ariaLabel?: string;
  }
  let { settingId, value, options, onChange, ariaLabel }: Props = $props();

  const currentLabel = $derived(value ? tValue(settingId, value) : '');
</script>

<Select.Root
  type="single"
  value={value ?? ''}
  onValueChange={(v) => onChange(v)}
  items={options.map((o) => ({ value: o, label: tValue(settingId, o) }))}
>
  <Select.Trigger
    aria-label={ariaLabel}
    class="inline-flex h-8 w-44 items-center justify-between gap-2 rounded-md border border-input bg-background px-2 text-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    <span class="truncate">{currentLabel || '—'}</span>
    <ChevronDown class="size-3.5 shrink-0 text-muted-foreground" />
  </Select.Trigger>

  <Select.Portal>
    <Select.Content
      sideOffset={4}
      class="z-50 max-h-[min(60vh,400px)] min-w-[var(--bits-select-anchor-width)] overflow-hidden rounded-md border border-border bg-popover text-sm text-popover-foreground shadow-lg focus:outline-none"
    >
      <Select.Viewport class="p-1">
        {#each options as opt (opt)}
          <Select.Item
            value={opt}
            label={tValue(settingId, opt)}
            class="flex cursor-pointer select-none items-center justify-between gap-2 rounded-sm px-2 py-1.5 outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50"
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
