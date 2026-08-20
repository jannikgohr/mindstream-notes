<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { Popover, Portal } from 'bits-ui';
  import {
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
      button: PluginToolbarButton,
      placement: 'toolbar' | 'submenu'
    ) => Promise<boolean>;
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
  type DropContainer = 'top' | 'custom-toolbar' | 'custom-more';

  interface PointerDrag {
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    grabX: number;
    grabY: number;
    width: number;
    height: number;
    orientation: 'horizontal' | 'vertical';
    moved: boolean;
  }

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
  let pointerDrag = $state<PointerDrag | null>(null);
  let dropContainer = $state<DropContainer | null>(null);
  let dropSection = $state<keyof FileTreeToolbarPreferences | null>(null);
  let dropIndex = $state<number | null>(null);
  let dropBeforeId = $state<string | undefined>(undefined);
  let suppressClickId = $state<string | null>(null);

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
  const draggedId = $derived(pointerDrag?.moved ? pointerDrag.id : null);
  const draggedAction = $derived(
    draggedId ? (actionMap.get(draggedId) ?? null) : null
  );
  const renderedTopActions = $derived(
    draggedId
      ? displayedToolbarActions.filter((action) => action.id !== draggedId)
      : displayedToolbarActions
  );
  const renderedCustomToolbarActions = $derived(
    draggedId
      ? configuredToolbarActions.filter((action) => action.id !== draggedId)
      : configuredToolbarActions
  );
  const renderedCustomMoreActions = $derived(
    draggedId
      ? configuredMoreActions.filter((action) => action.id !== draggedId)
      : configuredMoreActions
  );

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
    return () => {
      observer.disconnect();
      cleanupPointerDrag();
    };
  });

  function labelFor(action: CreateAction): string {
    return action.type === 'core' ? tUi(action.labelKey) : action.label;
  }

  async function runAction(
    action: CreateAction,
    anchor: HTMLElement,
    placement: 'toolbar' | 'submenu' = 'toolbar'
  ) {
    if (suppressClickId === action.id) {
      suppressClickId = null;
      return;
    }
    if (action.type === 'core') {
      onCreate(action.id);
      moreOpen = false;
      return;
    }
    const keepOpen = await onPluginAction(
      anchor,
      action.pluginId,
      action.button,
      placement
    );
    if (!keepOpen) moreOpen = false;
  }

  function persist(next: FileTreeToolbarPreferences) {
    preferences = normalizeFileTreeToolbarPreferences(next, availableIds);
    saveFileTreeToolbarPreferences(preferences);
  }

  function resetPreferences() {
    persist(DEFAULT_FILE_TREE_TOOLBAR_PREFERENCES);
  }

  function startPointerDrag(
    event: PointerEvent,
    actionId: string,
    orientation: 'horizontal' | 'vertical'
  ) {
    if (event.button !== 0 || pointerDrag) return;
    if (orientation === 'vertical') event.preventDefault();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    pointerDrag = {
      id: actionId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      grabX: event.clientX - rect.left,
      grabY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      orientation,
      moved: false
    };
    window.addEventListener('pointermove', movePointerDrag, true);
    window.addEventListener('pointerup', finishPointerDrag, true);
    window.addEventListener('pointercancel', cancelPointerDrag, true);
  }

  function movePointerDrag(event: PointerEvent) {
    if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
    const moved =
      pointerDrag.moved ||
      Math.hypot(
        event.clientX - pointerDrag.startX,
        event.clientY - pointerDrag.startY
      ) >= 4;
    pointerDrag = {
      ...pointerDrag,
      x: event.clientX,
      y: event.clientY,
      moved
    };
    if (!moved) return;
    event.preventDefault();
    suppressClickId = pointerDrag.id;
    updatePointerDrop(event.clientX, event.clientY);
  }

  function updatePointerDrop(clientX: number, clientY: number) {
    const container = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>('[data-file-tree-drop-container]');
    if (!container) {
      dropContainer = null;
      dropSection = null;
      dropIndex = null;
      dropBeforeId = undefined;
      return;
    }
    const containerId = container.dataset.fileTreeDropContainer as
      | DropContainer
      | undefined;
    const section = container.dataset.section as
      | keyof FileTreeToolbarPreferences
      | undefined;
    const orientation = container.dataset.orientation;
    if (!containerId || !section || !orientation) return;

    const rows = Array.from(
      container.querySelectorAll<HTMLElement>('[data-file-tree-action-id]')
    ).filter(
      (row) =>
        row.dataset.fileTreeActionId !== pointerDrag?.id &&
        row.closest('[data-file-tree-drop-container]') === container
    );
    let index = rows.length;
    for (let i = 0; i < rows.length; i += 1) {
      const rect = rows[i].getBoundingClientRect();
      const before =
        orientation === 'horizontal'
          ? clientX < rect.left + rect.width / 2
          : clientY < rect.top + rect.height / 2;
      if (before) {
        index = i;
        break;
      }
    }
    dropContainer = containerId;
    dropSection = section;
    dropIndex = index;
    dropBeforeId = rows[index]?.dataset.fileTreeActionId;
    if (containerId === 'top' && !dropBeforeId) {
      const displayedIds = new Set(
        displayedToolbarActions.map((action) => action.id)
      );
      dropBeforeId = configuredToolbarActions.find(
        (action) => !displayedIds.has(action.id)
      )?.id;
    }
  }

  function finishPointerDrag(event: PointerEvent) {
    if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
    const drag = pointerDrag;
    if (drag.moved) event.preventDefault();
    if (
      drag.moved &&
      dropSection &&
      dropIndex !== null &&
      !(
        dropSection === 'more' &&
        preferences.toolbar.includes(drag.id) &&
        preferences.toolbar.length === 1
      )
    ) {
      persist(
        moveFileTreeToolbarAction(
          preferences,
          drag.id,
          dropSection,
          dropBeforeId
        )
      );
    }
    cleanupPointerDrag();
    setTimeout(() => {
      if (suppressClickId === drag.id) suppressClickId = null;
    }, 0);
  }

  function cancelPointerDrag(event: PointerEvent) {
    if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
    cleanupPointerDrag();
  }

  function cleanupPointerDrag() {
    window.removeEventListener('pointermove', movePointerDrag, true);
    window.removeEventListener('pointerup', finishPointerDrag, true);
    window.removeEventListener('pointercancel', cancelPointerDrag, true);
    pointerDrag = null;
    dropContainer = null;
    dropSection = null;
    dropIndex = null;
    dropBeforeId = undefined;
  }

  function placeholderAt(container: DropContainer, index: number): boolean {
    return dropContainer === container && dropIndex === index;
  }

  function closeMenu() {
    moreOpen = false;
    customizing = false;
    cleanupPointerDrag();
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
  data-file-tree-drop-container="top"
  data-section="toolbar"
  data-orientation="horizontal"
  class="flex min-w-0 flex-1 justify-end gap-1 overflow-hidden"
>
  {#each renderedTopActions as action, index (action.id)}
    {#if placeholderAt('top', index)}
      <div
        class="h-7 w-7 shrink-0 rounded-md border border-dashed border-primary bg-primary/10"
        aria-hidden="true"
      ></div>
    {/if}
    <div
      role="group"
      aria-label={labelFor(action)}
      data-file-tree-action-id={action.id}
      class="relative shrink-0 touch-none"
      onpointerdown={(event) =>
        startPointerDrag(event, action.id, 'horizontal')}
    >
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
  {#if placeholderAt('top', renderedTopActions.length)}
    <div
      class="h-7 w-7 shrink-0 rounded-md border border-dashed border-primary bg-primary/10"
      aria-hidden="true"
    ></div>
  {/if}

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
          class="size-7 shrink-0"
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

          <div class="max-h-[min(28rem,70vh)] select-none overflow-y-auto p-2">
            <p
              class="px-1 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
            >
              {tUi('fileTree.toolbar.shown')}
            </p>
            <div
              role="list"
              aria-label={tUi('fileTree.toolbar.shown')}
              data-file-tree-drop-container="custom-toolbar"
              data-section="toolbar"
              data-orientation="vertical"
              class="min-h-9 space-y-0.5 rounded-md"
            >
              {#each renderedCustomToolbarActions as action, index (action.id)}
                {#if placeholderAt('custom-toolbar', index)}
                  <div
                    class="h-8 rounded-md border border-dashed border-primary bg-primary/10"
                    aria-hidden="true"
                  ></div>
                {/if}
                <div
                  role="listitem"
                  data-file-tree-action-id={action.id}
                  class="group flex touch-none select-none cursor-grab items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-accent active:cursor-grabbing"
                  onpointerdown={(event) =>
                    startPointerDrag(event, action.id, 'vertical')}
                >
                  <GripVertical
                    class="size-3.5 shrink-0 cursor-grab text-muted-foreground"
                  />
                  {@render actionIcon(action, 'size-4 shrink-0')}
                  <span class="min-w-0 flex-1 truncate text-sm"
                    >{labelFor(action)}</span
                  >
                </div>
              {/each}
              {#if placeholderAt('custom-toolbar', renderedCustomToolbarActions.length)}
                <div
                  class="h-8 rounded-md border border-dashed border-primary bg-primary/10"
                  aria-hidden="true"
                ></div>
              {/if}
            </div>

            <p
              class="mt-3 px-1 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
            >
              {tUi('fileTree.toolbar.more')}
            </p>
            <div
              role="list"
              aria-label={tUi('fileTree.toolbar.more')}
              data-file-tree-drop-container="custom-more"
              data-section="more"
              data-orientation="vertical"
              class="min-h-9 space-y-0.5 rounded-md"
            >
              {#each renderedCustomMoreActions as action, index (action.id)}
                {#if placeholderAt('custom-more', index)}
                  <div
                    class="h-8 rounded-md border border-dashed border-primary bg-primary/10"
                    aria-hidden="true"
                  ></div>
                {/if}
                <div
                  role="listitem"
                  data-file-tree-action-id={action.id}
                  class="group flex touch-none select-none cursor-grab items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-accent active:cursor-grabbing"
                  onpointerdown={(event) =>
                    startPointerDrag(event, action.id, 'vertical')}
                >
                  <GripVertical
                    class="size-3.5 shrink-0 cursor-grab text-muted-foreground"
                  />
                  {@render actionIcon(action, 'size-4 shrink-0')}
                  <span class="min-w-0 flex-1 truncate text-sm"
                    >{labelFor(action)}</span
                  >
                </div>
              {/each}
              {#if placeholderAt('custom-more', renderedCustomMoreActions.length)}
                <div
                  class="h-8 rounded-md border border-dashed border-primary bg-primary/10"
                  aria-hidden="true"
                ></div>
              {/if}
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
                onclick={(event) =>
                  runAction(action, event.currentTarget, 'submenu')}
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

{#if pointerDrag?.moved && draggedAction}
  <Portal to="body">
    <div
      class="pointer-events-none fixed z-[500] rounded-md border border-border bg-popover text-popover-foreground opacity-95 shadow-lg"
      style:left={`${pointerDrag.x - pointerDrag.grabX}px`}
      style:top={`${pointerDrag.y - pointerDrag.grabY}px`}
      style:width={`${pointerDrag.width}px`}
      style:height={`${pointerDrag.height}px`}
      aria-hidden="true"
    >
      {#if pointerDrag.orientation === 'horizontal'}
        <div class="flex h-full w-full items-center justify-center rounded-md">
          {@render actionIcon(draggedAction)}
        </div>
      {:else}
        <div class="flex h-full items-center gap-2 px-1.5">
          <GripVertical class="size-3.5 shrink-0 text-muted-foreground" />
          {@render actionIcon(draggedAction, 'size-4 shrink-0')}
          <span class="min-w-0 flex-1 truncate text-sm">
            {labelFor(draggedAction)}
          </span>
        </div>
      {/if}
    </div>
  </Portal>
{/if}
