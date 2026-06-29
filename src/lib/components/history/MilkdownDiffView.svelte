<script lang="ts">
  /**
   * Rendered-prose diff for the history modal.
   *
   * `@milkdown/plugin-diff` is headless — it *computes* a changeset and exposes
   * accept/reject commands, but renders nothing. So we drive it read-only:
   *   1. load the CURRENT note into a Crepe editor,
   *   2. register the diff plugin + our own decoration plugin,
   *   3. run `startDiffReviewCmd(snapshotMarkdown)` — which parses the selected
   *      note (at command time, when the editor context is ready) and stores
   *      the changeset in the diff plugin's state,
   *   4. our decoration plugin reads that state and draws deletions (struck
   *      through) and insertions (the added text, highlighted) inline.
   *
   * The direction is intentionally restore-oriented: red is content the restore
   * would remove from the current note, green is content the selected snapshot
   * would add.
   *
   * Defensive: if the diff pipeline throws (e.g. a Milkdown context mismatch
   * from the 7.20/7.21 split), fall back to a message rather than break.
   */
  import { onDestroy, onMount } from 'svelte';
  import { Info } from '@lucide/svelte';
  import { Crepe } from '@milkdown/crepe';
  import { editorViewCtx } from '@milkdown/kit/core';
  import { $prose as proseFactory } from '@milkdown/kit/utils';
  import { callCommand } from '@milkdown/kit/utils';
  import { DOMSerializer, type Slice } from '@milkdown/kit/prose/model';
  import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
  import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
  import {
    diff,
    diffPluginKey,
    startDiffReviewCmd
  } from '@milkdown/plugin-diff';
  import { tUi } from '$lib/settings/i18n.svelte';

  interface Props {
    currentMarkdown: string;
    snapshotMarkdown: string;
  }
  let { currentMarkdown, snapshotMarkdown }: Props = $props();

  let host = $state<HTMLDivElement | null>(null);
  let crepe: Crepe | null = null;
  let failed = $state(false);
  // True once we've confirmed the two versions produced no changes.
  let identical = $state(false);

  function isClosedStructuralSlice(slice: Slice) {
    if (slice.openStart !== 0 || slice.openEnd !== 0) return false;

    let hasStructuralNode = false;
    slice.content.descendants((node) => {
      if (node.isBlock || node.type.name.startsWith('table')) {
        hasStructuralNode = true;
        return false;
      }

      return undefined;
    });

    return hasStructuralNode;
  }

  /**
   * Reads the changeset the diff plugin computed (current editor doc → selected
   * snapshot) and renders it: `diff-del` over removed ranges, `diff-ins` inline
   * widgets for text edits, and DOM-serialized structural widgets for inserted
   * blocks such as whole tables. No ctx access — it only reads the diff plugin's
   * state — so it's safe to build at setup time.
   */
  function diffDecorationsPlugin() {
    return proseFactory(() => {
      return new Plugin({
        key: new PluginKey('history-diff-decorations'),
        props: {
          decorations(state) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ds = diffPluginKey.getState(state) as any;
            if (!ds) return null;
            const decos: Decoration[] = [];
            for (const ch of ds.changes) {
              if (ch.toA > ch.fromA) {
                const slice = state.doc.slice(ch.fromA, ch.toA);
                const isStructural = isClosedStructuralSlice(slice);
                if (isStructural) {
                  state.doc.nodesBetween(ch.fromA, ch.toA, (node, pos) => {
                    const to = pos + node.nodeSize;
                    if (pos < ch.fromA || to > ch.toA) return undefined;

                    if (node.type.name === 'table') {
                      decos.push(
                        Decoration.node(pos, to, { class: 'diff-del-block' })
                      );
                      return undefined;
                    }

                    if (
                      node.type.name === 'table_cell' ||
                      node.type.name === 'table_header'
                    ) {
                      decos.push(
                        Decoration.node(pos, to, { class: 'diff-del-cell' })
                      );
                    }

                    return undefined;
                  });
                }
                decos.push(
                  Decoration.inline(ch.fromA, ch.toA, { class: 'diff-del' })
                );
              }
              if (ch.toB > ch.fromB) {
                const slice = ds.newDoc.slice(ch.fromB, ch.toB);
                const isStructural = isClosedStructuralSlice(slice);
                const text = ds.newDoc.textBetween(ch.fromB, ch.toB, ' ', ' ');
                if (isStructural || text) {
                  decos.push(
                    Decoration.widget(
                      ch.toA,
                      () => {
                        if (isStructural) {
                          const el = document.createElement('div');
                          el.className = 'diff-ins diff-ins-block';
                          el.contentEditable = 'false';
                          el.appendChild(
                            DOMSerializer.fromSchema(
                              state.schema
                            ).serializeFragment(slice.content, { document })
                          );
                          return el;
                        }

                        const el = document.createElement('span');
                        el.className = 'diff-ins';
                        el.textContent = text;
                        return el;
                      },
                      { side: 1 }
                    )
                  );
                }
              }
            }
            return DecorationSet.create(state.doc, decos);
          }
        }
      });
    });
  }

  onMount(async () => {
    if (!host) return;
    try {
      const instance = new Crepe({ root: host, defaultValue: currentMarkdown });
      // Casts: these are typed against plugin-diff's nested @milkdown/ctx
      // (7.21), a different nominal type than the editor's (7.20). Vite's
      // resolve.dedupe collapses them to one runtime instance.
      instance.editor.use(diff as never);
      instance.editor.use(diffDecorationsPlugin() as never);
      crepe = instance;
      await instance.create();
      instance.setReadonly(true);
      // Parses `snapshotMarkdown` and stores the changeset in the diff plugin
      // state, which the decoration plugin above then draws.
      instance.editor.action(
        callCommand(startDiffReviewCmd.key as never, snapshotMarkdown)
      );
      // After the command runs, inspect the computed changeset so we can tell
      // the user when the two versions are identical.
      instance.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ds = diffPluginKey.getState(view.state) as any;
        identical = !ds || !ds.changes || ds.changes.length === 0;
      });
    } catch (err) {
      console.error('[history] diff render failed', err);
      failed = true;
    }
  });

  onDestroy(() => {
    crepe?.destroy();
    crepe = null;
  });
</script>

<div class="flex h-full flex-col">
  {#if failed}
    <p class="p-4 text-sm text-muted-foreground">{tUi('history.diffFailed')}</p>
  {/if}
  {#if !failed}
    <div
      class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground"
      aria-label={tUi('history.diff.legend')}
    >
      <span class="inline-flex items-center gap-1.5">
        <span class="size-2 rounded-sm bg-emerald-500/70" aria-hidden="true"
        ></span>
        {tUi('history.diff.legendInsertion')}
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="size-2 rounded-sm bg-rose-500/70" aria-hidden="true"
        ></span>
        {tUi('history.diff.legendDeletion')}
      </span>
    </div>
  {/if}
  {#if identical && !failed}
    <div
      class="mb-2 flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
      role="status"
    >
      <Info class="size-4 shrink-0 text-primary" aria-hidden="true" />
      <span class="leading-4">{tUi('history.diff.identical')}</span>
    </div>
  {/if}
  <div
    bind:this={host}
    class="milkdown-diff min-h-0 flex-1 overflow-y-auto"
    class:hidden={failed}
  ></div>
</div>
