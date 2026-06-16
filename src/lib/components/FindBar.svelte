<script lang="ts">
  /**
   * Generic find-in-document bar. Presentational only — the host owns the
   * matching and feeds back the count and active index. Enter /
   * Shift+Enter step through matches; Escape closes.
   *
   * Editor-agnostic on purpose so any note kind (PDF today, the markdown
   * editor next) can reuse it. Labels come from the shared `find.*` i18n
   * keys; pass `placeholder` to override the field's prompt per context.
   */

  import {
    ChevronDown,
    ChevronUp,
    Loader2,
    TextSearch,
    X
  } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import { tUi } from '$lib/settings/i18n.svelte';

  interface Props {
    query: string;
    matchCount: number;
    activeIndex: number;
    busy: boolean;
    placeholder?: string;
    onInput: (value: string) => void;
    onNext: () => void;
    onPrevious: () => void;
    onClose: () => void;
  }
  let {
    query,
    matchCount,
    activeIndex,
    busy,
    placeholder,
    onInput,
    onNext,
    onPrevious,
    onClose
  }: Props = $props();

  let inputEl = $state<HTMLInputElement | null>(null);

  export function focus() {
    inputEl?.focus();
    inputEl?.select();
  }

  const fieldPlaceholder = $derived(placeholder ?? tUi('find.placeholder'));
  const hasQuery = $derived(query.trim().length > 0);

  const countLabel = $derived.by(() => {
    if (busy) return tUi('find.searching');
    if (!hasQuery) return '';
    if (matchCount === 0) return tUi('find.noResults');
    return tUi('find.count')
      .replace('{index}', String(activeIndex + 1))
      .replace('{total}', String(matchCount));
  });

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) onPrevious();
      else onNext();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }
</script>

<div
  class="flex shrink-0 items-center gap-1 border-b border-border bg-background px-2 py-1.5"
  role="search"
>
  <div class="relative flex flex-1 items-center">
    <TextSearch
      class="pointer-events-none absolute left-2 size-3.5 text-muted-foreground"
      aria-hidden="true"
    />
    <input
      bind:this={inputEl}
      type="text"
      value={query}
      placeholder={fieldPlaceholder}
      aria-label={fieldPlaceholder}
      class="h-7 w-full rounded-md border border-border bg-background pl-7 pr-2 text-xs outline-none focus:ring-1 focus:ring-ring"
      oninput={(event) =>
        onInput((event.currentTarget as HTMLInputElement).value)}
      onkeydown={handleKeydown}
    />
  </div>

  <span
    class="min-w-16 shrink-0 px-1 text-right text-[11px] tabular-nums text-muted-foreground"
  >
    {#if busy}
      <Loader2 class="ml-auto size-3 animate-spin" aria-hidden="true" />
    {:else}
      {countLabel}
    {/if}
  </span>

  <Button
    variant="ghost"
    size="icon"
    class="size-7 text-muted-foreground"
    disabled={matchCount === 0}
    onclick={onPrevious}
    aria-label={tUi('find.previous')}
    title={tUi('find.previous')}
  >
    <ChevronUp class="size-3.5" aria-hidden="true" />
  </Button>
  <Button
    variant="ghost"
    size="icon"
    class="size-7 text-muted-foreground"
    disabled={matchCount === 0}
    onclick={onNext}
    aria-label={tUi('find.next')}
    title={tUi('find.next')}
  >
    <ChevronDown class="size-3.5" aria-hidden="true" />
  </Button>
  <Button
    variant="ghost"
    size="icon"
    class="size-7 text-muted-foreground"
    onclick={onClose}
    aria-label={tUi('find.close')}
    title={tUi('find.close')}
  >
    <X class="size-3.5" aria-hidden="true" />
  </Button>
</div>
