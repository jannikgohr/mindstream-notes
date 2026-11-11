<script lang="ts">
  /**
   * Wikilink autocomplete popup. Shares state with the trigger plugin
   * via `WikilinkBridge` (see `$lib/editor/plugins/wikilink-bridge`).
   * Portal, caret positioning, and highlight handling live in
   * `typeahead-popup.svelte.ts`.
   *
   * Visual chrome targets the same look-and-feel as Crepe's `/` slash
   * menu (rounded card, soft shadow, list items at the same
   * font/padding pattern) so the two surfaces feel like one editor.
   */

  import { untrack } from 'svelte';
  import { Folder } from '@lucide/svelte';
  import NoteKindIcon from '$lib/components/NoteKindIcon.svelte';
  import { folderPathLabel } from '$lib/notes/folder-path';
  import { tree } from '$lib/stores/tree.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import type { WikilinkBridge } from '$lib/editor/plugins/wikilink-bridge.svelte';
  import { portalToBody, useTypeaheadPopup } from './typeahead-popup.svelte';

  interface Props {
    bridge: WikilinkBridge;
  }
  let { bridge }: Props = $props();

  const MAX_RESULTS = 8;

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

  function commitHighlighted() {
    const list = untrack(() => candidates);
    const idx = untrack(() => bridge.state.highlight);
    const picked = list[idx] ?? list[0];
    if (picked) {
      bridge.insert({ id: picked.id, title: picked.title });
    } else {
      bridge.cancel();
    }
  }

  const popup = useTypeaheadPopup(
    () => bridge,
    () => candidates.length,
    commitHighlighted
  );
</script>

{#if bridge.state.open && bridge.state.caretRect}
  <!--
    Portaled to <body> so dockview's panel transforms can't capture our
    position:fixed (which is why the menu was drifting). role=listbox:
    same a11y contract as a typeahead — the editor keeps keyboard focus,
    we render the highlight visually.
  -->
  <div
    use:portalToBody
    bind:this={popup.el}
    class="wikilink-menu fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg {popup.positioned
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
        bind:this={popup.list}
        class="themed-scrollbar flex flex-col gap-0.5 overflow-y-auto p-2"
      >
        {#each candidates as note, i (note.id)}
          {@const active = i === bridge.state.highlight}
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
            <NoteKindIcon
              kind={note.note_kind}
              class="mt-0.5 size-4 shrink-0 opacity-60"
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
