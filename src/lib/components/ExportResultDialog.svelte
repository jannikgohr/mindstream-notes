<script lang="ts">
  /**
   * Singleton result summary for Data settings actions. Export, backup,
   * merge, and restore share this visual shell through the queue in the
   * sibling `.svelte.ts` file.
   */

  import { AlertDialog } from 'bits-ui';
  import {
    AlertTriangle,
    Archive,
    Cloud,
    Feather,
    FileText,
    FileType2,
    Folder,
    GitMerge,
    HardDrive,
    Paperclip,
    PartyPopper,
    PencilRuler,
    RotateCcw
  } from 'lucide-svelte';
  import { Archive as JisArchive } from '@jis3r/icons';
  import PartyPopperAnimated from './PartyPopperAnimated.svelte';
  import { Button } from '$lib/components/ui/button';
  import { exportResultQueue } from './export-result-dialog.svelte';
  import type {
    DataResultChip,
    DataResultIcon,
    DataResultTone
  } from './export-result-dialog.svelte';
  import { openFolder } from '$lib/api';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { getSettingValue } from '$lib/settings/store.svelte';
  import type { Component } from 'svelte';

  // Mirror the in-app `appearance.reduceMotion` toggle. The CSS in
  // `app.css` already disables the OS-level case via media query; this
  // covers the one place we trigger animation programmatically
  // (the header-icon one-shot), so the toggle in Settings actually
  // suppresses it.
  const reduceMotion = $derived(
    getSettingValue('appearance.reduceMotion') === true
  );

  type IconComponent = Component<{ class?: string }>;

  // Header-strip icon plays a one-shot animation a moment after the
  // dialog finishes its open-fade — long enough that the user's eye
  // has landed on it, short enough to still register as a reaction
  // to the action they just took. Re-armed by the keyed reactive
  // tying to whatever queue item is currently on top.
  const ANIMATE_DELAY_MS = 350;
  let headerAnimate = $state(false);
  $effect(() => {
    // Track the current item so the effect re-runs when the queue
    // pops to a new one. Reset to false synchronously, then arm.
    void exportResultQueue.items[0];
    headerAnimate = false;
    if (!exportResultQueue.items[0]) return;
    if (reduceMotion) return;
    const handle = setTimeout(() => {
      headerAnimate = true;
    }, ANIMATE_DELAY_MS);
    return () => clearTimeout(handle);
  });

  const iconMap: Record<DataResultIcon, IconComponent> = {
    archive: Archive as unknown as IconComponent,
    alertTriangle: AlertTriangle as unknown as IconComponent,
    cloud: Cloud as unknown as IconComponent,
    feather: Feather as unknown as IconComponent,
    fileText: FileText as unknown as IconComponent,
    fileType: FileType2 as unknown as IconComponent,
    folder: Folder as unknown as IconComponent,
    gitMerge: GitMerge as unknown as IconComponent,
    hardDrive: HardDrive as unknown as IconComponent,
    paperclip: Paperclip as unknown as IconComponent,
    partyPopper: PartyPopper as unknown as IconComponent,
    pencilRuler: PencilRuler as unknown as IconComponent,
    rotateCcw: RotateCcw as unknown as IconComponent
  };

  const toneClasses: Record<
    DataResultTone,
    { box: string; text: string; header: string; headerIcon: string }
  > = {
    emerald: {
      box: 'border-emerald-500/30 bg-emerald-500/10',
      text: 'text-emerald-700 dark:text-emerald-400',
      header: 'border-emerald-500/20 bg-emerald-500/10',
      headerIcon: 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300'
    },
    sky: {
      box: 'border-sky-500/30 bg-sky-500/10',
      text: 'text-sky-700 dark:text-sky-400',
      header: 'border-sky-500/20 bg-sky-500/10',
      headerIcon: 'bg-sky-500/20 text-sky-700 dark:text-sky-300'
    },
    amber: {
      box: 'border-amber-500/30 bg-amber-500/10',
      text: 'text-amber-700 dark:text-amber-400',
      header: 'border-amber-500/20 bg-amber-500/10',
      headerIcon: 'bg-amber-500/20 text-amber-700 dark:text-amber-300'
    },
    violet: {
      box: 'border-violet-500/30 bg-violet-500/10',
      text: 'text-violet-700 dark:text-violet-400',
      header: 'border-violet-500/20 bg-violet-500/10',
      headerIcon: 'bg-violet-500/20 text-violet-700 dark:text-violet-300'
    },
    teal: {
      box: 'border-teal-500/30 bg-teal-500/10',
      text: 'text-teal-700 dark:text-teal-400',
      header: 'border-teal-500/20 bg-teal-500/10',
      headerIcon: 'bg-teal-500/20 text-teal-700 dark:text-teal-300'
    },
    destructive: {
      box: 'border-destructive/30 bg-destructive/10',
      text: 'text-destructive',
      header: 'border-destructive/20 bg-destructive/10',
      headerIcon: 'bg-destructive/20 text-destructive'
    }
  };

  const current = $derived(exportResultQueue.items[0] ?? null);
  const visibleChips = $derived(
    current?.chips.filter((chip) => chip.show !== false) ?? []
  );

  function resolveCurrent(action?: string) {
    const item = exportResultQueue.items[0];
    if (!item) return;
    exportResultQueue.items = exportResultQueue.items.slice(1);
    item.resolve(action ?? item.defaultAction ?? 'close');
  }

  function plural(n: number, oneKey: string, otherKey: string): string {
    return n === 1 ? tUi(oneKey) : tUi(otherKey);
  }

  function replaceValues(
    key: string,
    values: Record<string, string | number | boolean> | undefined
  ): string {
    let text = tUi(key);
    for (const [name, value] of Object.entries(values ?? {})) {
      text = text.replace(`{${name}}`, String(value));
    }
    return text;
  }

  function chipValue(chip: DataResultChip): string {
    if (chip.countTextKey) return tUi(chip.countTextKey);
    if (chip.countText) return chip.countText;
    return String(chip.count ?? 0);
  }

  function chipLabel(chip: DataResultChip): string {
    if (typeof chip.count === 'number' && chip.oneKey && chip.otherKey) {
      return plural(chip.count, chip.oneKey, chip.otherKey);
    }
    return chip.labelKey ? tUi(chip.labelKey) : '';
  }

  async function openLocation(path: string) {
    try {
      await openFolder(path);
    } catch (err) {
      console.error('[data-result] open_folder failed', err);
    }
  }
