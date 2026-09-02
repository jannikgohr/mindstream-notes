<script lang="ts">
  /**
   * Suggestions for a diagnostic the user right-clicked or long-pressed.
   *
   * This is the ONLY way to reach spelling corrections in the app, which is
   * why it is a real component rather than a reliance on the native menu:
   * the root layout suppresses the webview's context menu in PROD builds, so
   * before this existed the native squiggles were decoration with no cure
   * attached. Both editing surfaces share it, so a correction looks and
   * behaves identically in WYSIWYG, Source and Split.
   *
   * Suggestions are fetched when the popover opens, never in advance:
   * spellbook takes tens of milliseconds per word and grows superlinearly
   * with length, so precomputing them for every misspelling in a document
   * would cost far more than it saves for menus the user never opens.
   */
  import { onMount } from 'svelte';
  import {
    closeDiagnosticPopover,
    diagnosticPopover
  } from '$lib/diagnostics/popover-bridge.svelte';
  import { addCustomWord } from '$lib/diagnostics/custom-dictionary.svelte';
  import { replacementParts } from '$lib/diagnostics/replacement-display';
  import { tUi } from '$lib/settings/i18n.svelte';

  let menu = $state<HTMLDivElement | null>(null);
  let expanded = $state(false);

  const open = $derived(diagnosticPopover.current);

  /**
   * How many corrections to show before collapsing the rest.
   *
   * spellbook is generous — a short word can produce twenty candidates,
   * which turns a menu meant for a glance into a scrolling list where the
   * right answer is no easier to find than the wrong ones. Six covers the
   * intended word in nearly every case now that the list is ranked, and
   * the rest stay one click away rather than being discarded.
   */
  const VISIBLE_SUGGESTIONS = 6;

  // Deduplicated, and keyed by position rather than value below. Different
  // rules can offer the same replacement, and a keyed `each` throws on
  // duplicate keys — which breaks the whole list, so no suggestion at all
  // can be clicked.
  const all = $derived([...new Set(diagnosticPopover.suggestions ?? [])]);
  const shown = $derived(expanded ? all : all.slice(0, VISIBLE_SUGGESTIONS));
  const hidden = $derived(all.length - shown.length);

  // Collapse again whenever the popover moves to another word, or the
  // next one opens already expanded for no reason.
  $effect(() => {
    void open;
    expanded = false;
  });

  /** Breathing room between the flagged word and the menu. */
  const GAP = 6;
  /** And between the menu and the edge of the window. */
  const MARGIN = 8;

  /**
   * Open beside the flagged word, never over it, and stay in the viewport.
   *
   * Below the word is the default because that is where a menu is expected
   * and where the finger is not. It flips above when there is no room below
   * — a misspelling near the bottom edge is common, since that is where a
   * note in progress ends, and on a phone the keyboard takes the bottom half
   * of the window as soon as the editor has focus.
   */
  const position = $derived.by(() => {
    if (!open) return { left: 0, top: 0 };
    // Rough bounds, matching the container's max-width and a menu with a
    // wrapped two-line message plus a full suggestion list. Over-estimating
    // only makes it flip above sooner than it strictly had to, and both
    // sides keep the word visible; under-estimating would clip the menu.
    const width = 288;
    const height = 320;
    const { left, top, bottom } = open.anchor;

    const roomBelow = window.innerHeight - bottom - GAP - MARGIN;
    const roomAbove = top - GAP - MARGIN;
    // Prefer below; take above only when it actually fits, or when neither
    // does and it is the roomier of the two.
    const below = roomBelow >= height || roomBelow >= roomAbove;
    const wanted = below ? bottom + GAP : top - GAP - height;

    return {
      left: Math.min(
        Math.max(MARGIN, left),
        Math.max(MARGIN, window.innerWidth - width - MARGIN)
      ),
      top: Math.min(
        Math.max(MARGIN, wanted),
        Math.max(MARGIN, window.innerHeight - height - MARGIN)
      )
    };
  });

  function choose(replacement: string) {
    open?.apply(replacement);
    closeDiagnosticPopover();
  }

  /**
   * Accept the word everywhere rather than correcting this one instance.
   *
   * Only offered for spelling. A grammar or style hint is about the
   * sentence, not the word, so "never tell me about this word again"
   * would silence the wrong thing.
   */
  function accept() {
    const word = open?.word;
    closeDiagnosticPopover();
    if (word) void addCustomWord(word);
  }

  onMount(() => {
    const dismiss = (event: Event) => {
      // Matched by attribute rather than by this instance's own element:
      // identity checks close the menu whenever another copy of the
      // component sees the event first, which is exactly what happened
      // when one was mounted per open note.
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('[data-diagnostic-popover]')
      ) {
        return;
      }
      closeDiagnosticPopover();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDiagnosticPopover();
    };
    // Capture phase: an editor surface may stop propagation of its own
    // pointer events, which would otherwise leave the menu stuck open.
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('keydown', onKey);
    // A scroll moves the text out from under the menu, so anchoring becomes
    // meaningless — close rather than chase it. Scrolling INSIDE the menu is
    // exempt by the same containment check; a long suggestion list has to be
    // scrollable without dismissing itself.
    window.addEventListener('scroll', dismiss, true);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', dismiss, true);
    };
  });
