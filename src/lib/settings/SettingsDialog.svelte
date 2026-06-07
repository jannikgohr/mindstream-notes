<script lang="ts">
  import { Dialog } from 'bits-ui';
  import { X, Search } from 'lucide-svelte';
  import SettingControl from './SettingControl.svelte';
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
  import type { Category, Setting } from './types';
  import {
    displayBinding,
    getBinding,
    groupedCommands,
    isGlobalShortcutCommand,
    isGlobalShortcutOnlyCommand,
    type CommandGroup,
    type CommandDefinition
  } from '$lib/hotkeys';

  let activeCategoryId = $state<string>(SCHEMA.categories[0]?.id ?? '');
  let query = $state('');

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
      tUi(cmd.labelKey),
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
    const onPlatform = SCHEMA.categories.filter(isCategoryVisible);
    if (!lowerQuery) return onPlatform;
    return onPlatform.filter((c) => visibleSettingsIn(c).length > 0);
  });

  const activeCategory = $derived(
    visibleCategories.find((c) => c.id === activeCategoryId) ??
      visibleCategories[0]
  );

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
            {@const isActive = activeCategory?.id === cat.id}
            <button
              type="button"
              onclick={() => (activeCategoryId = cat.id)}
              class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors {isActive
                ? 'bg-accent text-accent-foreground'
                : 'text-foreground hover:bg-accent/60'}"
            >
              <Icon class="size-3.5 shrink-0 text-muted-foreground" />
              <span class="truncate">{tLabel('categories', cat.id)}</span>
            </button>
          {/each}
        </nav>

        <!-- Right pane: sections + settings -->
        <section class="themed-scrollbar overflow-y-auto px-6 py-5">
          {#if activeCategory}
            <h2 class="text-base font-semibold">
              {tLabel('categories', activeCategory.id)}
            </h2>
            {#each activeCategory.sections as sec (sec.id)}
              {@const visibleSettings = isSectionVisible(sec)
                ? sec.settings.filter((s) => isVisible(s) && settingMatches(s))
                : []}
              {#if visibleSettings.length > 0}
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
            {/each}
          {/if}
        </section>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
