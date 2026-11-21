<script lang="ts" module>
  // Kept per view across sidebar switches, so a view reopens where it was.
  const viewStates = new Map<string, unknown>();
</script>

<script lang="ts">
  /**
   * A `schema` sidebar view. The plugin owns the view's state but holds none
   * of it: the host keeps it, hands it to every `render`/`onEvent` call and
   * stores what comes back. Calls run one at a time, in order.
   */
  import { onDestroy, untrack } from 'svelte';
  import NoteKindIcon from '$lib/components/NoteKindIcon.svelte';
  import { Button } from '$lib/components/ui/button';
  import { i18n } from '$lib/settings/i18n.svelte';
  import { getSettingValue } from '$lib/settings/store.svelte';
  import { ui } from '$lib/state.svelte';
  import { tree } from '$lib/stores/tree.svelte';
  import { parsePluginEffect, runPluginEffect } from './effects';
  import { buildPluginContext } from './plugin-ctx';
  import PluginIcon from './PluginIcon.svelte';
  import { pluginById } from './registry.svelte';
  import { runPluginScript } from './run-script';
  import SchemaCalendar from './SchemaCalendar.svelte';
  import SchemaGraph from './SchemaGraph.svelte';
  import { onSidebarViewAction } from './sidebar-views';
  import type { PluginViewRender } from './types';
  import {
    parseViewNode,
    viewText,
    type ViewAction,
    type ViewNode
  } from './view-schema';

  let {
    ref,
    source,
    tab = false
  }: {
    ref: { pluginId: string; view: { render: PluginViewRender } };
    source: string;
    /** Drawn as a main-area tab rather than in the sidebar. */
    tab?: boolean;
  } = $props();

  const pluginId = $derived(ref.pluginId);
  const render = $derived(ref.view.render);
  // Raw: a graph view holds tens of thousands of nodes, and deep state would
  // wrap each one in a proxy.
  let view = $state.raw<ViewNode | null>(null);
  let failure = $state<string | null>(null);
  let queue: Promise<void> = Promise.resolve();
  let destroyed = false;

  function call(exportName: string, input: Record<string, unknown>) {
    return runPluginScript(pluginId, exportName, {
      ...buildPluginContext(),
      state: viewStates.get(source) ?? null,
      ...input
    }) as Promise<Record<string, unknown> | null>;
  }

  function keepState(result: Record<string, unknown> | null) {
    if (result && 'state' in result) viewStates.set(source, result.state);
  }

  function enqueue(task: () => Promise<void>) {
    queue = queue.then(task).catch((err) => {
      console.error('[plugins] sidebar view failed', pluginId, err);
      failure = err instanceof Error ? err.message : String(err);
    });
  }

  async function redraw() {
    const result = await call(render.render, {});
    if (destroyed) return;
    keepState(result);
    const next = parseViewNode(result?.view);
    if (!next) throw new Error('The view returned nothing the app can show.');
    view = next;
    failure = null;
  }

  function dispatch(action: ViewAction | undefined, value?: string) {
    if (!action) return;
    if ('effect' in action) {
      enqueue(() => runPluginEffect(pluginId, action));
      return;
    }
    enqueue(async () => {
      const result = await call(render.onEvent, {
        event: action.event,
        value: value ?? action.value ?? null
      });
      keepState(result);
      const effect = parsePluginEffect(result?.effect);
      if (effect) await runPluginEffect(pluginId, effect);
      await redraw();
    });
  }

  // What a render reads from: notes, the plugin's settings, the active note
  // and the locale.
  let redrawTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    for (const note of Object.values(tree.notesById)) {
      void note.title;
      void note.modified;
      void note.parent_collection_id;
      void note.trashed;
    }
    const sections = pluginById(pluginId)?.manifest.contributes.settings ?? [];
    for (const setting of sections.flatMap((s) => s.settings)) {
      void getSettingValue(`plugins.${pluginId}.${setting.id}`);
    }
    void i18n.language;
    void ui.activeNoteId;
    if (redrawTimer) clearTimeout(redrawTimer);
    // Untracked: a redraw sets `view`, which must not schedule another.
    const delay = untrack(() => (view ? 150 : 0));
    redrawTimer = setTimeout(() => enqueue(redraw), delay);
  });

  $effect(() =>
    onSidebarViewAction(source, (actionId) => dispatch({ event: actionId }))
  );

  onDestroy(() => {
    destroyed = true;
    if (redrawTimer) clearTimeout(redrawTimer);
  });
</script>

<div
  class="themed-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto {tab
    ? 'h-full p-3'
    : 'px-3 pb-3'}"
  data-plugin-view={source}
>
  {#if failure}
    <p class="px-1 py-3 text-xs text-destructive">{failure}</p>
  {/if}
  {#if view}{@render node(view)}{/if}
</div>

{#snippet node(n: ViewNode)}
  {#if n.type === 'stack'}
    <div class="flex min-h-0 flex-1 flex-col">
      {#each n.children as child, i (i)}{@render node(child)}{/each}
    </div>
  {:else if n.type === 'heading'}
    <h3
      class="mt-4 px-1 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
    >
      {viewText(pluginId, n.text)}
    </h3>
  {:else if n.type === 'text'}
    <p
      class="px-1 py-1 text-xs {n.tone === 'muted'
        ? 'text-muted-foreground'
        : n.tone === 'accent'
          ? 'text-accent-brand'
          : ''}"
    >
      {viewText(pluginId, n.text)}
    </p>
  {:else if n.type === 'button'}
    <Button
      variant="outline"
      size="sm"
      class="my-1 justify-start gap-2 text-xs"
      onclick={() => dispatch(n.on)}
    >
      {#if n.icon}<PluginIcon {pluginId} file={n.icon} class="size-3.5" />{/if}
      {viewText(pluginId, n.label)}
    </Button>
  {:else if n.type === 'calendar'}
    <SchemaCalendar
      {pluginId}
      node={n}
      onEvent={(event, value) => dispatch({ event }, value)}
    />
  {:else if n.type === 'graph'}
    <SchemaGraph
      node={n}
      onEvent={(event, value) => dispatch({ event }, value)}
    />
  {:else if n.type === 'list'}
    <ul class="flex flex-col text-[13px]">
      {#each n.items as item, i (i)}
        <li>
          <button
            type="button"
            disabled={!item.on}
            class="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-accent disabled:hover:bg-transparent {item.tone ===
            'muted'
              ? 'text-muted-foreground hover:text-foreground'
              : ''}"
            onclick={() => dispatch(item.on)}
          >
            {#if item.noteKind}
              <NoteKindIcon
                kind={item.noteKind}
                class="size-3.5 shrink-0 text-muted-foreground"
              />
            {:else if item.icon}
              <PluginIcon
                {pluginId}
                file={item.icon}
                class="size-3.5 shrink-0 {item.tone === 'accent'
                  ? 'text-accent-brand'
                  : ''}"
              />
            {/if}
            <span class="min-w-0 flex-1 truncate"
              >{viewText(pluginId, item.label)}</span
            >
            {#if item.detail}<span
                class="max-w-24 shrink-0 truncate text-xs text-muted-foreground"
                >{viewText(pluginId, item.detail)}</span
              >{/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}
