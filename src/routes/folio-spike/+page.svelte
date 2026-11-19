<script lang="ts">
  /**
   * The Folio spike: the Folio core in CodeMirror, as it would replace
   * Milkdown, running in this app's own webview. Two copies of one note
   * share their changes, the way live collab would.
   */
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import { EditorView } from '@codemirror/view';
  import { applyAnswer, folioState } from 'folio-codemirror';
  import init, { FolioEditor } from 'folio-codemirror/wasm';
  import { Crepe } from '@milkdown/crepe';
  import { editorViewCtx } from '@milkdown/kit/core';

  const sample = `# Folio in mindstream

Type here. **Bold**, *emphasis*, ~~strike~~, \`code\` and [a link](https://example.com) show their markers only at the caret.

## A heading

- A list item
  - A nested one
- [ ] A task
- [x] A done task

1. First
2. Second
`;

  /** A note of about a megabyte, the size Folio is measured on. */
  function largeNote() {
    let note = '';
    for (let n = 0; note.length < 1_000_000; n++) {
      note += `## Section ${n}\n\nA paragraph with **bold** and a [link](https://example.com/${n}), long enough to wrap around once on a narrow screen.\n\n- An item\n  - A nested item\n- [ ] A task\n\n`;
    }
    return note;
  }

  let left = $state<HTMLElement>();
  let right = $state<HTMLElement>();
  let status = $state('Loading');
  let markdown = $state('');
  const query =
    typeof location === 'undefined'
      ? new URLSearchParams()
      : new URLSearchParams(location.search);
  const large = query.has('large');
  // The same note in a plain Crepe, as a baseline to measure Folio against.
  const milkdown = query.has('milkdown');

  async function openMilkdown(parent: HTMLElement) {
    const opening = performance.now();
    const crepe = new Crepe({
      root: parent,
      defaultValue: large ? largeNote() : sample
    });
    await crepe.create();
    status = `Milkdown opened in ${Math.round(performance.now() - opening)} ms`;
    crepe.editor.action((ctx) => {
      Object.assign(window, {
        spike: { kind: 'milkdown', view: ctx.get(editorViewCtx) }
      });
    });
    return crepe;
  }

  onMount(() => {
    const views: EditorView[] = [];
    if (milkdown) {
      const crepe = openMilkdown(left!);
      return () => void crepe.then((editor) => editor.destroy());
    }
    void (async () => {
      try {
        await init();
        const opening = performance.now();
        const one = new FolioEditor(large ? largeNote() : sample);
        const two = FolioEditor.replica();
        two.applyUpdate(one.encodeUpdate(undefined));
        const byCore = new Map<FolioEditor, EditorView>();
        const share = (from: FolioEditor, to: FolioEditor) => {
          const view = byCore.get(to);
          if (view)
            applyAnswer(
              view,
              to.applyUpdate(from.encodeUpdate(to.stateVector()))
            );
        };
        for (const [core, other, parent] of [
          [one, two, left],
          [two, one, right]
        ] as const) {
          const state = folioState(core, { check: !large }, [
            EditorView.updateListener.of((update) => {
              if (!update.docChanged) return;
              queueMicrotask(() => {
                share(core, other);
                if (!large) markdown = one.markdown();
              });
            })
          ]);
          const view = new EditorView({ state, parent: parent! });
          byCore.set(core, view);
          views.push(view);
        }
        markdown = large ? '' : one.markdown();
        Object.assign(window, {
          spike: { kind: 'folio', view: views[0], core: one }
        });
        status = `Opened in ${Math.round(performance.now() - opening)} ms`;
      } catch (error) {
        console.error('[folio-spike]', error);
        status = `Failed: ${String(error)}`;
      }
    })();
    return () => views.forEach((view) => view.destroy());
  });
</script>

<main class="flex min-h-dvh flex-col gap-3 bg-background p-4 text-foreground">
  <header class="flex flex-wrap items-center gap-3 text-sm">
    <a class="underline" href="{base}/">Back to the app</a>
    <span class="font-medium">Folio spike</span>
    <span class="text-muted-foreground" role="status">{status}</span>
    <a class="underline" href={large ? '?' : '?large'}
      >Folio, {large ? 'small note' : 'large note (1 MB)'}</a
    >
    <a class="underline" href={large ? '?milkdown&large' : '?milkdown'}
      >Milkdown, same note</a
    >
  </header>
  <div class="grid flex-1 gap-4 md:grid-cols-2">
    <div
      class="spike-pane rounded-md border border-border"
      bind:this={left}
    ></div>
    <div
      class="spike-pane rounded-md border border-border"
      bind:this={right}
    ></div>
  </div>
  {#if markdown}
    <details class="text-sm">
      <summary>Markdown</summary>
      <pre class="overflow-x-auto whitespace-pre-wrap">{markdown}</pre>
    </details>
  {/if}
</main>

<style>
  .spike-pane {
    min-height: 40vh;
  }
  .spike-pane :global(.cm-editor) {
    height: 100%;
  }
  .spike-pane :global(.cm-editor.cm-focused) {
    outline: none;
  }
  .spike-pane :global(.cm-scroller) {
    font-family: inherit;
  }
  .spike-pane :global(.cm-content) {
    padding: 12px 16px;
  }
</style>
