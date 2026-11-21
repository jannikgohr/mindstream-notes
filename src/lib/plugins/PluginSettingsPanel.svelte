<script lang="ts">
  /**
   * One plugin's settings beside the view they change, with presets to
   * switch between. The same settings as in the settings dialog.
   */
  import { Trash2 } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import SettingControl from '$lib/settings/SettingControl.svelte';
  import SettingSelect from '$lib/settings/SettingSelect.svelte';
  import { tLabel, tUi } from '$lib/settings/i18n.svelte';
  import { isModified, isVisible } from '$lib/settings/store.svelte';
  import {
    activePreset,
    applyPreset,
    deletePreset,
    resetSettings,
    savePreset,
    settingPresets
  } from './setting-presets';
  import { pluginSettingsSectionsFor } from './settings-bridge';

  let { pluginId }: { pluginId: string } = $props();

  const sections = $derived(pluginSettingsSectionsFor(pluginId));
  const presets = $derived(settingPresets(pluginId));
  const active = $derived(activePreset(pluginId));
  const changed = $derived(
    sections.some((section) =>
      section.settings.some((setting) => isModified(setting.id))
    )
  );
  let name = $state('');
  // The list's entry for no preset. A preset name is trimmed, so it can't
  // be this.
  const NO_PRESET = ' ';

  function report(task: Promise<void>) {
    task.catch((err) => console.error('[plugins] preset failed', err));
  }

  function save(event: SubmitEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    report(savePreset(pluginId, trimmed));
    name = '';
  }
</script>

<div class="flex flex-col gap-3 text-sm" data-plugin-settings={pluginId}>
  <section>
    <h3
      class="border-b border-border pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
    >
      {tUi('presets.title')}
    </h3>
    <div class="mt-2 flex items-center gap-1.5">
      <SettingSelect
        settingId=""
        class="h-8 min-w-0 flex-1 text-xs"
        ariaLabel={tUi('presets.title')}
        value={active ?? NO_PRESET}
        options={[NO_PRESET, ...presets.map((preset) => preset.name)]}
        labelFor={(option) =>
          option !== NO_PRESET
            ? option
            : active === undefined && changed
              ? tUi('presets.unsaved')
              : tUi('presets.defaults')}
        onChange={(picked) =>
          report(
            picked === NO_PRESET
              ? resetSettings(pluginId)
              : applyPreset(pluginId, picked)
          )}
      />
      {#if active}
        <Button
          variant="ghost"
          size="icon"
          class="size-8 shrink-0 text-muted-foreground"
          title={tUi('presets.delete')}
          aria-label={tUi('presets.delete')}
          onclick={() => report(deletePreset(pluginId, active))}
        >
          <Trash2 class="size-3.5" />
        </Button>
      {/if}
    </div>
    <form class="mt-1.5 flex items-center gap-1.5" onsubmit={save}>
      <input
        class="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"
        placeholder={tUi('presets.name')}
        aria-label={tUi('presets.name')}
        maxlength="40"
        bind:value={name}
      />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        class="h-8 shrink-0 text-xs"
        disabled={!name.trim()}
      >
        {tUi('presets.save')}
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
    onclick={() => report(resetSettings(pluginId))}
  >
    {tUi('presets.reset')}
  </Button>
</div>
