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

  import {
    ChevronDown,
    ChevronRight,
    CircleCheckBig,
    Trash2,
    X
  } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import { formatNoteDateTime } from '$lib/date-time';
  import { tUi } from '$lib/settings/i18n.svelte';
  import type { PdfAnnotation } from './types';

  interface Props {
    annotations: PdfAnnotation[];
    selectedAnnotationId: string | null;
    isTrashed: boolean;
    /** Etebase username of the local user; their comments read as "You". */
    currentAuthorId: string;
    /** Comment whose editor should grab focus once rendered, then clear. */
    autofocusId: string | null;
    onJump: (id: string) => void;
    onUpdate: (id: string, patch: Partial<PdfAnnotation>) => void;
    onDelete: (id: string) => void;
    onAutofocusHandled: () => void;
    onClose: () => void;
  }
  let {
    annotations,
    selectedAnnotationId,
    isTrashed,
    currentAuthorId,
    autofocusId,
    onJump,
    onUpdate,
    onDelete,
    onAutofocusHandled,
    onClose
  }: Props = $props();

  // Focus a freshly-created comment's editor once it lands in the DOM,
  // then tell the parent so it doesn't re-fire on the next render.
  $effect(() => {
    const id = autofocusId;
    if (!id) return;
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLTextAreaElement>(
        `textarea[data-comment-id="${CSS.escape(id)}"]`
      );
      if (el) {
        el.focus();
        onAutofocusHandled();
      }
    });
  });

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

  const jumpLabel = (page: number) =>
    tUi('pdf.comments.jump').replace('{page}', String(page));

  const authorName = (authorId: string) =>
    authorId === 'local' || authorId === currentAuthorId
      ? tUi('pdf.comments.you')
      : authorId;

  const initialsFor = (authorId: string) =>
    authorName(authorId)
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || '?';

  const updatedLabel = (updatedAt: string) => formatNoteDateTime(updatedAt);
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
  {@const label = annotation.resolved
    ? tUi('pdf.comments.resolved')
    : tUi('pdf.comments.resolve')}
  {@const updated = updatedLabel(annotation.updatedAt)}
  <section
    class:border-ring={selectedAnnotationId === annotation.id}
    class:shadow-md={selectedAnnotationId === annotation.id}
    class:opacity-75={annotation.resolved}
    class="comment-card rounded-md border border-l-4 border-border bg-card text-card-foreground shadow-sm transition-colors"
    style:--comment-accent={annotation.color}
  >
    <div class="flex items-start gap-2 px-3 pb-2 pt-3">
      <button
        type="button"
        class="flex min-w-0 flex-1 items-start gap-2 text-left"
        onclick={() => onJump(annotation.id)}
        aria-label={jumpLabel(annotation.pageIndex + 1)}
      >
        <span
          class="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground"
          aria-hidden="true"
        >
          {initialsFor(annotation.authorId)}
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-xs font-semibold leading-none">
            {authorName(annotation.authorId)}
          </span>
          <span
            class="mt-1 flex items-center gap-1 text-[10px] leading-none text-muted-foreground"
          >
            <span>{pageLabel(annotation.pageIndex + 1)}</span>
            {#if updated}
              <span aria-hidden="true">·</span>
              <span>{updated}</span>
            {/if}
          </span>
        </span>
      </button>

      <div class="flex shrink-0 items-center gap-1">
        <Button
          variant={annotation.resolved ? 'secondary' : 'ghost'}
          size="sm"
          class="h-7 max-w-24 gap-1.5 px-2 text-xs"
          disabled={isTrashed}
          onclick={() =>
            onUpdate(annotation.id, { resolved: !annotation.resolved })}
          aria-label={label}
          title={label}
          aria-pressed={annotation.resolved}
        >
          <CircleCheckBig class="size-3.5 shrink-0" aria-hidden="true" />
          <span class="resolve-label truncate">{label}</span>
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
    </div>

    <textarea
      data-comment-id={annotation.id}
      class="min-h-16 w-full resize-y border-t border-border bg-transparent px-3 py-2 text-xs leading-relaxed outline-none transition-colors placeholder:text-muted-foreground focus:bg-background disabled:cursor-not-allowed disabled:opacity-60"
      value={annotation.body ?? ''}
      placeholder={tUi('pdf.comments.placeholder')}
      disabled={isTrashed}
      oninput={(event) =>
        onUpdate(annotation.id, {
          body: (event.currentTarget as HTMLTextAreaElement).value
        })}
    ></textarea>
  </section>
{/snippet}

<style>
  .comment-card {
    container-type: inline-size;
    border-left-color: var(--comment-accent);
  }

  .resolve-label {
    display: none;
  }

  @container (min-width: 18rem) {
    .resolve-label {
      display: inline;
    }
  }
</style>
