<script lang="ts">
  /**
   * Mobile settings shell. Two full-screen views driven by
   * `activeCategoryId`:
   *
   *   null         — list of categories, each a tappable row.
   *   <category>   — that category's sections + settings, with a back
   *                  arrow in the header that returns to the list.
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

  let activeCategoryId = $state<string | null>(null);

  const visibleCategories = $derived(
    SCHEMA.categories.filter(isCategoryVisible)
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

  function categoryIcon(name: string | undefined) {
    if (!name) return FALLBACK_ICON;
    return SETTINGS_ICONS[name] ?? FALLBACK_ICON;
  }

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
    <Dialog.Content
      class="safe-top safe-bottom safe-x fixed inset-0 z-50 flex flex-col bg-background text-foreground focus:outline-none"
    >
      {#if activeCategory === null}
        <!-- ====================== Category list ====================== -->
        <header
          class="flex h-12 shrink-0 items-center justify-between border-b border-border bg-card px-2"
        >
          <div class="w-9 shrink-0"></div>
          <Dialog.Title class="truncate text-sm font-semibold">
            {tUi('title')}
          </Dialog.Title>
          <Dialog.Close
            class="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
              class="flex w-full items-center gap-3 border-b border-border px-4 py-3.5 text-left text-sm transition-colors hover:bg-accent"
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
          class="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-card px-2"
        >
          <button
            type="button"
            class="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onclick={() => (activeCategoryId = null)}
            aria-label={tUi('back')}
            title={tUi('back')}
          >
            <ArrowLeft class="size-5" />
          </button>
          <Dialog.Title class="min-w-0 flex-1 truncate text-sm font-semibold">
            {tLabel('categories', activeCategory.id)}
          </Dialog.Title>
          <Dialog.Close
            class="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={tUi('close')}
          >
            <X class="size-5" />
          </Dialog.Close>
        </header>

        <section class="flex-1 overflow-y-auto px-4 py-4">
          {#if visibleSettings(activeCategory).length === 0}
            <p class="px-1 py-6 text-center text-sm text-muted-foreground">
              {tUi('empty')}
            </p>
          {/if}
          {#each activeCategory.sections as sec (sec.id)}
            {@const sectionSettings = isSectionVisible(sec)
              ? sec.settings.filter((s) => isVisible(s))
              : []}
            {#if sectionSettings.length > 0}
              <div class="mb-6">
                <h3
                  class="mb-2 border-b border-border pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {tLabel('sections', sec.id)}
                </h3>
                <div class="divide-y divide-border">
                  {#each sectionSettings as s (s.id)}
                    <SettingControl setting={s} />
                  {/each}
                </div>
              </div>
            {/if}
          {/each}
        </section>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
