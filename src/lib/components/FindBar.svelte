<script lang="ts">
  /**
   * Generic find-in-document bar, modelled on VS Code's editor search
   * widget. Presentational only — the host owns the matching and feeds
   * back the count and active index. Enter / Shift+Enter step through
   * matches; Escape closes.
   *
   * Two modes:
   *   - **Find only** (PDF viewer): query field + prev/next/close.
   *   - **Find & replace** (markdown editor): pass the `onReplace` /
   *     `onReplaceAll` callbacks and the bar grows a left-hand expand
   *     toggle that reveals a second row with the replacement field and
   *     the Replace / Replace-all actions.
   *
   * Editor-agnostic on purpose so any note kind can reuse it. Labels come
   * from the shared `find.*` i18n keys; pass `placeholder` to override the
   * field's prompt per context.
   */

  import {
    CaseSensitive,
    CaseUpper,
    ChevronDown,
    ChevronRight,
    ChevronUp,
    Loader2,
    Regex,
    Replace,
    ReplaceAll,
    TextSearch,
    WholeWord,
    X
  } from '@lucide/svelte';
  import type { Component } from 'svelte';
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
    /**
     * Replace half of the widget. Both the value/handler for the field and
     * the two action callbacks must be supplied together to enable replace
     * mode; omit them (the PDF case) for a find-only bar.
     */
    replaceValue?: string;
    replacePlaceholder?: string;
    onReplaceInput?: (value: string) => void;
    onReplace?: () => void;
    onReplaceAll?: () => void;
    /**
     * Search-field modifiers (VS Code's Aa / ab| / .* toggles). The current
     * value + its toggle callback are passed together per option; supplying
     * `onToggleMatchCase` switches the in-field icon cluster on. Omit them
     * (the PDF case) for a plain search field.
     */
    matchCase?: boolean;
    wholeWord?: boolean;
    useRegex?: boolean;
    onToggleMatchCase?: () => void;
    onToggleWholeWord?: () => void;
    onToggleRegex?: () => void;
    /** Replace-field "Preserve Case" toggle (AB). */
    preserveCase?: boolean;
    onTogglePreserveCase?: () => void;
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
    onClose,
    replaceValue = '',
    replacePlaceholder,
    onReplaceInput,
    onReplace,
    onReplaceAll,
    matchCase = false,
    wholeWord = false,
    useRegex = false,
    onToggleMatchCase,
    onToggleWholeWord,
    onToggleRegex,
    preserveCase = false,
    onTogglePreserveCase
  }: Props = $props();

  let inputEl = $state<HTMLInputElement | null>(null);
  let replaceInputEl = $state<HTMLInputElement | null>(null);
  // Replace row is collapsed by default (VS Code's Ctrl+F default); the
  // toggle reveals it. Only meaningful when replace mode is enabled.
  let replaceExpanded = $state(false);

  export function focus() {
    inputEl?.focus();
    inputEl?.select();
  }

  const replaceEnabled = $derived(
    typeof onReplace === 'function' && typeof onReplaceAll === 'function'
  );
  // The three search modifiers are wired together by the host, so one
  // callback gates the whole in-field cluster.
  const searchOptionsEnabled = $derived(
    typeof onToggleMatchCase === 'function'
  );
  const preserveCaseEnabled = $derived(
    typeof onTogglePreserveCase === 'function'
  );

  // Shared field styling; the right padding grows to clear the in-field
  // toggle icons so typed text never slides under them.
  const FIELD_BASE =
    'h-7 w-full rounded-md border border-border bg-background pl-7 text-xs outline-none focus:ring-1 focus:ring-ring';
  const searchFieldClass = $derived(
    `${FIELD_BASE} ${searchOptionsEnabled ? 'pr-[4.75rem]' : 'pr-2'}`
  );
  const replaceFieldClass = $derived(
    `${FIELD_BASE} ${preserveCaseEnabled ? 'pr-8' : 'pr-2'}`
  );

  const fieldPlaceholder = $derived(placeholder ?? tUi('find.placeholder'));
  const replaceFieldPlaceholder = $derived(
    replacePlaceholder ?? tUi('find.replacePlaceholder')
  );
  const hasQuery = $derived(query.trim().length > 0);

  const countLabel = $derived.by(() => {
    if (busy) return tUi('find.searching');
    if (!hasQuery) return '';
    if (matchCount === 0) return tUi('find.noResults');
    return tUi('find.count')
      .replace('{index}', String(activeIndex + 1))
      .replace('{total}', String(matchCount));
  });

  function toggleReplace() {
    replaceExpanded = !replaceExpanded;
    if (replaceExpanded) {
      // Defer so the field exists before we focus it.
      queueMicrotask(() => replaceInputEl?.focus());
    } else {
      inputEl?.focus();
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) onPrevious();
      else onNext();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (
      event.key === 'Tab' &&
      !event.shiftKey &&
      replaceEnabled &&
      replaceExpanded
    ) {
      // Tab hops straight to the replace field when it's open, rather than
      // walking through the prev/next/close buttons first.
      event.preventDefault();
      replaceInputEl?.focus();
      replaceInputEl?.select();
    }
  }

  function handleReplaceKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      // Shift+Enter replaces all, plain Enter replaces the current match —
      // mirrors VS Code's replace field.
      if (event.shiftKey) onReplaceAll?.();
      else onReplace?.();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'Tab' && event.shiftKey) {
      // Shift+Tab returns to the find field — the inverse of the hop above.
      event.preventDefault();
      inputEl?.focus();
      inputEl?.select();
    }
  }
