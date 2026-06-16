<script lang="ts">
  /**
   * Right-hand sidebar listing comment-like annotations (`comment`
   * annotations and `highlight`s that have a body). Owns presentation
   * only — all annotation mutations go through callbacks so the
   * parent keeps a single source of truth for the Yjs map.
   *
   * Selection is bidirectional: clicking a card calls `onJump(id)`,
   * which the parent uses to scroll the page into view and highlight
   * the annotation on the canvas. The card itself highlights when
   * `selectedAnnotationId === annotation.id`.
   */

  import { ChevronDown, ChevronRight, Trash2, X } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import { tUi } from '$lib/settings/i18n.svelte';
  import type { PdfAnnotation } from './types';

  interface Props {
    annotations: PdfAnnotation[];
    selectedAnnotationId: string | null;
    isTrashed: boolean;
    onJump: (id: string) => void;
    onUpdate: (id: string, patch: Partial<PdfAnnotation>) => void;
    onDelete: (id: string) => void;
    onClose: () => void;
  }
  let {
    annotations,
    selectedAnnotationId,
    isTrashed,
    onJump,
    onUpdate,
    onDelete,
    onClose
  }: Props = $props();

  let resolvedOpen = $state(false);

  let openAnnotations = $derived(
    annotations.filter((annotation) => !annotation.resolved)
  );
  let resolvedAnnotations = $derived(
    annotations.filter((annotation) => annotation.resolved)
  );

  const withCount = (key: Parameters<typeof tUi>[0], count: number) =>
    tUi(key).replace('{count}', String(count));

  const pageLabel = (page: number) =>
    tUi('pdf.comments.page').replace('{page}', String(page));
</script>

<aside
  class="flex w-[min(20rem,80vw)] shrink-0 flex-col overflow-hidden border-l border-border bg-background"
  aria-label={tUi('pdf.comments.label')}
>
  <div
    class="flex h-9 shrink-0 items-center justify-between border-b border-border px-3"
  >
    <div class="text-xs font-medium text-muted-foreground">
      {withCount('pdf.comments.title', annotations.length)}
    </div>
    <Button
      variant="ghost"
      size="icon"
      class="size-7 text-muted-foreground"
      onclick={onClose}
      aria-label={tUi('pdf.comments.close')}
      title={tUi('pdf.comments.close')}
    >
      <X class="size-3.5" aria-hidden="true" />
    </Button>
  </div>

  <div class="themed-scrollbar flex min-h-0 flex-1 flex-col overflow-auto">
    {#if annotations.length === 0}
      <div class="px-3 py-4 text-xs text-muted-foreground">
        {tUi('pdf.comments.empty')}
      </div>
    {:else}
      <div class="flex flex-col gap-2 p-2">
        {#if openAnnotations.length === 0}
          <div class="px-1 py-2 text-xs text-muted-foreground">
            {tUi('pdf.comments.noOpen')}
          </div>
        {:else}
          {#each openAnnotations as annotation (annotation.id)}
            {@render commentCard(annotation)}
          {/each}
        {/if}
      </div>

      {#if resolvedAnnotations.length > 0}
        <div class="border-t border-border">
          <button
            type="button"
            class="flex h-9 w-full items-center justify-between gap-2 px-3 text-left text-xs font-medium text-muted-foreground hover:bg-muted/60"
            onclick={() => (resolvedOpen = !resolvedOpen)}
            aria-expanded={resolvedOpen}
          >
            <span>
              {withCount(
                resolvedOpen
                  ? 'pdf.comments.hideResolved'
                  : 'pdf.comments.showResolved',
                resolvedAnnotations.length
              )}
            </span>
            {#if resolvedOpen}
              <ChevronDown class="size-3.5" aria-hidden="true" />
            {:else}
              <ChevronRight class="size-3.5" aria-hidden="true" />
            {/if}
          </button>

          {#if resolvedOpen}
            <div class="flex flex-col gap-2 p-2">
              {#each resolvedAnnotations as annotation (annotation.id)}
                {@render commentCard(annotation)}
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    {/if}
  </div>
</aside>

{#snippet commentCard(annotation: PdfAnnotation)}
  <section
    class:ring-1={selectedAnnotationId === annotation.id}
    class:ring-ring={selectedAnnotationId === annotation.id}
    class:opacity-75={annotation.resolved}
    class="rounded-md border border-border bg-card p-2 text-card-foreground"
  >
    <button
      type="button"
      class="flex w-full items-center justify-between gap-2 text-left"
      onclick={() => onJump(annotation.id)}
    >
      <span class="text-xs font-medium"
        >{pageLabel(annotation.pageIndex + 1)}</span
      >
      <span
        class="rounded-sm px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground"
      >
        {annotation.type}
      </span>
    </button>

    <textarea
      class="mt-2 min-h-20 w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none transition-colors placeholder:text-muted-foreground focus:border-ring disabled:cursor-not-allowed disabled:opacity-60"
      value={annotation.body ?? ''}
      placeholder={tUi('pdf.comments.placeholder')}
      disabled={isTrashed}
      oninput={(event) =>
        onUpdate(annotation.id, {
          body: (event.currentTarget as HTMLTextAreaElement).value
        })}
    ></textarea>

    <div class="mt-2 flex items-center justify-between gap-2">
      <Button
        variant={annotation.resolved ? 'secondary' : 'ghost'}
        size="sm"
        class="h-7 px-2 text-xs"
        disabled={isTrashed}
        onclick={() =>
          onUpdate(annotation.id, { resolved: !annotation.resolved })}
      >
        {annotation.resolved
          ? tUi('pdf.comments.resolved')
          : tUi('pdf.comments.resolve')}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        class="size-7 text-muted-foreground hover:text-destructive"
        disabled={isTrashed}
        onclick={() => onDelete(annotation.id)}
        aria-label={tUi('pdf.comments.delete')}
        title={tUi('pdf.comments.delete')}
      >
        <Trash2 class="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  </section>
{/snippet}
