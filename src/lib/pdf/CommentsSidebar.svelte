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

  import { Trash2 } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import type { PdfAnnotation } from './types';

  interface Props {
    annotations: PdfAnnotation[];
    selectedAnnotationId: string | null;
    isTrashed: boolean;
    onJump: (id: string) => void;
    onUpdate: (id: string, patch: Partial<PdfAnnotation>) => void;
    onDelete: (id: string) => void;
  }
  let {
    annotations,
    selectedAnnotationId,
    isTrashed,
    onJump,
    onUpdate,
    onDelete
  }: Props = $props();
</script>

<aside
  class="themed-scrollbar flex w-[min(20rem,80vw)] shrink-0 flex-col overflow-auto border-l border-border bg-background"
  aria-label="PDF comments"
>
  <div
    class="flex h-9 shrink-0 items-center justify-between border-b border-border px-3"
  >
    <div class="text-xs font-medium text-muted-foreground">Comments</div>
    <div class="text-[10px] text-muted-foreground">{annotations.length}</div>
  </div>

  {#if annotations.length === 0}
    <div class="px-3 py-4 text-xs text-muted-foreground">No comments yet.</div>
  {:else}
    <div class="flex flex-col gap-2 p-2">
      {#each annotations as annotation (annotation.id)}
        <section
          class:ring-1={selectedAnnotationId === annotation.id}
          class:ring-ring={selectedAnnotationId === annotation.id}
          class="rounded-md border border-border bg-card p-2 text-card-foreground"
        >
          <button
            type="button"
            class="flex w-full items-center justify-between gap-2 text-left"
            onclick={() => onJump(annotation.id)}
          >
            <span class="text-xs font-medium">
              Page {annotation.pageIndex + 1}
            </span>
            <span
              class="rounded-sm px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground"
            >
              {annotation.type}
            </span>
          </button>

          <textarea
            class="mt-2 min-h-20 w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none transition-colors placeholder:text-muted-foreground focus:border-ring disabled:cursor-not-allowed disabled:opacity-60"
            value={annotation.body ?? ''}
            placeholder="Comment"
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
              {annotation.resolved ? 'Resolved' : 'Resolve'}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              class="size-7 text-muted-foreground hover:text-destructive"
              disabled={isTrashed}
              onclick={() => onDelete(annotation.id)}
              aria-label="Delete comment"
              title="Delete comment"
            >
              <Trash2 class="size-3.5" aria-hidden="true" />
            </Button>
          </div>
        </section>
      {/each}
    </div>
  {/if}
</aside>
