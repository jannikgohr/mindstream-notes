<script lang="ts">
  /**
   * Renders one row of the settings dialog: label + optional description
   * on the left, the control on the right (or full-width below for
   * multiline / custom). Reads/writes through the store so all the
   * binding plumbing happens in one place.
   */
  import { Loader2 } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    getSettingValue,
    isModified,
    isPending,
    setSettingValue,
    resetSettingValue
  } from './store.svelte';
  import { CUSTOM_COMPONENTS, INFO_VALUES, SETTING_ACTIONS } from './registry.svelte';
  import { tDescription, tLabel, tUi, tValue } from './i18n.svelte';
  import SettingSelect from './SettingSelect.svelte';
  import type { Setting } from './types';

  interface Props {
    setting: Setting;
  }
  let { setting }: Props = $props();

  const label = $derived(tLabel('settings', setting.id));
  const description = $derived(tDescription('settings', setting.id));
  const value = $derived(getSettingValue(setting.id));
  const modified = $derived(isModified(setting.id));
  const pending = $derived(isPending(setting.id));

  /**
   * `commit` is async because some bindings (autostart in particular)
   * round-trip through Tauri IPC. We don't await at the call site — the
   * `pending` flag is what surfaces the in-flight state to the user. Errors
   * are already logged inside the store; we swallow here so an exception
   * doesn't crash the dialog.
   */
  function commit(v: unknown) {
    void setSettingValue(setting.id, v).catch(() => {});
  }

  function reset() {
    void resetSettingValue(setting.id).catch(() => {});
  }

  function fireAction() {
    if (setting.type !== 'button' || !setting.actionId) return;
    const fn = SETTING_ACTIONS[setting.actionId];
    if (fn) void fn();
  }
</script>

