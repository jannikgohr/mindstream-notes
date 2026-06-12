<script lang="ts">
  /**
   * Result-of-export summary dialog. Renders a tinted header strip with
   * an animated PartyPopper + title, then a 2-column grid of per-kind
   * count chips below.
   *
   * Chip rules: Notes (markdown) is always shown as the headline metric;
   * the rest render only when their count is > 0 so the dialog doesn't
   * shout about non-events ("0 Diagrams" when the vault has none).
   *
   * Icons match the rest of the app — note-kind glyphs come straight
   * from `note-kind-icon.ts` so the chip and the file tree agree on what
   * a Diagram or an Ink note looks like.
   *
   * The chip palette uses static Tailwind class strings so the JIT picks
   * them up — see the chips array below. Adding a new chip means a new
   * config entry plus the corresponding i18n keys.
   */

  import { AlertDialog } from 'bits-ui';
  import {
    AlertTriangle,
    Feather,
    FileText,
    FileType2,
    Paperclip,
    PartyPopper,
    PencilRuler
  } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import { exportResultQueue } from './export-result-dialog.svelte';
  import { openFolder } from '$lib/api';
  import { tUi } from '$lib/settings/i18n.svelte';
  import type { Component } from 'svelte';

  type IconComponent = Component<{ class?: string }>;

  interface Chip {
    /** The big number shown in the chip. */
    count: number;
    /** Label after the count — picks singular/plural based on count. */
    oneKey: string;
    otherKey: string;
    /** Uppercase status line under the count (key into the i18n bundle). */
    statusKey: string;
    /** Per-kind glyph rendered next to the count. */
    icon: IconComponent;
    /** Tailwind classes for the chip's tinted background + border. */
    boxClass: string;
    /** Tailwind classes for the status line + icon's coloured text. */
    statusClass: string;
    /** When false, the chip is hidden. Notes uses `true`; everything
     *  else uses `count > 0` so the dialog stays focused. */
    show: boolean;
  }

  const current = $derived(exportResultQueue.items[0] ?? null);

  const chips: Chip[] = $derived.by(() => {
    if (!current) return [];
    const r = current.report;
    return [
      {
        count: r.markdown_written,
        oneKey: 'data.exportVault.chip.notes.one',
        otherKey: 'data.exportVault.chip.notes.other',
        statusKey: 'data.exportVault.chip.notes.status',
        icon: FileText as unknown as IconComponent,
        boxClass: 'border-emerald-500/30 bg-emerald-500/10',
        statusClass: 'text-emerald-700 dark:text-emerald-400',
        show: true
      },
      {
        count: r.pdf_written,
        oneKey: 'data.exportVault.chip.pdfs.one',
        otherKey: 'data.exportVault.chip.pdfs.other',
        statusKey: 'data.exportVault.chip.pdfs.status',
        icon: FileType2 as unknown as IconComponent,
        boxClass: 'border-sky-500/30 bg-sky-500/10',
        statusClass: 'text-sky-700 dark:text-sky-400',
        show: r.pdf_written > 0
      },
      {
        count: r.ink_written,
        oneKey: 'data.exportVault.chip.inkNotes.one',
        otherKey: 'data.exportVault.chip.inkNotes.other',
        statusKey: 'data.exportVault.chip.inkNotes.status',
        icon: Feather as unknown as IconComponent,
        boxClass: 'border-amber-500/30 bg-amber-500/10',
        statusClass: 'text-amber-700 dark:text-amber-400',
        show: r.ink_written > 0
      },
      {
        count: r.freeform_written,
        oneKey: 'data.exportVault.chip.diagrams.one',
        otherKey: 'data.exportVault.chip.diagrams.other',
        statusKey: 'data.exportVault.chip.diagrams.status',
        icon: PencilRuler as unknown as IconComponent,
        boxClass: 'border-violet-500/30 bg-violet-500/10',
        statusClass: 'text-violet-700 dark:text-violet-400',
        show: r.freeform_written > 0
      },
      {
        count: r.assets_written,
        oneKey: 'data.exportVault.chip.attachments.one',
        otherKey: 'data.exportVault.chip.attachments.other',
        statusKey: 'data.exportVault.chip.attachments.status',
        icon: Paperclip as unknown as IconComponent,
        boxClass: 'border-teal-500/30 bg-teal-500/10',
        statusClass: 'text-teal-700 dark:text-teal-400',
        show: r.assets_written > 0
      },
      {
        count: r.errors,
        oneKey: 'data.exportVault.chip.errors.one',
        otherKey: 'data.exportVault.chip.errors.other',
        statusKey: 'data.exportVault.chip.errors.status',
        icon: AlertTriangle as unknown as IconComponent,
        boxClass: 'border-destructive/30 bg-destructive/10',
        statusClass: 'text-destructive',
        show: r.errors > 0
      }
    ];
  });

  const visibleChips = $derived(chips.filter((c) => c.show));

  function resolveCurrent() {
    const item = exportResultQueue.items[0];
    if (!item) return;
    exportResultQueue.items = exportResultQueue.items.slice(1);
    item.resolve();
  }

  function plural(n: number, oneKey: string, otherKey: string): string {
    return n === 1 ? tUi(oneKey) : tUi(otherKey);
  }

  async function openLocation(path: string) {
    try {
      await openFolder(path);
    } catch (err) {
      // Best-effort — failure here just means the file manager didn't
      // open; the dialog already told the user where the files went.
      console.error('[export-result] open_folder failed', err);
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
        <!--
          Header strip: tinted emerald band that distinguishes the title
          from the body. The PartyPopper waves on mount and then settles
          into a slow loop — celebratory without being distracting.
        -->
        <div
          class="flex items-center gap-3 border-b border-emerald-500/20 bg-emerald-500/10 px-5 py-4"
        >
          <span
            class="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
          >
            <PartyPopper class="size-5 animate-party-wave" />
          </span>
          <AlertDialog.Title class="text-lg font-semibold tracking-tight">
            {tUi('data.exportVault.success.title')}
          </AlertDialog.Title>
        </div>

        <div class="p-5">
          <div class="grid grid-cols-2 gap-2">
            {#each visibleChips as chip (chip.statusKey)}
              {@const Icon = chip.icon}
              <div class="rounded-lg border px-2.5 py-1.5 {chip.boxClass}">
                <div
                  class="flex items-center gap-1.5 text-base font-semibold leading-tight"
                >
                  <Icon class="size-4 shrink-0 {chip.statusClass}" />
                  <span class="truncate">
                    {chip.count}
                    {plural(chip.count, chip.oneKey, chip.otherKey)}
                  </span>
                </div>
                <div
                  class="mt-0.5 text-[10px] font-semibold uppercase tracking-wider {chip.statusClass}"
                >
                  {tUi(chip.statusKey)}
                </div>
              </div>
            {/each}
          </div>

          <div class="mt-4">
            <div
              class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              {tUi('data.exportVault.savedTo')}
            </div>
            <div
              class="mt-1 break-all rounded border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs"
            >
              {current.destination}
            </div>
          </div>

          <div class="mt-5 flex justify-end gap-2">
            <Button
              variant="outline"
              onclick={() => void openLocation(current.destination)}
            >
              {tUi('data.exportVault.openLocation')}
            </Button>
            <AlertDialog.Action onclick={resolveCurrent}>
              {#snippet child({ props })}
                <Button variant="default" {...props}>
                  {tUi('data.exportVault.close')}
                </Button>
              {/snippet}
            </AlertDialog.Action>
          </div>
        </div>
      {/if}
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>

<!--
  The `.animate-party-wave` class — including its `prefers-reduced-motion`
  override — lives in `src/app.css`. `:global()` inside a Svelte `<style>`
  block doesn't reliably carry an @media rule through the scoping
  pipeline, so the reduce-motion preference would silently fail here.
-->
