<script lang="ts">
  /**
   * Wikilink autocomplete popup. The trigger plugin in
   * `$lib/editor/plugins/wikilink` opens us via a shared bridge object;
   * we read its `query` + `anchor` fields reactively and write back to
   * `highlight` as the user navigates.
   *
   * Note picking flow:
   *   - User types `[[` in the editor → bridge.state.open flips true.
   *   - We filter the tree by the live query string.
   *   - User arrows / hovers → bridge.state.highlight updates.
   *   - Enter (handled in the plugin) calls bridge.commitFromPopup() →
   *     we pick the title at our current highlight and call
   *     bridge.insert(title) — that's the plugin's text-replacement path.
   *   - Click on a row does the same `bridge.insert(title)`.
   *
   * Positioning is `position: fixed` at the caret's bottom-left, which
   * the plugin computes from `view.coordsAtPos`. No floating-ui
   * dependency for now — viewport-edge clamping is the only thing the
   * caret-following anchor risks getting wrong, and we handle it with
   * a small offset + the menu's own max-height.
   */

  import { tick, untrack } from 'svelte';
  import { tree } from '$lib/stores/tree.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import type { WikilinkBridge } from '$lib/editor/plugins/wikilink-bridge.svelte';

  interface Props {
    bridge: WikilinkBridge;
  }
  let { bridge }: Props = $props();

  const MAX_RESULTS = 8;

  interface Suggestion {
    id: string;
    title: string;
  }

  /**
   * Filtered, ranked list of notes to show. Substring match
   * case-insensitively; ranked by (1) prefix-match first, (2)
   * shortest title first so "Notes" beats "Notes about whatever".
   * Empty query → just the most recently modified notes so the user
   * can pick by recency without typing.
   */
  const candidates = $derived.by<Suggestion[]>(() => {
    if (!bridge.state.open) return [];
    const q = bridge.state.query.trim().toLowerCase();
    const all = Object.values(tree.notesById).filter((n) => !n.trashed);
    let scored: Array<{ id: string; title: string; rank: number }> = [];
    if (!q) {
      scored = all.map((n) => ({ id: n.id, title: n.title, rank: 0 }));
      scored.sort((a, b) => {
        const ma = tree.notesById[a.id]?.modified ?? '';
        const mb = tree.notesById[b.id]?.modified ?? '';
        return mb.localeCompare(ma);
      });
    } else {
      for (const n of all) {
        const t = n.title.toLowerCase();
        const idx = t.indexOf(q);
        if (idx < 0) continue;
        // Lower rank wins. Prefix match → 0, otherwise the index;
        // tie-break on title length so terse matches sort first.
        const rank = idx === 0 ? 0 : idx + t.length / 1000;
        scored.push({ id: n.id, title: n.title, rank });
      }
      scored.sort((a, b) => a.rank - b.rank);
    }
    return scored.slice(0, MAX_RESULTS).map(({ id, title }) => ({ id, title }));
  });

  // Keep the plugin's highlight inside the visible range. Triggered
  // when candidates shrink (filter tightened) or grow (loosened).
  $effect(() => {
    const len = candidates.length;
    if (len === 0) {
      if (bridge.state.highlight !== 0) bridge.state.highlight = 0;
      return;
    }
    if (bridge.state.highlight >= len) {
      bridge.state.highlight = len - 1;
    } else if (bridge.state.highlight < 0) {
      bridge.state.highlight = 0;
    }
  });

  // Wire the Enter handler the plugin calls. Reads the *current*
  // highlight at call time, not at registration, so the closure
  // doesn't go stale as the user navigates.
  // Wrapped in $effect so Svelte's strict $state-reference check is
  // satisfied; in practice `bridge` is per-mount and never reassigned,
  // so this runs exactly once on mount.
  $effect(() => {
    bridge.setCommitFromPopup(() => {
      const list = untrack(() => candidates);
      const idx = untrack(() => bridge.state.highlight);
      const picked = list[idx] ?? list[0];
      if (picked) {
        bridge.insert(picked.title);
      } else {
        bridge.cancel();
      }
    });
  });

  // Scroll the highlighted row into view when the user navigates with
  // arrow keys. Two-step (tick) so the DOM has rendered the new
  // highlight class before we measure.
  let listEl: HTMLDivElement | null = $state(null);
  // `as const` because some IDEs widen the literal 'nearest' to string,
  // which doesn't satisfy ScrollIntoViewOptions['block'] (the
  // ScrollLogicalPosition union). TS itself accepts either; the cast is
  // for tooling parity, not for runtime.
  const SCROLL_OPTS: ScrollIntoViewOptions = { block: 'nearest' as const };
  $effect(() => {
    const idx = bridge.state.highlight;
    if (!bridge.state.open) return;
    void tick().then(() => {
      const el = listEl?.children?.[idx] as HTMLElement | undefined;
      el?.scrollIntoView(SCROLL_OPTS);
    });
  });

  // Reserve room above for menu when caret is near the bottom of the
  // viewport. We always anchor to the caret's *bottom*; flipping above
  // is a future improvement once we start measuring our own height.
  const POPUP_WIDTH = 280;
  const POPUP_MAX_HEIGHT = 280;
  const Y_OFFSET = 4;

  const style = $derived.by(() => {
    const a = bridge.state.anchor;
    if (!a) return 'display: none;';
    const vw = typeof window === 'undefined' ? 1024 : window.innerWidth;
    const left = Math.min(a.x, vw - POPUP_WIDTH - 8);
    return `left: ${Math.max(8, left)}px; top: ${a.y + Y_OFFSET}px; width: ${POPUP_WIDTH}px; max-height: ${POPUP_MAX_HEIGHT}px;`;
  });
</script>

{#if bridge.state.open}
  <!-- role=listbox: same a11y contract as a typeahead. The editor keeps
       focus; we just visually highlight the candidate the user would
       commit on Enter. -->
  <div
    class="wikilink-menu fixed z-50 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
    style={style}
    role="listbox"
    aria-label={tUi('editor.wikilink.menu.label')}
  >
    {#if candidates.length === 0}
      <p class="px-3 py-2 text-xs text-muted-foreground">
        {tUi('editor.wikilink.menu.empty')}
      </p>
    {:else}
      <div
        bind:this={listEl}
        class="themed-scrollbar max-h-[280px] overflow-y-auto py-1"
      >
        {#each candidates as note, i (note.id)}
          {@const active = i === bridge.state.highlight}
          <button
            type="button"
            role="option"
            aria-selected={active}
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors {active
              ? 'bg-accent text-accent-foreground'
              : 'hover:bg-accent/60'}"
            onpointerdown={(e) => {
              // Don't yank focus from the editor — the trigger plugin's
              // doc state would close the menu on blur otherwise.
              e.preventDefault();
              bridge.insert(note.title);
            }}
            onmouseenter={() => (bridge.state.highlight = i)}
          >
            <span class="truncate">{note.title}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}
