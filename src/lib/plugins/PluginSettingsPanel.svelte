<script lang="ts">
  /**
   * One plugin's settings beside the view they change, with presets to
   * switch between. The same settings as in the settings dialog.
   */
  import { Pencil, Save, Trash2 } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import SettingControl from '$lib/settings/SettingControl.svelte';
  import SettingSelect from '$lib/settings/SettingSelect.svelte';
  import { tLabel, tUi } from '$lib/settings/i18n.svelte';
  import { isModified, isVisible } from '$lib/settings/store.svelte';
  import {
    applyPreset,
    deletePreset,
    presetChanged,
    renamePreset,
    resetSettings,
    savePreset,
    selectedPreset,
    settingPresets
  } from './setting-presets';
  import { pluginSettingsSectionsFor } from './settings-bridge';

  let { pluginId }: { pluginId: string } = $props();

  const sections = $derived(pluginSettingsSectionsFor(pluginId));
  const presets = $derived(settingPresets(pluginId));
  const selected = $derived(selectedPreset(pluginId));
  const changed = $derived(presetChanged(pluginId));
  const offDefaults = $derived(
    sections.some((section) =>
      section.settings.some((setting) => isModified(setting.id))
    )
  );
  let name = $state('');
  // The preset the name field is renaming, rather than naming a new one.
  let renaming = $state<string | null>(null);
  let nameInput = $state<HTMLInputElement>();
  // The list's entry for no preset. A preset name is trimmed, so it can't
  // be this.
  const NO_PRESET = ' ';

  function report(task: Promise<void>) {
    task.catch((err) => console.error('[plugins] preset failed', err));
  }

  function label(option: string) {
    if (option === NO_PRESET)
      return offDefaults && !selected
        ? tUi('presets.unsaved')
        : tUi('presets.defaults');
    return option === selected && changed
      ? `${option} (${tUi('presets.changed')})`
      : option;
  }

  function startRename(preset: string) {
    renaming = preset;
    name = preset;
    nameInput?.focus();
    nameInput?.select();
  }

  function stopRename() {
    renaming = null;
    name = '';
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    report(
      renaming
        ? renamePreset(pluginId, renaming, trimmed)
        : savePreset(pluginId, trimmed)
    );
    stopRename();
  }
</script>

<div class="flex flex-col gap-3 text-sm" data-plugin-settings={pluginId}>
  <section>
    <h3
      class="border-b border-border pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
    >
      {tUi('presets.title')}
    </h3>
    <div class="mt-2 flex items-center gap-0.5">
      <SettingSelect
        settingId=""
        class="mr-1 h-8 min-w-0 flex-1 text-xs"
        ariaLabel={tUi('presets.title')}
        value={selected ?? NO_PRESET}
        options={[NO_PRESET, ...presets.map((preset) => preset.name)]}
        labelFor={label}
        onChange={(picked) => {
          stopRename();
          report(
            picked === NO_PRESET
              ? resetSettings(pluginId)
              : applyPreset(pluginId, picked)
          );
        }}
      />
      {#if selected}
        {#if changed}
          <Button
            variant="ghost"
            size="icon"
            class="size-8 shrink-0 text-accent-brand"
            title={tUi('presets.update')}
            aria-label={tUi('presets.update')}
            onclick={() => report(savePreset(pluginId, selected))}
          >
            <Save class="size-3.5" />
          </Button>
        {/if}
        <Button
          variant="ghost"
          size="icon"
          class="size-8 shrink-0 text-muted-foreground"
          title={tUi('presets.rename')}
          aria-label={tUi('presets.rename')}
          aria-pressed={renaming === selected}
          onclick={() =>
            renaming === selected ? stopRename() : startRename(selected)}
        >
          <Pencil class="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          class="size-8 shrink-0 text-muted-foreground"
          title={tUi('presets.delete')}
          aria-label={tUi('presets.delete')}
          onclick={() => {
            stopRename();
            report(deletePreset(pluginId, selected));
          }}
        >
          <Trash2 class="size-3.5" />
        </Button>
      {/if}
    </div>
    <form class="mt-1.5 flex items-center gap-1.5" onsubmit={submit}>
      <input
        bind:this={nameInput}
        class="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        placeholder={tUi(renaming ? 'presets.newName' : 'presets.name')}
        aria-label={tUi(renaming ? 'presets.newName' : 'presets.name')}
        maxlength="40"
        bind:value={name}
        onkeydown={(event) => {
          if (event.key === 'Escape' && renaming) stopRename();
        }}
      />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        class="h-8 shrink-0 text-xs"
        disabled={!name.trim() || name.trim() === renaming}
      >
        {tUi(renaming ? 'presets.renameConfirm' : 'presets.save')}
      </Button>
    </form>
  </section>

  {#each sections as section (section.id)}
    {@const shown = section.settings.filter(isVisible)}
    {#if shown.length}
      <section>
        <h3
          class="border-b border-border pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          {tLabel('sections', section.id)}
        </h3>
        <div class="divide-y divide-border">
          {#each shown as setting (setting.id)}
            <SettingControl {setting} live compact />
          {/each}
        </div>
      </section>
    {/if}
  {/each}

  <Button
    variant="ghost"
    size="sm"
    class="self-start text-xs text-muted-foreground"
    onclick={() => {
      stopRename();
      report(resetSettings(pluginId));
    }}
  >
    {tUi('presets.reset')}
  </Button>
</div>
