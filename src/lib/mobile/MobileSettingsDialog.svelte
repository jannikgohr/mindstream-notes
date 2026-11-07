<script lang="ts">
  /**
   * Mobile settings shell. Two full-screen views driven by
   * `activeCategoryId`:
   *
   *   null         — list of categories, each a tappable row.
   *   <category>   — that category's sections + settings, with a back
   *                  arrow in the header that returns to the list.
   *
   * Plugins adds a third level, like the desktop dialog: the category shows
   * the plugin list, and a plugin's gear opens a page with only that
   * plugin's settings (`activePluginId`).
   *
   * Bound to the shared `settingsDialog.open` flag so the FAB / settings
   * icon opens this on mobile and the desktop SettingsDialog on desktop.
   *
   * Uses bits-ui Dialog for focus trap + escape handling; the content
   * is styled as a fixed full-bleed surface (no centred card) and
   * wrapped in safe-area padding so it doesn't sit under the Android
   * status bar or gesture bar with edge-to-edge enabled.
   */
  import { Dialog } from 'bits-ui';
  import { ArrowLeft, ChevronRight, X } from '@lucide/svelte';
  import SettingControl from '$lib/settings/SettingControl.svelte';
  import {
    SCHEMA,
    closeSettings,
    isCategoryVisible,
    isSectionVisible,
    isVisible,
    settingsDialog
  } from '$lib/settings/store.svelte';
  import { FALLBACK_ICON, SETTINGS_ICONS } from '$lib/settings/icons';
  import { tLabel, tUi } from '$lib/settings/i18n.svelte';
  import type { Category, Setting } from '$lib/settings/types';
  import PluginsOverview from '$lib/plugins/PluginsOverview.svelte';
  import PluginNativeToolsSection from '$lib/plugins/PluginNativeToolsSection.svelte';
  import PluginTextCheckersSection from '$lib/plugins/PluginTextCheckersSection.svelte';
  import {
    PLUGINS_CATEGORY_ID,
    pluginSettingsCategory,
    pluginSettingsSectionsFor
  } from '$lib/plugins/settings-bridge';
  import { allPlugins, pluginById } from '$lib/plugins/registry.svelte';
  import { resolvePluginStringOptional } from '$lib/plugins/plugin-i18n';
  import { closeNavOverlay, openNavOverlay } from './state.svelte';

  let activeCategoryId = $state<string | null>(null);
  let activePluginId = $state<string | null>(null);

  // Include the synthetic "Plugins" category whenever any plugin is installed
  // (it hosts the management overview even for plugins with no settings).
  const pluginCategory = $derived.by<Category | null>(() => {
    if (allPlugins().length === 0) return null;
    return {
      id: PLUGINS_CATEGORY_ID,
      icon: 'puzzle',
      sections: pluginSettingsCategory()?.sections ?? []
    };
  });

  const visibleCategories = $derived(
    (pluginCategory
      ? [...SCHEMA.categories, pluginCategory]
      : SCHEMA.categories
    ).filter(isCategoryVisible)
  );

  const activeCategory = $derived<Category | null>(
    activeCategoryId === null
      ? null
      : (visibleCategories.find((c) => c.id === activeCategoryId) ?? null)
  );

  /** Reset to the category list whenever the dialog closes. */
  $effect(() => {
    if (!settingsDialog.open) activeCategoryId = null;
  });
  // A plugin page only lives inside the Plugins category.
  $effect(() => {
    if (activeCategoryId !== PLUGINS_CATEGORY_ID) activePluginId = null;
  });

  const isPluginsCategory = $derived(
    activeCategory?.id === PLUGINS_CATEGORY_ID
  );
  /** Sections of the current page: one plugin's, or the category's own. */
  const pageSections = $derived.by(() => {
    if (!activeCategory) return [];
    if (isPluginsCategory) {
      return activePluginId ? pluginSettingsSectionsFor(activePluginId) : [];
    }
    return activeCategory.sections;
  });
  const pageTitle = $derived.by(() => {
    if (!activeCategory) return '';
    if (isPluginsCategory && activePluginId) {
      return pluginById(activePluginId)?.manifest.name ?? activePluginId;
    }
    return tLabel('categories', activeCategory.id);
  });
  const pageDescription = $derived.by<string | undefined>(() => {
    if (!(isPluginsCategory && activePluginId)) return undefined;
    return resolvePluginStringOptional(
      activePluginId,
      pluginById(activePluginId)?.manifest.descriptionKey
    );
  });

  /** Back steps plugin page → plugin list → category list. */
  function back() {
    if (activePluginId) activePluginId = null;
    else activeCategoryId = null;
  }

  // Honor a deep-link requested via openSettings('<category>') — e.g. a
  // notification jumping to Plugins. Consumed once.
  $effect(() => {
    const requested = settingsDialog.requestedCategory;
    if (requested) {
      activeCategoryId = requested;
      settingsDialog.requestedCategory = null;
    }
  });

  // Give the category-detail view its own nav-stack level so the Android
  // system back button steps detail → overview before closing settings
  // (the whole settings subsystem's single entry is owned by
  // MobileOptionsMenu; this stacks one more on top). `navHeld` is a
  // non-reactive mirror so the effect acquires / releases the entry
  // exactly once per drill-in↔out. Popping it (system back) runs the
  // close handler, which clears activeCategoryId; the in-header back arrow
  // clears it directly and the effect then reclaims the entry via
  // closeNavOverlay — keeping browser history in lockstep either way.
  const CATEGORY_NAV_ID = 'mobile-settings-category';
  let categoryNavHeld = false;
  $effect(() => {
    const drilledIn = settingsDialog.open && activeCategoryId !== null;
    if (drilledIn && !categoryNavHeld) {
      categoryNavHeld = true;
      openNavOverlay(CATEGORY_NAV_ID, () => (activeCategoryId = null));
    } else if (!drilledIn && categoryNavHeld) {
      categoryNavHeld = false;
      closeNavOverlay(CATEGORY_NAV_ID);
    }
  });

  // One more nav-stack level for a plugin page, so system back returns to
  // the plugin list first.
  const PLUGIN_NAV_ID = 'mobile-settings-plugin';
  let pluginNavHeld = false;
  $effect(() => {
    const onPlugin = settingsDialog.open && activePluginId !== null;
    if (onPlugin && !pluginNavHeld) {
      pluginNavHeld = true;
      openNavOverlay(PLUGIN_NAV_ID, () => (activePluginId = null));
    } else if (!onPlugin && pluginNavHeld) {
      pluginNavHeld = false;
      closeNavOverlay(PLUGIN_NAV_ID);
    }
  });

  function categoryIcon(name: string | undefined) {
    if (!name) return FALLBACK_ICON;
    return SETTINGS_ICONS[name] ?? FALLBACK_ICON;
  }

  let contentEl = $state<HTMLElement | null>(null);

  function visibleSettings(cat: Category): Setting[] {
    const out: Setting[] = [];
    for (const sec of cat.sections) {
      if (!isSectionVisible(sec)) continue;
      for (const s of sec.settings) {
        if (isVisible(s)) out.push(s);
      }
    }
    return out;
  }
