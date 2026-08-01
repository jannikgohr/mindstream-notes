<script lang="ts">
  import { Dialog } from 'bits-ui';
  import { X, Search, ChevronRight } from '@lucide/svelte';
  import SettingControl from './SettingControl.svelte';
  import PluginsOverview from '$lib/plugins/PluginsOverview.svelte';
  import PluginNativeToolsSection from '$lib/plugins/PluginNativeToolsSection.svelte';
  import {
    SCHEMA,
    closeSettings,
    getSettingValue,
    isCategoryVisible,
    isSectionVisible,
    isVisible,
    settingsDialog
  } from './store.svelte';
  import { FALLBACK_ICON, SETTINGS_ICONS } from './icons';
  import { i18n, tLabel, tUi } from './i18n.svelte';
  import type { Category, Section, Setting } from './types';
  import {
    groupedCommands,
    isGlobalShortcutCommand,
    isGlobalShortcutOnlyCommand,
    type CommandGroup,
    type CommandDefinition
  } from '$lib/hotkeys/catalogue';
  import { displayBinding } from '$lib/hotkeys/format';
  import { getBinding } from '$lib/hotkeys/store.svelte';
  import {
    PLUGINS_CATEGORY_ID,
    pluginSettingsCategory,
    pluginSettingsSectionsFor
  } from '$lib/plugins/settings-bridge';
  import { pluginCommandLabel } from '$lib/plugins/hotkeys';
  import { pluginsWithSettings } from '$lib/plugins/manage.svelte';
  import { allPlugins, pluginById } from '$lib/plugins/registry.svelte';
  import { resolvePluginStringOptional } from '$lib/plugins/plugin-i18n';

  // The synthetic "Plugins" category appears whenever any plugin is installed
  // (even one with no settings — it still needs a home in the management
  // overview). Its sections are the enabled plugins' settings, if any.
  const pluginCategory = $derived.by<Category | null>(() => {
    if (allPlugins().length === 0) return null;
    return {
      id: PLUGINS_CATEGORY_ID,
      icon: 'puzzle',
      sections: pluginSettingsCategory()?.sections ?? []
    };
  });

  const allCategories = $derived.by<Category[]>(() =>
    pluginCategory ? [...SCHEMA.categories, pluginCategory] : SCHEMA.categories
  );

  let activeCategoryId = $state<string>(SCHEMA.categories[0]?.id ?? '');
  // Which plugin's settings are shown while the Plugins category is active.
  // `null` shows the management overview instead.
  let activePluginId = $state<string | null>(null);
  let pluginsExpanded = $state(false);
  let query = $state('');

  function selectCategory(id: string): void {
    activeCategoryId = id;
    activePluginId = null;
  }

  function selectPluginOverview(): void {
    activeCategoryId = PLUGINS_CATEGORY_ID;
    activePluginId = null;
  }

  function selectPlugin(id: string): void {
    activeCategoryId = PLUGINS_CATEGORY_ID;
    activePluginId = id;
    pluginsExpanded = true;
  }

  // Honor a deep-link requested via openSettings('<category>') — e.g. a
  // notification jumping to the Plugins overview. Consumed once.
  $effect(() => {
    const requested = settingsDialog.requestedCategory;
    if (requested) {
      selectCategory(requested);
      settingsDialog.requestedCategory = null;
    }
  });

  const lowerQuery = $derived(query.trim().toLowerCase());
  const catalogueHotkeyGroups = groupedCommands();
  const globalShortcutsEnabled = $derived(
    getSettingValue('hotkeys.globalShortcuts') === true
  );

  type DisplayCommandGroup = CommandGroup & {
    displayScope?: 'globalShortcuts';
  };

  const hotkeyGroups = $derived.by<DisplayCommandGroup[]>(() => {
    if (!globalShortcutsEnabled) {
      return catalogueHotkeyGroups
        .map((group) =>
          group.scope === 'global'
            ? {
                ...group,
                commands: group.commands.filter(
                  (cmd) => !isGlobalShortcutOnlyCommand(cmd)
                )
              }
            : group
        )
        .filter((group) => group.commands.length > 0);
    }

    const next: DisplayCommandGroup[] = [];
    for (const group of catalogueHotkeyGroups) {
      if (group.scope !== 'global') {
        next.push(group);
        continue;
      }

      const globalShortcutCommands = group.commands.filter(
        isGlobalShortcutCommand
      );
      const applicationCommands = group.commands.filter(
        (cmd) => !isGlobalShortcutCommand(cmd)
      );

      if (globalShortcutCommands.length > 0) {
        next.push({
          scope: 'global',
          editorKind: null,
          commands: globalShortcutCommands,
          displayScope: 'globalShortcuts'
        });
      }
      if (applicationCommands.length > 0) {
        next.push({ ...group, commands: applicationCommands });
      }
    }
    return next;
  });

  function hotkeyGroupLabel(group: DisplayCommandGroup): string {
    if (group.displayScope === 'globalShortcuts') {
      return tUi('hotkeys.group.globalShortcuts');
    }
    const { scope, editorKind } = group;
    if (scope === 'global') return tUi('hotkeys.group.global');
    return tUi(`hotkeys.group.editor.${editorKind}`);
  }

  function hotkeyCommandMatches(
    cmd: CommandDefinition,
    groupLabel: string
  ): boolean {
    const current = getBinding(cmd.id);
    const display = displayBinding(current) || tUi('hotkeys.unset');
    return [
      cmd.id,
      pluginCommandLabel(cmd.id) ?? tUi(cmd.labelKey),
      groupLabel,
      current ?? '',
      display,
      tLabel('settings', 'hotkeys.panel')
    ]
      .join(' ')
      .toLowerCase()
      .includes(lowerQuery);
  }

  function hotkeysPanelMatches(): boolean {
    if (!lowerQuery) return true;
    return hotkeyGroups.some((group) => {
      const label = hotkeyGroupLabel(group);
      return group.commands.some((cmd) => hotkeyCommandMatches(cmd, label));
    });
  }

  function settingMatches(s: Setting): boolean {
    if (!lowerQuery) return true;
    if (s.id === 'hotkeys.panel' && hotkeysPanelMatches()) return true;
    const haystack = [
      s.id,
      tLabel('settings', s.id),
      i18n.bundle.settings?.[s.id]?.description ?? ''
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(lowerQuery);
  }

  function visibleSettingsIn(cat: Category): Setting[] {
    const all: Setting[] = [];
    for (const sec of cat.sections) {
      if (!isSectionVisible(sec)) continue;
      for (const s of sec.settings) {
        if (isVisible(s) && settingMatches(s)) all.push(s);
      }
    }
    return all;
  }

  const visibleCategories = $derived.by(() => {
    const onPlatform = allCategories.filter(isCategoryVisible);
    if (!lowerQuery) return onPlatform;
    return onPlatform.filter((c) => visibleSettingsIn(c).length > 0);
  });

  const activeCategory = $derived(
    visibleCategories.find((c) => c.id === activeCategoryId) ??
      visibleCategories[0]
  );

  const isPluginsCategory = $derived(
    activeCategory?.id === PLUGINS_CATEGORY_ID
  );
  const showingPluginOverview = $derived(
    isPluginsCategory && activePluginId === null
  );

  /** Sections to render in the right pane for the current selection. */
  const sectionsToRender = $derived.by<Section[]>(() => {
    if (!activeCategory) return [];
    if (isPluginsCategory && activePluginId) {
      return pluginSettingsSectionsFor(activePluginId);
    }
    return activeCategory.sections;
  });

  /** Heading for the right pane: plugin name when a plugin is selected. */
  const paneHeading = $derived.by(() => {
    if (!activeCategory) return '';
    if (isPluginsCategory && activePluginId) {
      return pluginById(activePluginId)?.manifest.name ?? activePluginId;
    }
    return tLabel('categories', activeCategory.id);
  });

  /** A selected plugin's own description, shown as its in-app documentation. */
  const paneDescription = $derived.by<string | undefined>(() => {
    if (!(isPluginsCategory && activePluginId)) return undefined;
    return resolvePluginStringOptional(
      activePluginId,
      pluginById(activePluginId)?.manifest.descriptionKey
    );
  });

  function categoryIcon(name: string | undefined) {
    if (!name) return FALLBACK_ICON;
    return SETTINGS_ICONS[name] ?? FALLBACK_ICON;
  }
</script>

<Dialog.Root
  bind:open={settingsDialog.open}
  onOpenChange={(o: boolean) => {
    if (!o) closeSettings();
  }}
>
  <Dialog.Portal>
    <Dialog.Overlay
      class="fixed inset-0 z-350 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
    />
    <Dialog.Content
      class="fixed left-1/2 top-1/2 z-350 grid h-[80vh] w-[min(960px,92vw)] -translate-x-1/2 -translate-y-1/2 grid-rows-[auto_1fr] overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-xl focus:outline-none"
    >
      <header
        class="flex items-center gap-3 border-b border-border bg-card px-4 py-3"
      >
        <Dialog.Title class="text-base font-semibold"
          >{tUi('title')}</Dialog.Title
        >

        <div class="relative ml-4 flex-1">
          <Search
            class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="text"
            bind:value={query}
            placeholder={tUi('search')}
            class="h-8 w-full rounded-md border border-input bg-background pl-7 pr-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <Dialog.Close
          class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={tUi('close')}
        >
          <X class="size-4" />
        </Dialog.Close>
      </header>

      <div class="grid min-h-0 grid-cols-[200px_1fr] divide-x divide-border">
        <!-- Left rail: categories -->
        <nav class="overflow-y-auto bg-card/40 py-2">
          {#if visibleCategories.length === 0}
            <p class="px-4 py-3 text-xs text-muted-foreground">
              {tUi('empty')}
            </p>
          {/if}
          {#each visibleCategories as cat (cat.id)}
            {@const Icon = categoryIcon(cat.icon)}
            {#if cat.id === PLUGINS_CATEGORY_ID}
              <!-- Plugins is the one expandable category: the row selects the
                   management overview, the chevron reveals per-plugin settings. -->
              {@const children = pluginsWithSettings()}
              <div class="flex items-stretch">
                <button
                  type="button"
                  onclick={selectPluginOverview}
                  class="flex flex-1 items-center gap-2 px-3 py-2 text-left text-sm transition-colors {showingPluginOverview
                    ? 'bg-accent text-accent-foreground'
                    : 'text-foreground hover:bg-accent/60'}"
                >
                  <Icon class="size-3.5 shrink-0 text-muted-foreground" />
                  <span class="truncate">{tLabel('categories', cat.id)}</span>
                </button>
                {#if children.length > 0}
                  <button
                    type="button"
                    aria-label={tLabel('categories', cat.id)}
                    aria-expanded={pluginsExpanded}
                    onclick={() => (pluginsExpanded = !pluginsExpanded)}
                    class="flex shrink-0 items-center justify-center px-2.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                  >
                    <ChevronRight
                      class="size-3.5 transition-transform {pluginsExpanded
                        ? 'rotate-90'
                        : ''}"
                    />
                  </button>
                {/if}
              </div>
              {#if pluginsExpanded}
                {#each children as child (child.id)}
                  {@const childActive =
                    isPluginsCategory && activePluginId === child.id}
                  <button
                    type="button"
                    onclick={() => selectPlugin(child.id)}
                    class="flex w-full items-center gap-2 py-1.5 pl-9 pr-3 text-left text-sm transition-colors {childActive
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'}"
                  >
                    <span class="truncate">{child.name}</span>
                  </button>
                {/each}
              {/if}
            {:else}
              {@const isActive = activeCategory?.id === cat.id}
              <button
                type="button"
                onclick={() => selectCategory(cat.id)}
                class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors {isActive
                  ? 'bg-accent text-accent-foreground'
                  : 'text-foreground hover:bg-accent/60'}"
              >
                <Icon class="size-3.5 shrink-0 text-muted-foreground" />
                <span class="truncate">{tLabel('categories', cat.id)}</span>
              </button>
            {/if}
          {/each}
        </nav>

        <!-- Right pane: sections + settings -->
        <section class="themed-scrollbar overflow-y-auto px-6 py-5">
          {#if activeCategory}
            <h2 class="text-base font-semibold">
              {paneHeading}
            </h2>
            {#if paneDescription}
              <p class="mt-1 text-sm text-muted-foreground">
                {paneDescription}
              </p>
            {/if}
            {#if showingPluginOverview}
              <PluginsOverview
                onOpenSettings={selectPlugin}
                onOpenHotkeys={() => selectCategory('hotkeys')}
              />
            {:else}
              {#each sectionsToRender as sec (sec.id)}
                {@const visibleSettings = isSectionVisible(sec)
                  ? sec.settings.filter(
                      (s) => isVisible(s) && settingMatches(s)
                    )
                  : []}
                {#if visibleSettings.length > 0}
                  {#if sec.advanced && !lowerQuery}
                    <details class="group mt-5">
                      <summary
                        class="flex cursor-pointer list-none items-center gap-1 border-b border-border pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
                      >
                        <span
                          class="transition-transform group-open:rotate-90"
                          aria-hidden="true">›</span
                        >
                        {tLabel('sections', sec.id)}
                      </summary>
                      <div class="divide-y divide-border">
                        {#each visibleSettings as s (s.id)}
                          <SettingControl setting={s} searchQuery={query} />
                        {/each}
                      </div>
                    </details>
                  {:else}
                    <div class="mt-5">
                      <h3
                        class="border-b border-border pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                      >
                        {tLabel('sections', sec.id)}
                      </h3>
                      <div class="divide-y divide-border">
                        {#each visibleSettings as s (s.id)}
                          <SettingControl setting={s} searchQuery={query} />
                        {/each}
                      </div>
                    </div>
                  {/if}
                {/if}
              {/each}
              {#if isPluginsCategory && activePluginId}
                <PluginNativeToolsSection pluginId={activePluginId} />
              {/if}
            {/if}
          {/if}
        </section>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