<div class="grid grid-cols-[1fr_auto] items-start gap-x-4 gap-y-2 py-3">
  <div class="min-w-0">
    <div class="flex items-center gap-2">
      <span class="text-sm font-medium">{label}</span>
      {#if modified}
        <span
          class="inline-block size-1.5 rounded-full bg-primary"
          title={tUi('modified')}
          aria-label={tUi('modified')}
        ></span>
      {/if}
      <span class="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
        [{setting.scope}]
      </span>
    </div>
    {#if description}
      <p class="mt-0.5 text-xs text-muted-foreground">{description}</p>
    {/if}

    {#if setting.type === 'radio'}
      <div class="mt-2 flex flex-wrap gap-1.5">
        {#each setting.options as opt (opt)}
          <button
            type="button"
            class="rounded-md border border-border px-3 py-1 text-xs transition-colors hover:bg-accent {value === opt
              ? 'border-ring bg-accent text-accent-foreground'
              : 'bg-background text-foreground'}"
            onclick={() => commit(opt)}
          >
            {tValue(setting.id, opt)}
          </button>
        {/each}
      </div>
    {:else if setting.type === 'multi-select'}
      <div class="mt-2 flex flex-wrap gap-1.5">
        {#each setting.options as opt (opt)}
          {@const arr = (Array.isArray(value) ? (value as string[]) : []) as string[]}
          {@const selected = arr.includes(opt)}
          <button
            type="button"
            class="rounded-md border border-border px-3 py-1 text-xs transition-colors hover:bg-accent {selected
              ? 'border-ring bg-accent text-accent-foreground'
              : 'bg-background text-foreground'}"
            onclick={() => commit(selected ? arr.filter((x) => x !== opt) : [...arr, opt])}
          >
            {tValue(setting.id, opt)}
          </button>
        {/each}
      </div>
    {:else if setting.type === 'custom'}
      {@const C = CUSTOM_COMPONENTS[setting.customId ?? '']}
      <div class="mt-2">
        {#if C}
          <C />
        {:else}
          <p class="text-xs text-destructive">
            Missing custom component: {setting.customId}
          </p>
        {/if}
      </div>
    {:else if setting.type === 'info'}
      {@const v = INFO_VALUES[setting.id]?.() ?? '—'}
      <p class="mt-1 font-mono text-xs text-muted-foreground">{v}</p>
    {/if}
  </div>

  <!-- Right-side compact controls -->
  <div class="flex items-center gap-2 pt-0.5">
    {#if pending}
      <Loader2 class="size-3.5 animate-spin text-muted-foreground" aria-label={tUi('saving')} />
    {/if}
    {#if setting.type === 'toggle'}
      <button
        type="button"
        role="switch"
        aria-checked={value === true}
        aria-busy={pending}
        aria-label={label}
        disabled={pending}
        onclick={() => commit(!value)}
        class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60 {value
          ? 'bg-primary'
          : 'bg-input'}"
      >
        <span
          class="pointer-events-none block size-4 rounded-full bg-background shadow-sm ring-0 transition-transform {value
            ? 'translate-x-4.5'
            : 'translate-x-0.5'}"
        ></span>
      </button>
    {:else if setting.type === 'text'}
      <input
        type="text"
        value={(value as string | undefined) ?? ''}
        oninput={(e) => commit((e.currentTarget as HTMLInputElement).value)}
        placeholder={setting.placeholder ?? ''}
        minlength={setting.minLength}
        maxlength={setting.maxLength}
        pattern={setting.pattern}
        class="h-8 w-56 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    {:else if setting.type === 'number'}
      <input
        type="number"
        value={(value as number | undefined) ?? ''}
        oninput={(e) => commit(Number((e.currentTarget as HTMLInputElement).value))}
        min={setting.min}
        max={setting.max}
        step={setting.step}
        class="h-8 w-24 rounded-md border border-input bg-background px-2 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    {:else if setting.type === 'slider'}
      <div class="flex items-center gap-2">
        <input
          type="range"
          value={(value as number | undefined) ?? setting.min ?? 0}
          oninput={(e) => commit(Number((e.currentTarget as HTMLInputElement).value))}
          min={setting.min}
          max={setting.max}
          step={setting.step}
          class="h-1.5 w-44 cursor-pointer appearance-none rounded-full bg-input accent-primary"
        />
        <span class="w-12 text-right text-xs tabular-nums text-muted-foreground">
          {(value as number | undefined) ?? '—'}{setting.unit ?? ''}
        </span>
      </div>
    {:else if setting.type === 'select'}
      <SettingSelect
        settingId={setting.id}
        value={(value as string | undefined) ?? ''}
        options={setting.options}
        onChange={commit}
        ariaLabel={label}
      />
    {:else if setting.type === 'color'}
      <div class="flex items-center gap-2">
        <input
          type="color"
          value={(value as string | undefined) ?? '#000000'}
          oninput={(e) => commit((e.currentTarget as HTMLInputElement).value)}
          class="size-7 cursor-pointer rounded border border-border bg-background"
        />
        <span class="font-mono text-xs text-muted-foreground">
          {(value as string | undefined) ?? '#000000'}
        </span>
      </div>
    {:else if setting.type === 'path'}
      <input
        type="text"
        value={(value as string | undefined) ?? ''}
        oninput={(e) => commit((e.currentTarget as HTMLInputElement).value)}
        placeholder={setting.mode === 'directory' ? '/path/to/folder' : '/path/to/file'}
        class="h-8 w-56 rounded-md border border-input bg-background px-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    {:else if setting.type === 'keybinding'}
      <input
        type="text"
        value={(value as string | undefined) ?? ''}
        oninput={(e) => commit((e.currentTarget as HTMLInputElement).value)}
        placeholder="Cmd+K"
        class="h-8 w-32 rounded-md border border-input bg-background px-2 text-center font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    {:else if setting.type === 'button'}
      <Button variant={setting.variant ?? 'default'} size="sm" onclick={fireAction}>
        {label}
      </Button>
    {/if}

    {#if modified && setting.type !== 'button' && setting.type !== 'info' && setting.type !== 'custom'}
      <button
        type="button"
        class="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-wait disabled:opacity-60"
        title={tUi('reset')}
        aria-label={tUi('reset')}
        disabled={pending}
        onclick={reset}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M3 12a9 9 0 1 0 9-9 9.74 9.74 0 0 0-6.74 2.74L3 8"/>
          <path d="M3 3v5h5"/>
        </svg>
      </button>
    {/if}
  </div>
</div>