</script>

<!--
  A single in-field modifier toggle (VS Code's Aa / ab| / .* / AB chips).
  `Icon` is a Lucide component passed by the caller so the same markup
  serves every option. Active state uses aria-pressed both for a11y and as
  the Tailwind styling hook.
-->
{#snippet optionToggle(
  Icon: Component,
  active: boolean,
  onToggle: (() => void) | undefined,
  label: string
)}
  <button
    type="button"
    class="flex size-5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted aria-pressed:bg-primary/15 aria-pressed:text-primary"
    aria-pressed={active}
    aria-label={label}
    title={label}
    onclick={() => onToggle?.()}
  >
    <Icon class="size-3.5" aria-hidden="true" />
  </button>
{/snippet}

<div
  class="flex shrink-0 items-start gap-1 border-b border-border bg-background px-2 py-1.5"
  role="search"
>
  {#if replaceEnabled}
    <!-- Expand toggle, spanning both rows like VS Code. -->
    <Button
      variant="ghost"
      size="icon"
      class="mt-px size-7 shrink-0 text-muted-foreground"
      onclick={toggleReplace}
      aria-label={tUi('find.toggleReplace')}
      aria-expanded={replaceExpanded}
      title={tUi('find.toggleReplace')}
    >
      {#if replaceExpanded}
        <ChevronDown class="size-3.5" aria-hidden="true" />
      {:else}
        <ChevronRight class="size-3.5" aria-hidden="true" />
      {/if}
    </Button>
  {/if}

  <div class="flex min-w-0 flex-1 flex-col gap-1">
    <!-- Find row -->
    <div class="flex items-center gap-1">
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
          class={searchFieldClass}
          oninput={(event) =>
            onInput((event.currentTarget as HTMLInputElement).value)}
          onkeydown={handleKeydown}
        />
        {#if searchOptionsEnabled}
          <div
            class="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5"
          >
            {@render optionToggle(
              CaseSensitive,
              matchCase,
              onToggleMatchCase,
              tUi('find.matchCase')
            )}
            {@render optionToggle(
              WholeWord,
              wholeWord,
              onToggleWholeWord,
              tUi('find.wholeWord')
            )}
            {@render optionToggle(
              Regex,
              useRegex,
              onToggleRegex,
              tUi('find.useRegex')
            )}
          </div>
        {/if}
      </div>

      <span
        class="w-20 shrink-0 px-1 text-right text-[11px] tabular-nums text-muted-foreground"
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

    <!-- Replace row -->
    {#if replaceEnabled && replaceExpanded}
      <div class="flex items-center gap-1">
        <div class="relative flex flex-1 items-center">
          <Replace
            class="pointer-events-none absolute left-2 size-3.5 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            bind:this={replaceInputEl}
            type="text"
            value={replaceValue}
            placeholder={replaceFieldPlaceholder}
            aria-label={replaceFieldPlaceholder}
            class={replaceFieldClass}
            oninput={(event) =>
              onReplaceInput?.((event.currentTarget as HTMLInputElement).value)}
            onkeydown={handleReplaceKeydown}
          />
          {#if preserveCaseEnabled}
            <div
              class="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5"
            >
              {@render optionToggle(
                CaseUpper,
                preserveCase,
                onTogglePreserveCase,
                tUi('find.preserveCase')
              )}
            </div>
          {/if}
        </div>

        <!-- Spacer mirrors the count cell so both input fields are the
             same width. -->
        <span class="w-20 shrink-0 px-1" aria-hidden="true"></span>

        <Button
          variant="ghost"
          size="icon"
          class="size-7 text-muted-foreground"
          disabled={matchCount === 0}
          onclick={() => onReplace?.()}
          aria-label={tUi('find.replace')}
          title={tUi('find.replace')}
        >
          <Replace class="size-3.5" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          class="size-7 text-muted-foreground"
          disabled={matchCount === 0}
          onclick={() => onReplaceAll?.()}
          aria-label={tUi('find.replaceAll')}
          title={tUi('find.replaceAll')}
        >
          <ReplaceAll class="size-3.5" aria-hidden="true" />
        </Button>
        <!-- Empty slot matching the find row's close button so the replace
             input lines up exactly with the find input. -->
        <span class="size-7 shrink-0" aria-hidden="true"></span>
      </div>
    {/if}
  </div>
</div>