</script>

<AlertDialog.Root
  open={current !== null}
  onOpenChange={(open: boolean) => {
    if (!open) resolveCurrent();
  }}
>
  <AlertDialog.Portal>
    <AlertDialog.Overlay
      class="fixed inset-0 z-[400] bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
    />
    <AlertDialog.Content
      class="fixed left-1/2 top-1/2 z-[400] w-[min(480px,94vw)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-xl focus:outline-none"
    >
      {#if current}
        {@const HeaderIcon = iconMap[current.headerIcon]}
        <div
          class="flex items-center gap-3 border-b px-5 py-4 {toneClasses[
            current.tone
          ].header}"
        >
          <span
            class="inline-flex size-9 shrink-0 items-center justify-center rounded-full {toneClasses[
              current.tone
            ].headerIcon}"
          >
            {#if current.headerIcon === 'partyPopper'}
              <!-- Svelte port of pqoqubbw/icons' party-popper. -->
              <PartyPopperAnimated size={20} animate={headerAnimate} />
            {:else if current.headerIcon === 'archive'}
              <!-- jis3r/icons animated archive. -->
              <JisArchive size={20} animate={headerAnimate} />
            {:else}
              <HeaderIcon class="size-5" />
            {/if}
          </span>
          <div>
            <AlertDialog.Title class="text-lg font-semibold tracking-tight">
              {tUi(current.titleKey)}
            </AlertDialog.Title>
            {#if current.descriptionKey}
              <AlertDialog.Description
                class="mt-1 text-sm text-muted-foreground"
              >
                {replaceValues(
                  current.descriptionKey,
                  current.descriptionValues
                )}
              </AlertDialog.Description>
            {/if}
          </div>
        </div>

        <div class="p-5">
          <div class="grid grid-cols-2 gap-2">
            {#each visibleChips as chip (chip.statusKey)}
              {@const Icon = iconMap[chip.icon]}
              <div
                class="rounded-lg border px-2.5 py-1.5 {toneClasses[chip.tone]
                  .box}"
              >
                <div
                  class="flex items-center gap-1.5 text-base font-semibold leading-tight"
                >
                  <Icon class="size-4 shrink-0 {toneClasses[chip.tone].text}" />
                  <span class="truncate">
                    {chipValue(chip)}
                    {#if chipLabel(chip)}
                      {' '}{chipLabel(chip)}
                    {/if}
                  </span>
                </div>
                <div
                  class="mt-0.5 text-[10px] font-semibold uppercase tracking-wider {toneClasses[
                    chip.tone
                  ].text}"
                >
                  {tUi(chip.statusKey)}
                </div>
              </div>
            {/each}
          </div>

          {#if current.location}
            <div class="mt-4">
              <div
                class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {tUi(current.location.labelKey)}
              </div>
              <div
                class="mt-1 break-all rounded border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs"
              >
                {current.location.path}
              </div>
            </div>
          {/if}

          <div class="mt-5 flex flex-wrap justify-end gap-2">
            {#if current.location}
              <Button
                variant="outline"
                onclick={() =>
                  void openLocation(
                    current.location!.openPath ?? current.location!.path
                  )}
              >
                {tUi(current.location.actionLabelKey)}
              </Button>
            {/if}
            {#if current.secondaryAction}
              <AlertDialog.Cancel
                onclick={() => resolveCurrent(current.secondaryAction?.value)}
              >
                {#snippet child({ props })}
                  <Button
                    variant={current.secondaryAction?.variant ?? 'ghost'}
                    {...props}
                  >
                    {tUi(current.secondaryAction!.labelKey)}
                  </Button>
                {/snippet}
              </AlertDialog.Cancel>
            {/if}
            <AlertDialog.Action
              onclick={() => resolveCurrent(current.primaryAction?.value)}
            >
              {#snippet child({ props })}
                <Button
                  variant={current.primaryAction?.variant ?? 'default'}
                  {...props}
                >
                  {tUi(current.primaryAction?.labelKey ?? 'data.result.close')}
                </Button>
              {/snippet}
            </AlertDialog.Action>
          </div>
        </div>
      {/if}
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>
