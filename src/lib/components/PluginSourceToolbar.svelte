<script lang="ts">
  import type { EditorView } from '@codemirror/view';
  import { Toolbar, ToolbarButton } from '$lib/components/ui/toolbar';
  import PluginIcon from '$lib/plugins/PluginIcon.svelte';
  import { runPluginButton } from '$lib/plugins/effects';
  import { resolvePluginString } from '$lib/plugins/plugin-i18n';
  import { pluginToolbarButtons } from '$lib/plugins/registry.svelte';
  import { applyPluginSourceEdit } from '$lib/editor/source/plugin-source-actions';

  interface Props {
    noteKind: string;
    getView: () => EditorView | null;
    class?: string;
    dense?: boolean;
  }

  let {
    noteKind,
    getView,
    class: className = '',
    dense = true
  }: Props = $props();

  const buttons = $derived(pluginToolbarButtons('note-editor', { noteKind }));

  function runButton(
    button: (typeof buttons)[number],
    trigger: HTMLElement
  ): void {
    const action = button.button.action;
    if (action.type === 'script') {
      const rect = trigger.getBoundingClientRect();
      void runPluginButton(button.pluginId, button.button, {
        x: rect.left,
        y: rect.bottom
      });
      return;
    }
    const view = getView();
    if (!view) return;
    applyPluginSourceEdit(view, action);
  }
</script>

{#if buttons.length > 0}
  <Toolbar
    {dense}
    class="w-full {className}"
    aria-label="Plugin editor toolbar"
  >
    {#each buttons as button (`${button.pluginId}:${button.button.id}`)}
      {@const label = resolvePluginString(
        button.pluginId,
        button.button.labelKey
      )}
      <ToolbarButton
        holdFocus
        title={label}
        aria-label={label}
        onclick={(event) =>
          runButton(button, event.currentTarget as HTMLElement)}
      >
        <PluginIcon
          pluginId={button.pluginId}
          file={button.button.icon}
          class="size-4"
        />
      </ToolbarButton>
    {/each}
  </Toolbar>
{/if}