</script>

<Dialog.Root
  bind:open={settingsDialog.open}
  onOpenChange={(o: boolean) => {
    if (!o) closeSettings();
  }}
>
  <Dialog.Portal>
    <!-- Opening focuses the page itself rather than the close button, so a
         tap does not leave a focus ring on it. -->
    <Dialog.Content
      bind:ref={contentEl}
      tabindex={-1}
      onOpenAutoFocus={(event: Event) => {
        event.preventDefault();
        contentEl?.focus();
      }}
      class="safe-top safe-bottom safe-x fixed inset-0 z-50 flex flex-col bg-background text-foreground focus:outline-none"
    >
      {#if activeCategory === null}
        <!-- ====================== Category list ====================== -->
        <header
          class="grid h-14 shrink-0 grid-cols-[2.75rem_1fr_2.75rem] items-center border-b border-border bg-card px-1.5"
        >
          <span aria-hidden="true"></span>
          <Dialog.Title class="truncate text-center text-base font-semibold">
            {tUi('title')}
          </Dialog.Title>
          <Dialog.Close
            class="flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={tUi('close')}
          >
            <X class="size-5" />
          </Dialog.Close>
        </header>

        <nav class="flex-1 overflow-y-auto" aria-label={tUi('title')}>
          {#each visibleCategories as cat (cat.id)}
            {@const Icon = categoryIcon(cat.icon)}
            <button
              type="button"
              class="flex min-h-13 w-full items-center gap-3 border-b border-border px-4 py-3 text-left text-sm transition-colors hover:bg-accent"
              onclick={() => (activeCategoryId = cat.id)}
            >
              <Icon class="size-5 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate font-medium">
                {tLabel('categories', cat.id)}
              </span>
              <ChevronRight class="size-4 shrink-0 text-muted-foreground" />
            </button>
          {/each}
        </nav>
      {:else}
        <!-- ====================== Category detail ====================== -->
        <header
          class="grid h-14 shrink-0 grid-cols-[2.75rem_1fr_2.75rem] items-center border-b border-border bg-card px-1.5"
        >
          <button
            type="button"
            class="flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onclick={back}
            aria-label={tUi('back')}
            title={tUi('back')}
          >
            <ArrowLeft class="size-5" />
          </button>
          <Dialog.Title class="truncate text-center text-base font-semibold">
            {pageTitle}
          </Dialog.Title>
          <Dialog.Close
            class="flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={tUi('close')}
          >
            <X class="size-5" />
          </Dialog.Close>
        </header>

        <section class="flex-1 overflow-y-auto pb-6">
          {#if isPluginsCategory && !activePluginId}
            <!-- The plugin list; each plugin's gear opens its own page. -->
            <div class="px-4 pt-6">
              <PluginsOverview
                onOpenSettings={(id: string) => (activePluginId = id)}
              />
            </div>
          {:else if pageDescription}
            <p class="px-4 pt-6 text-sm text-muted-foreground">
              {pageDescription}
            </p>
          {:else if !isPluginsCategory && visibleSettings(activeCategory).length === 0}
            <p class="px-4 py-6 text-center text-sm text-muted-foreground">
              {tUi('empty')}
            </p>
          {/if}
          {#each pageSections as sec (sec.id)}
            {@const sectionSettings = isSectionVisible(sec)
              ? sec.settings.filter((s) => isVisible(s))
              : []}
            {#if sectionSettings.length > 0}
              <!-- Rows run full width with a divider between them, like the
                   category list, under a small section label. -->
              <div id="plugins-section-{sec.id}">
                <h3
                  class="px-4 pb-1 pt-6 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {tLabel('sections', sec.id)}
                </h3>
                <div class="divide-y divide-border border-b border-border px-4">
                  {#each sectionSettings as s (s.id)}
                    <SettingControl setting={s} />
                  {/each}
                </div>
              </div>
            {/if}
          {/each}
          {#if isPluginsCategory && activePluginId}
            <div class="mb-6 px-4 pt-6">
              <PluginNativeToolsSection pluginId={activePluginId} />
              <PluginTextCheckersSection pluginId={activePluginId} />
            </div>
          {/if}
        </section>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
