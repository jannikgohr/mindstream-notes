<script lang="ts">
  import { onMount } from 'svelte';
  import { Crepe } from '@milkdown/crepe';
  import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
  import { replaceAll } from '@milkdown/kit/utils';
  import type { EditorViewMode } from '$lib/editor/source/view-mode';
  import { Bold, Italic, Heading1, List } from '@lucide/svelte';
  import { registerEditor, type EditorListener } from '$lib/hotkeys/bus.svelte';
  import { MARKDOWN_ACTIONS } from '$lib/hotkeys/markdown-actions';
  import {
    Toolbar,
    ToolbarButton,
    ToolbarSeparator
  } from '$lib/components/ui/toolbar';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { toErrorMessage } from '$lib/api/errors';

  let host: HTMLDivElement;
  let { mode = 'wysiwyg' }: { mode?: EditorViewMode } = $props();
  let sourceArea = $state<HTMLTextAreaElement | null>(null);
  let source = $state('');
  let crepe = $state<Crepe | null>(null);
  let error = $state('');
  function run(id: string) {
    const action = MARKDOWN_ACTIONS[id];
    if (crepe && action) crepe.editor.action(action);
  }
  onMount(() => {
    let disposed = false;
    let unregister: (() => void) | undefined;
    let promote: (() => void) | undefined;
    source = tUi('onboarding.practice.body');
    const instance = new Crepe({
      root: host,
      defaultValue: source,
      features: {
        [Crepe.Feature.ImageBlock]: false,
        [Crepe.Feature.BlockEdit]: false,
        [Crepe.Feature.Toolbar]: false,
        [Crepe.Feature.Latex]: false
      }
    });
    instance.editor.use(listener).config((ctx) => {
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
        if (document.activeElement !== sourceArea) source = markdown;
      });
    });
    void instance
      .create()
      .then(async () => {
        if (disposed) {
          await instance.destroy();
          return;
        }
        const listener: EditorListener = {
          kind: 'markdown',
          host,
          onCommand(id) {
            if (mode === 'source' || document.activeElement === sourceArea)
              return false;
            if (!MARKDOWN_ACTIONS[id]) return false;
            run(id);
            return true;
          }
        };
        unregister = registerEditor(listener);
        promote = () => {
          registerEditor(listener);
        };
        host.addEventListener('focusin', promote);
        crepe = instance;
      })
      .catch((cause) => {
        if (!disposed) error = toErrorMessage(cause);
      });
    return () => {
      disposed = true;
      unregister?.();
      if (promote) host.removeEventListener('focusin', promote);
      if (crepe) void instance.destroy();
      crepe = null;
    };
  });
</script>

<div class="practice-panes" class:split={mode === 'split'}>
  {#if mode !== 'wysiwyg'}
    <textarea
      bind:this={sourceArea}
      aria-label={tUi('onboarding.practice.source')}
      class="min-h-64 w-full rounded-lg border border-input bg-surface-1 p-5 font-mono text-sm"
      spellcheck="false"
      bind:value={source}
      oninput={() => {
        crepe?.editor.action(replaceAll(source));
      }}
    ></textarea>
  {/if}
  <div class:hidden={mode === 'source'}>
    <div class="overflow-hidden rounded-lg border border-border bg-surface-1">
      <Toolbar
        class="border-b border-border"
        aria-label={tUi('onboarding.preview.toolbar')}
      >
        <ToolbarButton
          holdFocus
          disabled={!crepe}
          aria-label={tUi('onboarding.preview.bold')}
          onclick={() => run('editor.markdown.bold')}><Bold /></ToolbarButton
        >
        <ToolbarButton
          holdFocus
          disabled={!crepe}
          aria-label={tUi('onboarding.preview.italic')}
          onclick={() => run('editor.markdown.italic')}
          ><Italic /></ToolbarButton
        >
        <ToolbarSeparator />
        <ToolbarButton
          holdFocus
          disabled={!crepe}
          aria-label={tUi('onboarding.practice.heading')}
          onclick={() => run('editor.markdown.h1')}><Heading1 /></ToolbarButton
        >
        <ToolbarButton
          holdFocus
          disabled={!crepe}
          aria-label={tUi('onboarding.practice.list')}
          onclick={() => run('editor.markdown.bulletList')}
          ><List /></ToolbarButton
        >
      </Toolbar>
      <div
        bind:this={host}
        class="practice-editor mobile-editor"
        data-testid="onboarding-practice"
        aria-busy={!crepe}
      ></div>
    </div>
  </div>
</div>
{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}

<style>
  .practice-panes {
    display: grid;
    gap: 0.75rem;
  }
  .practice-panes.split {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .practice-editor {
    min-height: 12rem;
  }
  .practice-editor :global(.milkdown .ProseMirror) {
    min-height: 12rem;
    padding: 1.25rem;
  }
</style>
