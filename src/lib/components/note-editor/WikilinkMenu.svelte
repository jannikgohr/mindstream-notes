<script lang="ts">
  /**
   * Wikilink autocomplete popup. Shares state with the trigger plugin
   * via `WikilinkBridge` (see `$lib/editor/plugins/wikilink-bridge`).
   *
   * Two structural concerns worth knowing about:
   *
   * 1. **Portaled to `document.body`.** Dockview panels apply CSS
   *    transforms when groups split or resize, which would otherwise
   *    capture our `position: fixed` and re-root it inside the panel —
   *    that's why the menu drifted right when the left sidebar opened.
   *    Moving the element to `body` puts it back at the viewport root.
   *
   * 2. **Positioning via `@floating-ui/dom`.** Same approach Crepe's
   *    `SlashProvider` uses: a virtual reference element exposes the
   *    caret rect, and `computePosition` + `flip()` + `shift()` +
   *    `size()` middlewares pick a spot below/above the caret while
   *    clamping to the viewport and capping the menu's height to fit.
   *    Without `flip`, the menu would clip off the bottom of the
   *    window when the user types near the page fold.
   *
   * Visual chrome targets the same look-and-feel as Crepe's `/` slash
   * menu (rounded card, soft shadow, list items at the same
   * font/padding pattern) so the two surfaces feel like one editor.
   */

  import { tick, untrack } from 'svelte';
  import {
    computePosition,
    flip,
    offset,
    shift,
    size,
    type VirtualElement
  } from '@floating-ui/dom';
  import { Folder } from '@lucide/svelte';
  import { noteKindIcon } from '$lib/components/note-kind-icon';
  import { folderPathLabel } from '$lib/notes/folder-path';
  import { tree } from '$lib/stores/tree.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import type {
    CaretRect,
    WikilinkBridge
  } from '$lib/editor/plugins/wikilink-bridge.svelte';

  interface Props {
    bridge: WikilinkBridge;
  }
  let { bridge }: Props = $props();

  const MAX_RESULTS = 8;
  /** Offset between the caret and the menu's top edge, in px. */
  const MENU_OFFSET = 6;
  /** Hard cap on the menu's height even when there's plenty of room. */
  const MENU_MAX_HEIGHT = 360;
  /** Edge padding so the menu doesn't kiss the viewport edge. */
  const VIEWPORT_PADDING = 8;

  interface Suggestion {
    id: string;
    title: string;
    /** Discriminator for the per-row icon (see noteKindIcon). */
    note_kind: string;
    path: string;
    duplicateTitle: boolean;
  }

  /**
   * Filtered list of notes to show. Ranked: prefix matches first,
   * then by index of substring match, ties broken on title length so
   * shorter (more specific) titles surface ahead of longer ones with
   * the query buried further in. Empty query → most recently modified
   * so the user can pick a recent note without typing.
   */
  const candidates = $derived.by<Suggestion[]>(() => {
    if (!bridge.state.open) return [];
    const q = bridge.state.query.trim().toLowerCase();
    const all = Object.values(tree.notesById).filter((n) => !n.trashed);
    const titleCounts = new Map<string, number>();
    for (const n of all) {
      const key = n.title.trim().toLowerCase();
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
    }
    let scored: Array<{
      id: string;
      title: string;
      note_kind: string;
      parent_collection_id: string | null;
      rank: number;
    }> = [];
    if (!q) {
      scored = all.map((n) => ({
        id: n.id,
        title: n.title,
        note_kind: n.note_kind,
        parent_collection_id: n.parent_collection_id,
        rank: 0
      }));
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
        const rank = idx === 0 ? 0 : idx + t.length / 1000;
        scored.push({
          id: n.id,
          title: n.title,
          note_kind: n.note_kind,
          parent_collection_id: n.parent_collection_id,
          rank
        });
      }
      scored.sort((a, b) => a.rank - b.rank);
    }
    return scored.slice(0, MAX_RESULTS).map((note) => {
      const key = note.title.trim().toLowerCase();
      return {
        id: note.id,
        title: note.title,
        note_kind: note.note_kind,
        path: folderPathLabel(note.parent_collection_id, tree.collectionsById),
        duplicateTitle: (titleCounts.get(key) ?? 0) > 1
      };
    });
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

  $effect(() => {
    bridge.setCommitFromPopup(() => {
      const list = untrack(() => candidates);
      const idx = untrack(() => bridge.state.highlight);
      const picked = list[idx] ?? list[0];
      if (picked) {
        bridge.insert({ id: picked.id, title: picked.title });
      } else {
        bridge.cancel();
      }
    });
  });

  /* --- portal: keep the menu out from under transformed ancestors -------- */

  // Svelte action that moves its element to document.body on mount and
  // removes it on destroy. Without this, dockview's transform on the
  // panel re-roots our position:fixed coords inside the panel, which
  // is why the menu drifted right when the left sidebar was open.
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      }
    };
  }

  /* --- floating-ui positioning ------------------------------------------- */

  let popupEl = $state<HTMLDivElement | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);
  let positioned = $state(false);
  let positionRun = 0;

  /**
   * `computePosition` is async; we re-call it whenever the menu state
   * changes (open, query → caretRect updated, viewport resized). The
   * size middleware bounds maxHeight to the available space so the
   * list stays scrollable even right next to the viewport bottom.
   */
  async function reposition(rect: CaretRect, el: HTMLElement) {
    const virtualEl: VirtualElement = {
      getBoundingClientRect: () => ({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        toJSON: () => rect
      })
    };
    const { x, y } = await computePosition(virtualEl, el, {
      placement: 'bottom-start',
      middleware: [
        offset(MENU_OFFSET),
        flip({ padding: VIEWPORT_PADDING }),
        shift({ padding: VIEWPORT_PADDING }),
        size({
          padding: VIEWPORT_PADDING,
          apply({ availableHeight, elements }) {
            Object.assign(elements.floating.style, {
              maxHeight: `${Math.min(availableHeight, MENU_MAX_HEIGHT)}px`
            });
          }
        })
      ]
    });
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  $effect(() => {
    const open = bridge.state.open;
    const rect = bridge.state.caretRect;
    // Re-run on query change because the caret moves as the user types.
    void bridge.state.query;
    positionRun += 1;
    positioned = false;
    if (!open || !rect || !popupEl) return;
    const run = positionRun;
    void reposition(rect, popupEl).then(() => {
      if (run === positionRun && bridge.state.open) positioned = true;
    });
  });

  // Recompute on viewport resize / scroll — the caret rect we stored is
  // viewport-relative, so a scroll of the editor's pane invalidates it.
  // We don't subscribe to the editor's own scroll here (would need the
  // host element); the trigger plugin re-runs on every editor update
  // and refreshes the rect from there, which covers the most common
  // case of typing-while-scrolled. This handler covers window resize.
  $effect(() => {
    if (!bridge.state.open) return;
    const onResize = () => {
      const rect = bridge.state.caretRect;
      if (rect && popupEl) {
        const run = ++positionRun;
        positioned = false;
        void reposition(rect, popupEl).then(() => {
          if (run === positionRun && bridge.state.open) positioned = true;
        });
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  // Scroll the highlighted row into view when the user navigates with
  // arrow keys. tick() so the new highlight class has rendered.
  const SCROLL_OPTS: ScrollIntoViewOptions = { block: 'nearest' as const };
  $effect(() => {
    const idx = bridge.state.highlight;
    if (!bridge.state.open) return;
    void tick().then(() => {
      const el = listEl?.children?.[idx] as HTMLElement | undefined;
      el?.scrollIntoView(SCROLL_OPTS);
    });
  });
</script>

{#if bridge.state.open && bridge.state.caretRect}
  <!--
    Portaled to <body> so dockview's panel transforms can't capture our
    position:fixed (which is why the menu was drifting). role=listbox:
    same a11y contract as a typeahead — the editor keeps keyboard focus,
    we render the highlight visually.
  -->
  <div
    use:portal
    bind:this={popupEl}
    class="wikilink-menu fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg {positioned
      ? ''
      : 'invisible pointer-events-none'}"
    style="width: 280px;"
    role="listbox"
    aria-label={tUi('editor.wikilink.menu.label')}
  >
    {#if candidates.length === 0}
      <p class="px-3 py-3 text-sm text-muted-foreground">
        {tUi('editor.wikilink.menu.empty')}
      </p>
    {:else}
      <div
        bind:this={listEl}
        class="themed-scrollbar flex flex-col gap-0.5 overflow-y-auto p-2"
      >
        {#each candidates as note, i (note.id)}
          {@const active = i === bridge.state.highlight}
          {@const Icon = noteKindIcon(note.note_kind)}
          {@const path =
            note.path ||
            (note.duplicateTitle ? tUi('metadata.folder.root') : '')}
          <button
            type="button"
            role="option"
            aria-selected={active}
            class="flex w-full items-start gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors {active
              ? 'bg-accent text-accent-foreground'
              : 'hover:bg-accent/60'}"
            onpointerdown={(e) => {
              // Don't yank focus from the editor — the trigger plugin's
              // doc state would close the menu on blur otherwise.
              e.preventDefault();
              bridge.insert({ id: note.id, title: note.title });
            }}
            onmouseenter={() => (bridge.state.highlight = i)}
          >
            <Icon
              class="mt-0.5 size-4 shrink-0 opacity-60"
              aria-hidden="true"
            />
            <span class="min-w-0 flex-1">
              <span class="block truncate font-medium">{note.title}</span>
              {#if path}
                <span class="mt-0.5 flex items-center gap-1 text-xs opacity-70">
                  <Folder class="size-3 shrink-0" aria-hidden="true" />
                  <span class="truncate">{path}</span>
                </span>
              {/if}
            </span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}
