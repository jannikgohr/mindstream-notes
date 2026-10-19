<script lang="ts">
  import { BUILTIN_PRESETS, resolvedPreset } from '../theme-presets';
  import { themeCatalog, refreshThemePresets } from '../theme.svelte';
  import { getSettingValue, setSettingValue } from '../store.svelte';
  import { saveThemePreset, deleteThemePreset } from '$lib/api/theme-presets';
  import { tUi, tUiFormat } from '../i18n.svelte';
  import { toErrorMessage } from '$lib/api/errors';
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
  // Built-in names are UI copy; a user preset keeps the name it was saved with.
  const BUILTIN_NAMES = {
    default: 'theme.preset.default',
    'builtin:slate-indigo': 'theme.preset.slate',
    'builtin:paper-teal': 'theme.preset.paper',
    warm: 'theme.preset.warm',
    forest: 'theme.preset.forest'
  } as const;
  function presetLabel(item: { id: string; name: string }): string {
    return Object.hasOwn(BUILTIN_NAMES, item.id)
      ? tUi(BUILTIN_NAMES[item.id as keyof typeof BUILTIN_NAMES])
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
  <select
    aria-label={tUi('theme.select')}
    value={selected}
    disabled={busy}
    onchange={(event) => select(event.currentTarget.value)}
    class="rounded-md border border-input bg-background px-3 py-2 text-sm"
  >
    {#if missing}<option value={selected}
        >{tUiFormat('theme.missingOption', { id: selected })}</option
      >{/if}
    {#each themeCatalog.presets as item (item.id)}<option value={item.id}
        >{presetLabel(item)}</option
      >{/each}
  </select>
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
    <summary class="cursor-pointer text-sm">{tUi('theme.import')}</summary>
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
