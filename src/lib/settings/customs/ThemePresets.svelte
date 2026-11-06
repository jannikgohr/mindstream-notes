<script lang="ts">
  import {
    BUILTIN_PRESETS,
    BUILTIN_PRESET_NAMES,
    resolvedPreset
  } from '../theme-presets';
  import { themeCatalog, refreshThemePresets } from '../theme.svelte';
  import { getSettingValue, setSettingValue } from '../store.svelte';
  import { saveThemePreset, deleteThemePreset } from '$lib/api/theme-presets';
  import { tUi, tUiFormat } from '../i18n.svelte';
  import { toErrorMessage } from '$lib/api/errors';
  import { ChevronRight } from '@lucide/svelte';
  import SettingSelect from '../SettingSelect.svelte';
  let raw = $state('');
  let editorOpen = $state(false);
  let busy = $state(false);
  let error = $state('');
  const selected = $derived(String(getSettingValue('appearance.preset')));
  const preset = $derived(resolvedPreset(themeCatalog.presets, selected));
  const missing = $derived(
    !themeCatalog.presets.some((preset) => preset.id === selected)
  );
  const custom = $derived(
    !BUILTIN_PRESETS.some((preset) => preset.id === selected)
  );
  function presetLabel(item: { id: string; name: string }): string {
    return Object.hasOwn(BUILTIN_PRESET_NAMES, item.id)
      ? tUi(BUILTIN_PRESET_NAMES[item.id as keyof typeof BUILTIN_PRESET_NAMES])
      : item.name;
  }
  async function select(id: string) {
    error = '';
    busy = true;
    try {
      await setSettingValue('appearance.preset', id);
    } catch (cause) {
      error = toErrorMessage(cause);
    } finally {
      busy = false;
    }
  }
  async function save() {
    error = '';
    busy = true;
    try {
      await saveThemePreset(raw);
      await refreshThemePresets();
      await setSettingValue('appearance.preset', JSON.parse(raw).id);
      raw = '';
    } catch (cause) {
      error = toErrorMessage(cause);
    } finally {
      busy = false;
    }
  }
  async function remove() {
    error = '';
    busy = true;
    try {
      await deleteThemePreset(selected);
      await refreshThemePresets();
    } catch (cause) {
      error = toErrorMessage(cause);
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex flex-col gap-3">
  <SettingSelect
    settingId="appearance.preset"
    ariaLabel={tUi('theme.select')}
    value={selected}
    disabled={busy}
    options={[
      ...(missing ? [selected] : []),
      ...themeCatalog.presets.map((item) => item.id)
    ]}
    labelFor={(id) => {
      const item = themeCatalog.presets.find((entry) => entry.id === id);
      return item
        ? presetLabel(item)
        : tUiFormat('theme.missingOption', { id });
    }}
    onChange={(id) => void select(id)}
    class="h-9 w-full"
  />
  {#if missing}<p role="status" class="text-sm text-muted-foreground">
      {tUi('theme.missing')}
    </p>{/if}
  {#if error || themeCatalog.error}<p
      role="alert"
      class="text-sm text-destructive"
    >
      {error || themeCatalog.error}
    </p>{/if}
  <div class="flex flex-wrap gap-2">
    <button
      type="button"
      class="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
      disabled={busy}
      onclick={() => {
        raw = JSON.stringify(preset, null, 2);
        editorOpen = true;
      }}>{tUi('theme.editJson')}</button
    >
    {#if custom && !missing}<button
        type="button"
        class="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
        disabled={busy}
        onclick={remove}>{tUi('theme.remove')}</button
      >{/if}
  </div>
  <details bind:open={editorOpen}>
    <!-- The app's chevron instead of the browser's disclosure triangle. -->
    <summary
      class="flex w-fit cursor-pointer list-none items-center gap-1 text-sm [&::-webkit-details-marker]:hidden"
    >
      <ChevronRight
        class="size-3.5 text-muted-foreground transition-transform {editorOpen
          ? 'rotate-90'
          : ''}"
        aria-hidden="true"
      />{tUi('theme.import')}
    </summary>
    <p class="mt-2 text-sm text-muted-foreground">{tUi('theme.importHelp')}</p>
    <textarea
      aria-label={tUi('theme.json')}
      bind:value={raw}
      spellcheck="false"
      rows="8"
      class="mt-2 w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
    ></textarea>
    <button
      type="button"
      class="mt-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
      disabled={busy || !raw.trim()}
      onclick={save}>{tUi('theme.save')}</button
    >
  </details>
</div>