</script>

{#if open}
  <!--
    z-[250] is the app's editor-menu layer (see ContextMenu's `layer` prop),
    not the z-50 most popovers use. This one is mounted at the layout root but
    opens from inside an editor, and the Kanban card editor's side panel sits
    at 240 in that same root stacking context — at z-50 the suggestions opened
    behind the very field they were correcting. Above the editors, below the
    app-level menus (350) and dialogs (400), which is exactly where a menu
    belonging to an editing surface belongs.
  -->
  <div
    bind:this={menu}
    class="fixed z-[250] min-w-52 max-w-72 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
    style="left: {position.left}px; top: {position.top}px;"
    role="menu"
    data-diagnostic-popover
    aria-label={tUi('editor.spellcheck.menu.label')}
    tabindex="-1"
  >
    <div class="border-b border-border px-3 py-1.5">
      <p class="truncate text-xs font-medium">{open.word}</p>
      <!--
        Wraps rather than truncates. LanguageTool's messages are whole
        sentences explaining the rule — cut to one line they lose exactly
        the part that says what to do about it.
      -->
      <p class="text-xs leading-snug text-muted-foreground">
        {open.diagnostic.message}
      </p>
    </div>

    <div class="max-h-56 overflow-y-auto py-1">
      {#if diagnosticPopover.loading}
        <p class="px-3 py-1.5 text-xs text-muted-foreground">
          {tUi('editor.spellcheck.menu.loading')}
        </p>
      {:else if all.length === 0}
        <p class="px-3 py-1.5 text-xs text-muted-foreground">
          {tUi('editor.spellcheck.menu.noSuggestions')}
        </p>
      {:else}
        {#each shown as suggestion, index (index)}
          <button
            type="button"
            role="menuitem"
            data-diagnostic-action="replace"
            class="block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            onclick={() => choose(suggestion)}
          >
            <!--
              Whitespace is rendered, not printed. LanguageTool's punctuation
              rules offer replacements that differ only in WHICH space they
              use, so shown literally two options look identical or one shows
              as a tofu box. The applied value is always the original string.
            -->
            {#each replacementParts(suggestion) as part, i (i)}
              {#if part.space}
                <span class="text-muted-foreground/70" title={part.space}
                  >{part.text}</span
                >
              {:else}{part.text}{/if}
            {/each}
          </button>
        {/each}
        {#if hidden > 0}
          <button
            type="button"
            class="block w-full px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            onclick={() => (expanded = true)}
          >
            {tUi('editor.spellcheck.menu.showAll')} ({all.length})
          </button>
        {/if}
      {/if}
    </div>

    {#if open.diagnostic.kind === 'spelling'}
      <div class="border-t border-border py-1">
        <button
          type="button"
          role="menuitem"
          data-diagnostic-action="add-to-dictionary"
          class="block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
          onclick={accept}
        >
          {tUi('editor.spellcheck.menu.addToDictionary')}
        </button>
      </div>
    {/if}
  </div>
{/if}
