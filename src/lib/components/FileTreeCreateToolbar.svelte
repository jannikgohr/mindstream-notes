<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { Popover } from 'bits-ui';
  import {
    Check,
    Feather,
    FilePlus2,
    FileUp,
    FolderPlus,
    GripVertical,
    MoreHorizontal,
    PencilRuler,
    RotateCcw,
    Settings2,
    SquareKanban
  } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import PluginIcon from '$lib/plugins/PluginIcon.svelte';
  import { resolvePluginString } from '$lib/plugins/plugin-i18n';
  import type { PluginToolbarButtonRef } from '$lib/plugins/registry.svelte';
  import type { PluginToolbarButton } from '$lib/plugins/types';
  import { noteTypeEnabled } from '$lib/notes/note-types';
  import { tUi } from '$lib/settings/i18n.svelte';
  import {
    CORE_FILE_TREE_ACTION_IDS,
    DEFAULT_FILE_TREE_TOOLBAR_PREFERENCES,
    loadFileTreeToolbarPreferences,
    moveFileTreeToolbarAction,
    normalizeFileTreeToolbarPreferences,
    saveFileTreeToolbarPreferences,
    type CoreFileTreeActionId,
    type FileTreeToolbarPreferences
  } from './file-tree-toolbar-preferences';

  interface Props {
    pluginButtons?: PluginToolbarButtonRef[];
    onCreate: (action: CoreFileTreeActionId) => void;
    onPluginAction: (
      anchor: HTMLElement,
      pluginId: string,
      button: PluginToolbarButton
    ) => void;
  }

  type CoreAction = {
    id: CoreFileTreeActionId;
    type: 'core';
    labelKey: string;
  };

  type PluginAction = {
    id: string;
    type: 'plugin';
    label: string;
    pluginId: string;
    button: PluginToolbarButton;
  };

  type CreateAction = CoreAction | PluginAction;

  let { pluginButtons = [], onCreate, onPluginAction }: Props = $props();

  const coreActions: CoreAction[] = [
    { id: 'note', type: 'core', labelKey: 'fileTree.newNote' },
    { id: 'folder', type: 'core', labelKey: 'fileTree.newFolder' },
    { id: 'drawing', type: 'core', labelKey: 'fileTree.newDrawing' },
    { id: 'ink', type: 'core', labelKey: 'fileTree.newInk' },
    { id: 'kanban', type: 'core', labelKey: 'fileTree.newKanban' },
    { id: 'pdf', type: 'core', labelKey: 'fileTree.importPdf' }
  ];

  let root = $state<HTMLDivElement | null>(null);
  let moreOpen = $state(false);
  let customizing = $state(false);
  let preferences = $state<FileTreeToolbarPreferences>({
    toolbar: [...DEFAULT_FILE_TREE_TOOLBAR_PREFERENCES.toolbar],
    more: [...DEFAULT_FILE_TREE_TOOLBAR_PREFERENCES.more]
  });
  let preferencesLoaded = $state(false);
  let visibleCapacity = $state(Number.POSITIVE_INFINITY);
  let draggedId = $state<string | null>(null);
  let dropTarget = $state<string | null>(null);
  let dropSection = $state<keyof FileTreeToolbarPreferences | null>(null);
  let dropAfter = $state(false);

  const pluginActions = $derived(
    pluginButtons.map(
      ({ pluginId, button }): PluginAction => ({
        id: `plugin:${pluginId}:${button.id}`,
        type: 'plugin',
        label: resolvePluginString(pluginId, button.labelKey ?? button.id),
        pluginId,
        button
      })
    )
  );

  const enabledCoreActions = $derived(
    coreActions.filter((action) => {
      if (action.id === 'folder' || action.id === 'note') return true;
      const noteType = action.id === 'drawing' ? 'freeform' : action.id;
      return noteTypeEnabled(noteType);
    })
  );
  const actions = $derived<CreateAction[]>([
    ...enabledCoreActions,
    ...pluginActions
  ]);
  const availableIds = $derived([
    ...CORE_FILE_TREE_ACTION_IDS,
    ...pluginActions.map((action) => action.id)
  ]);
  const actionMap = $derived(
    new Map(actions.map((action) => [action.id, action]))
  );
  const configuredToolbarActions = $derived(
    preferences.toolbar
      .map((id) => actionMap.get(id))
      .filter((action): action is CreateAction => !!action)
  );
  const displayedToolbarActions = $derived(
    configuredToolbarActions.slice(0, visibleCapacity)
  );
  const responsiveOverflowActions = $derived(
    configuredToolbarActions.slice(visibleCapacity)
  );
  const configuredMoreActions = $derived(
    preferences.more
      .map((id) => actionMap.get(id))
      .filter((action): action is CreateAction => !!action)
  );
  const menuActions = $derived([
    ...responsiveOverflowActions,
    ...configuredMoreActions
  ]);

  $effect(() => {
    const ids = availableIds;
    if (!preferencesLoaded) return;
    const current = untrack(() => preferences);
    const next = normalizeFileTreeToolbarPreferences(current, ids);
    if (JSON.stringify(next) !== JSON.stringify(current)) preferences = next;
  });

  onMount(() => {
    preferences = loadFileTreeToolbarPreferences(availableIds);
    preferencesLoaded = true;

    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      const moreButtonWidth = 32;
      const actionWidth = 32;
      visibleCapacity = Math.max(
        1,
        Math.floor((width - moreButtonWidth) / actionWidth)
      );
    });
    if (root) observer.observe(root);
    return () => observer.disconnect();
  });

  function labelFor(action: CreateAction): string {
    return action.type === 'core' ? tUi(action.labelKey) : action.label;
  }

  function runAction(action: CreateAction, anchor: HTMLElement) {
    if (action.type === 'core') onCreate(action.id);
    else onPluginAction(anchor, action.pluginId, action.button);
    moreOpen = false;
  }

  function persist(next: FileTreeToolbarPreferences) {
    preferences = normalizeFileTreeToolbarPreferences(next, availableIds);
    saveFileTreeToolbarPreferences(preferences);
  }

  function moveAction(
    actionId: string,
    destination: keyof FileTreeToolbarPreferences,
    beforeId?: string
  ) {
    if (
      destination === 'more' &&
      preferences.toolbar.includes(actionId) &&
      preferences.toolbar.length === 1
    ) {
      return;
    }
    persist(
      moveFileTreeToolbarAction(preferences, actionId, destination, beforeId)
    );
  }

  function resetPreferences() {
    persist(DEFAULT_FILE_TREE_TOOLBAR_PREFERENCES);
  }

  function startDrag(event: DragEvent, actionId: string) {
    draggedId = actionId;
    event.dataTransfer?.setData('text/x-file-tree-toolbar-action', actionId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  function readDraggedId(event: DragEvent): string | null {
    return (
      draggedId ??
      event.dataTransfer?.getData('text/x-file-tree-toolbar-action') ??
      null
    );
  }

  function dragOverAction(
    event: DragEvent,
    section: keyof FileTreeToolbarPreferences,
    actionId: string,
    orientation: 'horizontal' | 'vertical'
  ) {
    if (!readDraggedId(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    dropAfter =
      orientation === 'horizontal'
        ? event.clientX > rect.left + rect.width / 2
        : event.clientY > rect.top + rect.height / 2;
    dropSection = section;
    dropTarget = actionId;
  }

  function dragOverSection(
    event: DragEvent,
    section: keyof FileTreeToolbarPreferences
  ) {
    if (!readDraggedId(event)) return;
    event.preventDefault();
    dropSection = section;
    dropTarget = null;
    dropAfter = false;
  }

  function dropRelativeToAction(
    event: DragEvent,
    section: keyof FileTreeToolbarPreferences,
    actionId: string
  ) {
    const order = preferences[section];
    const targetIndex = order.indexOf(actionId);
    const beforeId =
      dropAfter && targetIndex >= 0 ? order[targetIndex + 1] : actionId;
    dropAction(event, section, beforeId);
  }

  function dropAction(
    event: DragEvent,
    section: keyof FileTreeToolbarPreferences,
    beforeId?: string
  ) {
    event.preventDefault();
    const actionId = readDraggedId(event);
    if (actionId) moveAction(actionId, section, beforeId);
    endDrag();
  }

  function endDrag() {
    draggedId = null;
    dropTarget = null;
    dropSection = null;
    dropAfter = false;
  }

  function closeMenu() {
    moreOpen = false;
    customizing = false;
    endDrag();
  }
</script>

{#snippet actionIcon(action: CreateAction, className = 'size-3.5')}
  {#if action.type === 'plugin'}
    <PluginIcon
      pluginId={action.pluginId}
      file={action.button.icon ?? ''}
      class={className}
    />
  {:else if action.id === 'note'}
    <FilePlus2 class={className} />
  {:else if action.id === 'folder'}
    <FolderPlus class={className} />
  {:else if action.id === 'drawing'}
    <PencilRuler class={className} />
  {:else if action.id === 'ink'}
    <Feather class={className} />
  {:else if action.id === 'kanban'}
    <SquareKanban class={className} />
  {:else}
    <FileUp class={className} />
  {/if}
{/snippet}

<div
  bind:this={root}
  class="flex min-w-0 flex-1 justify-end gap-1 overflow-hidden"
>
  {#each displayedToolbarActions as action (action.id)}
    <div
      role="group"
      aria-label={labelFor(action)}
      class="relative shrink-0"
      class:opacity-50={draggedId === action.id}
      draggable="true"
      ondragstart={(event) => startDrag(event, action.id)}
      ondragend={endDrag}
      ondragover={(event) =>
        dragOverAction(event, 'toolbar', action.id, 'horizontal')}
      ondrop={(event) => dropRelativeToAction(event, 'toolbar', action.id)}
    >
      {#if dropSection === 'toolbar' && dropTarget === action.id}
        <span
          class="pointer-events-none absolute top-1 bottom-1 z-10 w-0.5 rounded-full bg-primary {dropAfter
            ? '-right-0.5'
            : '-left-0.5'}"
        ></span>
      {/if}
      <Button
        variant="ghost"
        size="icon"
        onclick={(event) => runAction(action, event.currentTarget)}
        title={labelFor(action)}
        aria-label={labelFor(action)}
        class="size-7 cursor-grab active:cursor-grabbing"
      >
        {@render actionIcon(action)}
      </Button>
    </div>
  {/each}

  <Popover.Root
    bind:open={moreOpen}
    onOpenChange={(open) => !open && closeMenu()}
  >
    <Popover.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="ghost"
          size="icon"
          title={tUi('fileTree.toolbar.more')}
          aria-label={tUi('fileTree.toolbar.more')}
          class="size-7 shrink-0 {customizing && dropSection === 'more'
            ? 'bg-accent'
            : ''}"
          ondragover={(event) => {
            if (customizing) dragOverSection(event, 'more');
          }}
          ondrop={(event) => {
            if (customizing) dropAction(event, 'more');
          }}
        >
          <MoreHorizontal class="size-3.5" />
        </Button>
      {/snippet}
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content
        side="bottom"
        align="end"
        sideOffset={4}
        class="z-[400] w-72 rounded-md border border-border bg-popover text-popover-foreground shadow-md focus:outline-none"
      >
        {#if customizing}
          <div class="border-b border-border px-3 py-2">
            <div class="flex items-center justify-between gap-2">
              <span class="text-sm font-medium">
                {tUi('fileTree.toolbar.customize')}
              </span>
              <Button
                variant="ghost"
                size="icon"
                class="size-7"
                title={tUi('fileTree.toolbar.restore')}
                aria-label={tUi('fileTree.toolbar.restore')}
                onclick={resetPreferences}
              >
                <RotateCcw class="size-3.5" />
              </Button>
            </div>
            <p class="mt-0.5 text-xs text-muted-foreground">
              {tUi('fileTree.toolbar.customizeHint')}
            </p>
          </div>

          <div class="max-h-[min(28rem,70vh)] overflow-y-auto p-2">
            <p
              class="px-1 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
            >
              {tUi('fileTree.toolbar.shown')}
            </p>
            <div
              role="list"
              aria-label={tUi('fileTree.toolbar.shown')}
              class="min-h-9 space-y-0.5 rounded-md"
              class:ring-1={dropSection === 'toolbar' && dropTarget === null}
              class:ring-primary={dropSection === 'toolbar' &&
                dropTarget === null}
              ondragover={(event) => dragOverSection(event, 'toolbar')}
              ondrop={(event) => dropAction(event, 'toolbar')}
            >
              {#each configuredToolbarActions as action (action.id)}
                <div
                  role="listitem"
                  draggable="true"
                  class="group flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-accent"
                  class:opacity-50={draggedId === action.id}
                  class:ring-1={dropSection === 'toolbar' &&
                    dropTarget === action.id}
                  class:ring-primary={dropSection === 'toolbar' &&
                    dropTarget === action.id}
                  ondragstart={(event) => startDrag(event, action.id)}
                  ondragend={endDrag}
                  ondragover={(event) =>
                    dragOverAction(event, 'toolbar', action.id, 'vertical')}
                  ondrop={(event) =>
                    dropRelativeToAction(event, 'toolbar', action.id)}
                >
                  <GripVertical
                    class="size-3.5 shrink-0 cursor-grab text-muted-foreground"
                  />
                  {@render actionIcon(action, 'size-4 shrink-0')}
                  <span class="min-w-0 flex-1 truncate text-sm"
                    >{labelFor(action)}</span
                  >
                  <button
                    type="button"
                    class="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={preferences.toolbar.length === 1}
                    title={tUi('fileTree.toolbar.moveToMore')}
                    aria-label={`${tUi('fileTree.toolbar.moveToMore')}: ${labelFor(action)}`}
                    onclick={() => moveAction(action.id, 'more')}
                  >
                    <MoreHorizontal class="size-3.5" />
                  </button>
                </div>
              {/each}
            </div>

            <p
              class="mt-3 px-1 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
            >
              {tUi('fileTree.toolbar.more')}
            </p>
            <div
              role="list"
              aria-label={tUi('fileTree.toolbar.more')}
              class="min-h-9 space-y-0.5 rounded-md"
              class:ring-1={dropSection === 'more' && dropTarget === null}
              class:ring-primary={dropSection === 'more' && dropTarget === null}
              ondragover={(event) => dragOverSection(event, 'more')}
              ondrop={(event) => dropAction(event, 'more')}
            >
              {#each configuredMoreActions as action (action.id)}
                <div
                  role="listitem"
                  draggable="true"
                  class="group flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-accent"
                  class:opacity-50={draggedId === action.id}
                  class:ring-1={dropSection === 'more' &&
                    dropTarget === action.id}
                  class:ring-primary={dropSection === 'more' &&
                    dropTarget === action.id}
                  ondragstart={(event) => startDrag(event, action.id)}
                  ondragend={endDrag}
                  ondragover={(event) =>
                    dragOverAction(event, 'more', action.id, 'vertical')}
                  ondrop={(event) =>
                    dropRelativeToAction(event, 'more', action.id)}
                >
                  <GripVertical
                    class="size-3.5 shrink-0 cursor-grab text-muted-foreground"
                  />
                  {@render actionIcon(action, 'size-4 shrink-0')}
                  <span class="min-w-0 flex-1 truncate text-sm"
                    >{labelFor(action)}</span
                  >
                  <button
                    type="button"
                    class="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                    title={tUi('fileTree.toolbar.show')}
                    aria-label={`${tUi('fileTree.toolbar.show')}: ${labelFor(action)}`}
                    onclick={() => moveAction(action.id, 'toolbar')}
                  >
                    <Check class="size-3.5" />
                  </button>
                </div>
              {/each}
            </div>
          </div>

          <div class="flex justify-end border-t border-border px-3 py-2">
            <Button
              size="sm"
              class="h-7 px-3 text-xs"
              onclick={() => closeMenu()}
            >
              {tUi('fileTree.toolbar.done')}
            </Button>
          </div>
        {:else}
          <div class="py-1">
            {#each menuActions as action (action.id)}
              <button
                type="button"
                role="menuitem"
                class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                onclick={(event) => runAction(action, event.currentTarget)}
              >
                {@render actionIcon(action, 'size-4 shrink-0')}
                <span class="flex-1 truncate">{labelFor(action)}</span>
              </button>
            {/each}
            {#if menuActions.length > 0}
              <div class="my-1 border-t border-border"></div>
            {/if}
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
              onclick={() => (customizing = true)}
            >
              <Settings2 class="size-4 shrink-0" />
              <span>{tUi('fileTree.toolbar.customize')}</span>
            </button>
          </div>
        {/if}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
</div>
