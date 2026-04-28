<script lang="ts">
  import { mount, unmount, onDestroy, onMount, tick } from 'svelte';
  import type {
    DockviewApi,
    IDockviewPanel,
    IContentRenderer,
    GroupPanelPartInitParameters
  } from 'dockview-core';
  import TopBar from './TopBar.svelte';
  import FileExplorer from './FileExplorer.svelte';
  import MetadataPanel from './MetadataPanel.svelte';
  import NoteEditor from './NoteEditor.svelte';
  import ResizeHandle from './ResizeHandle.svelte';
  import {
    notes,
    setActiveNote,
    setLeftSidebarWidth,
    setRightSidebarWidth,
    ui
  } from '$lib/state.svelte';

  let dockHost: HTMLDivElement | null = $state(null);
  let dock: DockviewApi | null = null;

  // Track which note ids are currently open as panels so we can focus an
  // existing tab instead of creating a duplicate.
  const openPanels = new Map<string, IDockviewPanel>();

  /** Renders a Svelte component inside a dockview panel. */
  class SvelteRenderer implements IContentRenderer {
    private el: HTMLElement = document.createElement('div');
    private instance: ReturnType<typeof mount> | null = null;

    get element(): HTMLElement {
      return this.el;
    }

    init(parameters: GroupPanelPartInitParameters): void {
      this.el.style.height = '100%';
      this.el.style.width = '100%';
      const noteId = (parameters.params as { noteId?: string })?.noteId;
      if (!noteId) return;
      this.instance = mount(NoteEditor, {
        target: this.el,
        props: { noteId }
      });
    }

    dispose(): void {
      if (this.instance) {
        unmount(this.instance);
        this.instance = null;
      }
    }
  }

  async function setupDockview() {
    if (!dockHost) return;
    // dockview-core is browser-only — dynamic import so SSR/prerender is safe.
    const { DockviewComponent } = await import('dockview-core');

    const component = new DockviewComponent(dockHost, {
      createComponent: (options) => {
        switch (options.name) {
          case 'noteEditor':
            return new SvelteRenderer();
          default:
            return new SvelteRenderer();
        }
      },
      theme: { name: 'bridge', className: 'dockview-theme-bridge' },
      // Multi-pane behaviour:
      //   - Drag a tab to the edge of a group to split that group.
      //   - Drag a tab into another group's tab strip to move it there.
      //   - Drag a tab outside the dock to pop it into a floating window.
      // dockview-core 4 enables all of these by default; we just keep the
      // option keys here so future tweaks have an obvious home.
      disableFloatingGroups: false,
      disableDnd: false
    });

    dock = component.api;

    dock.onDidActivePanelChange((panel) => {
      if (panel?.params && typeof panel.params.noteId === 'string') {
        setActiveNote(panel.params.noteId);
      }
    });

    // Track tab closures so `openPanels` stays in sync.
    dock.onDidRemovePanel((panel) => {
      const noteId = (panel.params as { noteId?: string } | undefined)?.noteId;
      if (noteId) openPanels.delete(noteId);
    });

    // Demo a multi-pane layout on first load:
    //   - "Welcome" opens in the main group.
    //   - "Sprint planning" opens in a split to the right.
    //   - "Ideas" opens as a second tab in the right-hand group.
    openNote('welcome');
    openNote('meeting', { splitDirection: 'right' });
    openNote('ideas', { splitDirection: 'within', referenceNoteId: 'meeting' });
  }

  type SplitDirection = 'right' | 'left' | 'above' | 'below' | 'within';
  interface OpenNoteOptions {
    splitDirection?: SplitDirection;
    /** Existing note id to position relative to. Defaults to the active panel. */
    referenceNoteId?: string;
  }

  export function openNote(id: string, opts: OpenNoteOptions = {}) {
    if (!dock) return;
    const note = notes.byId[id];
    if (!note) return;

    const existing = openPanels.get(id);
    if (existing) {
      existing.api.setActive();
      return;
    }

    // Only attach `position` when we have a real reference panel — dockview
    // requires referencePanel to be a string (or IDockviewPanel), not optional.
    let position: { referencePanel: string; direction: SplitDirection } | undefined;
    if (opts.splitDirection) {
      const referencePanel = opts.referenceNoteId
        ? `note:${opts.referenceNoteId}`
        : dock.activePanel?.id;
      if (referencePanel) {
        position = { referencePanel, direction: opts.splitDirection };
      }
    }

    const panel = dock.addPanel({
      id: `note:${id}`,
      component: 'noteEditor',
      title: note.title,
      params: { noteId: id },
      ...(position ? { position } : {})
    });

    openPanels.set(id, panel);
    setActiveNote(id);
  }

  onMount(() => {
    // Defer one tick so the host div has a real size before dockview measures.
    void tick().then(setupDockview);

    // dockview-core's internal ResizeObserver picks up size changes
    // automatically; this listener is a no-op kept for future hooks.
    const onResize = () => {};
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  onDestroy(() => {
    dock?.clear();
  });

  // React to sidebar collapse / resize: dispatch a synthetic resize so
  // dockview re-measures immediately rather than waiting for the next paint.
  $effect(() => {
    void ui.leftSidebarOpen;
    void ui.rightSidebarOpen;
    void ui.leftSidebarWidth;
    void ui.rightSidebarWidth;
    if (!dockHost) return;
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
    });
  });

  // Adapter functions handed to FileExplorer so it can request specific layouts.
  const onOpenNote = (id: string) => openNote(id);
  const onOpenNoteRight = (id: string) => openNote(id, { splitDirection: 'right' });
  const onOpenNoteBelow = (id: string) => openNote(id, { splitDirection: 'below' });
</script>

<div class="flex h-full w-full flex-col">
  <TopBar />

  <div class="flex min-h-0 flex-1">
    {#if ui.leftSidebarOpen}
      <div
        class="shrink-0 border-r border-border"
        style="width: {ui.leftSidebarWidth}px;"
      >
        <FileExplorer {onOpenNote} {onOpenNoteRight} {onOpenNoteBelow} />
      </div>
      <ResizeHandle
        side="left"
        value={ui.leftSidebarWidth}
        min={200}
        max={500}
        onChange={setLeftSidebarWidth}
      />
    {/if}

    <main class="min-w-0 flex-1">
      <div bind:this={dockHost} class="dockview-theme-bridge h-full w-full"></div>
    </main>

    {#if ui.rightSidebarOpen}
      <ResizeHandle
        side="right"
        value={ui.rightSidebarWidth}
        min={200}
        max={500}
        onChange={setRightSidebarWidth}
      />
      <div
        class="shrink-0 border-l border-border"
        style="width: {ui.rightSidebarWidth}px;"
      >
        <MetadataPanel />
      </div>
    {/if}
  </div>
</div>
