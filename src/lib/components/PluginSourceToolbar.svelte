<script lang="ts">
  import type { EditorView } from '@codemirror/view';
  import { ChevronDown } from '@lucide/svelte';
  import { Toolbar, ToolbarButton } from '$lib/components/ui/toolbar';
  import {
    TOOLBAR_ITEMS,
    type ToolbarGroup,
    type ToolbarItem,
    type ToolbarLeaf
  } from '$lib/components/editor-toolbar/commands';
  import ToolbarMenu, {
    type MenuEntry
  } from '$lib/components/editor-toolbar/ToolbarMenu.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { pluginToolbarButtons } from '$lib/plugins/registry.svelte';
  import { applyPluginSourceEdit } from '$lib/editor/source/plugin-source-actions';
  import { SOURCE_ACTIONS } from '$lib/editor/source/source-actions';
  import { APP_REDO_COMMAND, APP_UNDO_COMMAND } from '$lib/hotkeys/bus.svelte';
  import type { PluginSourceEditAction } from '$lib/plugins/types';

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

  let openGroupId = $state<string | null>(null);
  let openTriggerEl = $state<HTMLElement | null>(null);

  const contributedActions = $derived.by<
    Record<string, PluginSourceEditAction>
  >(() => {
    const out: Record<string, PluginSourceEditAction> = {};
    for (const { button } of pluginToolbarButtons('note-editor', {
      noteKind
    })) {
      if (!button.toolbarItem || button.action.type === 'script') continue;
      out[button.toolbarItem] = button.action;
    }
    return out;
  });

  function sourceActionFor(
    id: string
  ): PluginSourceEditAction | 'undo' | 'redo' | null {
    if (id === 'undo') return 'undo';
    if (id === 'redo') return 'redo';
    return contributedActions[id] ?? null;
  }

  const visibleItems = $derived.by<ToolbarItem[]>(() => {
    const result: ToolbarItem[] = [];
    for (const item of TOOLBAR_ITEMS) {
      if (item.kind === 'leaf') {
        if (sourceActionFor(item.id)) result.push(item);
        continue;
      }
      const items = item.items.filter((leaf) => sourceActionFor(leaf.id));
      if (items.length > 0) result.push({ ...item, items });
    }
    return result;
  });

  function closeMenus(): void {
    openGroupId = null;
    openTriggerEl = null;
  }

  function toggleGroup(item: ToolbarGroup, btn: HTMLElement | null): void {
    if (!btn) return;
    if (openGroupId === item.id) {
      closeMenus();
      return;
    }
    openGroupId = item.id;
    openTriggerEl = btn;
  }

  function runLeaf(item: ToolbarLeaf): void {
    const view = getView();
    if (!view) return;
    const action = sourceActionFor(item.id);
    if (!action) return;
    if (action === 'undo') {
      SOURCE_ACTIONS[APP_UNDO_COMMAND]?.(view);
    } else if (action === 'redo') {
      SOURCE_ACTIONS[APP_REDO_COMMAND]?.(view);
    } else {
      applyPluginSourceEdit(view, action);
    }
    closeMenus();
  }

  function groupEntries(group: ToolbarGroup): MenuEntry[] {
    return group.items.map((leaf) => ({
      kind: 'item' as const,
      id: leaf.id,
      labelKey: leaf.labelKey,
      icon: leaf.icon,
      hotkeyId: leaf.hotkeyId,
      onSelect: () => runLeaf(leaf)
    }));
  }

  const openGroup = $derived.by<ToolbarGroup | null>(() => {
    if (!openGroupId) return null;
    const found = visibleItems.find((item) => item.id === openGroupId);
    return found?.kind === 'group' ? found : null;
  });
</script>

{#if visibleItems.length > 0}
  <Toolbar
    {dense}
    class="w-full overflow-hidden {className}"
    aria-label={tUi('editor.toolbar.label')}
  >
    {#each visibleItems as item (item.id)}
      {#if item.kind === 'leaf'}
        {@const Icon = item.icon}
        <ToolbarButton
          holdFocus
          title={tUi(item.labelKey)}
          aria-label={tUi(item.labelKey)}
          onclick={() => runLeaf(item)}
        >
          <Icon aria-hidden="true" />
        </ToolbarButton>
      {:else}
        {@const Icon = item.icon}
        {@const open = openGroupId === item.id}
        <ToolbarButton
          wide
          holdFocus
          active={open}
          title={tUi(item.labelKey)}
          aria-label={tUi(item.labelKey)}
          aria-expanded={open}
          aria-haspopup="menu"
          onclick={(event) =>
            toggleGroup(item, event.currentTarget as HTMLElement)}
        >
          <Icon aria-hidden="true" />
          <ChevronDown
            class="opacity-60 transition-transform {open ? 'rotate-180' : ''}"
            aria-hidden="true"
          />
        </ToolbarButton>
      {/if}
    {/each}
  </Toolbar>

  {#if openGroup && openTriggerEl}
    <ToolbarMenu
      trigger={openTriggerEl}
      placement="bottom"
      entries={groupEntries(openGroup)}
      onClose={closeMenus}
    />
  {/if}
{/if}
