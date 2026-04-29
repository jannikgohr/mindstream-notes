<script lang="ts">
  import { mount, unmount, onDestroy, onMount, tick } from 'svelte';
  import type {
    DockviewApi,
    IDockviewPanel,
    IContentRenderer,
    GroupPanelPartInitParameters,
    DockviewGroupPanel
  } from 'dockview-core';
  import TopBar from './TopBar.svelte';
  import FileExplorer from './FileExplorer.svelte';
  import MetadataPanel from './MetadataPanel.svelte';
  import NoteEditor from './NoteEditor.svelte';
  import ResizeHandle from './ResizeHandle.svelte';
  import SettingsDialog from '$lib/settings/SettingsDialog.svelte';
  import { PopoutHeaderAction } from './dockview-popout-action';
  import { openNoteWindow } from '$lib/api';
  import { clearSavedLayout, loadSavedLayout, saveLayout } from '$lib/api';
  import {
    setActiveNote,
    setLeftSidebarWidth,
    setRightSidebarWidth,
    ui
  } from '$lib/state.svelte';
  import { loadTree, tree } from '$lib/stores/tree.svelte';

  let dockHost: HTMLDivElement | null = $state(null);
  let dock: DockviewApi | null = null;
  let lastActiveGroup: DockviewGroupPanel | null = null;
  const openPanels = new Map<string, IDockviewPanel>();
  let saveLayoutTimer: ReturnType<typeof setTimeout> | null = null;

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
      disableFloatingGroups: false,
      disableDnd: false,
      createRightHeaderActionComponent: () => new PopoutHeaderAction()
    });

    dock = component.api;

    dock.onDidActivePanelChange((panel) => {
      if (panel?.params && typeof panel.params.noteId === 'string') {
        setActiveNote(panel.params.noteId);
      }
      schedulePersist();
    });
    dock.onDidActiveGroupChange((group) => {
      if (group) lastActiveGroup = group;
    });
    dock.onDidRemovePanel((panel) => {
      const noteId = (panel.params as { noteId?: string } | undefined)?.noteId;
      if (noteId) openPanels.delete(noteId);
      schedulePersist();
    });
    dock.onDidAddPanel(() => schedulePersist());
    dock.onDidLayoutChange(() => schedulePersist());

    // Make sure the tree is populated before we try to restore tabs by id.
    if (!tree.ready) await loadTree();

    const restored = tryRestoreLayout();
    if (!restored) {
      // First run / wiped layout — open the first note we can find.
      const first = pickInitialNote();
      if (first) openNote(first);
    }

    lastActiveGroup = dock.activeGroup ?? lastActiveGroup;
  }

  function pickInitialNote(): string | null {
    const ids = Object.keys(tree.notesById);
    return ids[0] ?? null;
  }

  /** Try to apply the saved dock state. Returns true on success. */
  function tryRestoreLayout(): boolean {
    if (!dock) return false;
    const saved = loadSavedLayout();
    if (!saved || !saved.dock) return false;
    try {
      // dockview can fail to deserialize if the panel ids reference notes
      // that no longer exist. We pre-filter by checking the saved blob
      // against the current notesById; if anything's stale, drop it.
      const sanitized = sanitizeDockBlob(saved.dock);
      if (!sanitized) {
        clearSavedLayout();
        return false;
      }
      // dockview's `fromJSON` is on the underlying component, not the api.
      // Cast through the api object to reach it.
      const api = dock as unknown as { fromJSON: (s: unknown) => void };
      api.fromJSON(sanitized);
      // Repopulate openPanels map from the active layout.
      for (const panel of dock.panels) {
        const noteId = (panel.params as { noteId?: string } | undefined)?.noteId;
        if (noteId) openPanels.set(noteId, panel);
      }
      if (saved.activeNoteId) {
        const p = openPanels.get(saved.activeNoteId);
        p?.api.setActive();
      }
      return openPanels.size > 0;
    } catch (err) {
      console.warn('[layout] restore failed, falling back', err);
      clearSavedLayout();
      return false;
    }
  }

  /**
   * Walk the saved dock blob and check every panel's noteId still exists.
   * Returns the original blob if everything resolves, null otherwise.
   * Cheap to do up-front and avoids dockview throwing mid-restore.
   */
  function sanitizeDockBlob(blob: unknown): unknown | null {
    try {
      const json = blob as { panels?: Record<string, { params?: { noteId?: string } }> };
      const panels = json.panels ?? {};
      for (const p of Object.values(panels)) {
        const noteId = p?.params?.noteId;
        if (noteId && !(noteId in tree.notesById)) {
          return null;
        }
      }
      return blob;
    } catch {
      return null;
    }
  }

  /** Debounced layout persistence. dockview emits many events per drag. */
  function schedulePersist() {
    if (!dock) return;
    if (saveLayoutTimer) clearTimeout(saveLayoutTimer);
    saveLayoutTimer = setTimeout(() => {
      try {
        const json = (dock as unknown as { toJSON: () => unknown }).toJSON();
        saveLayout(json, dock?.activePanel?.params?.noteId ?? null);
      } catch (err) {
        console.warn('[layout] save failed', err);
      }
    }, 250);
  }

  type SplitDirection = 'right' | 'left' | 'above' | 'below' | 'within';
  interface OpenNoteOptions {
    splitDirection?: SplitDirection;
    referenceNoteId?: string;
  }

  export function openNote(id: string, opts: OpenNoteOptions = {}) {
    if (!dock) return;
    const note = tree.notesById[id];
    if (!note) return;

    const existing = openPanels.get(id);
    if (existing) {
      existing.api.setActive();
      return;
    }

    let position:
      | { referencePanel: string; direction: SplitDirection }
      | { referenceGroup: DockviewGroupPanel }
      | undefined;
    if (opts.splitDirection) {
      const referencePanel = opts.referenceNoteId
        ? `note:${opts.referenceNoteId}`
        : dock.activePanel?.id;
      if (referencePanel) {
        position = { referencePanel, direction: opts.splitDirection };
      }
    } else {
      const target = lastActiveGroup ?? dock.activeGroup ?? null;
      if (target) position = { referenceGroup: target };
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
    void tick().then(setupDockview);
    const onResize = () => {};
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  onDestroy(() => {
    if (saveLayoutTimer) clearTimeout(saveLayoutTimer);
    dock?.clear();
  });

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

  // Adapter functions handed to FileExplorer.
  const onOpenNote = (id: string) => openNote(id);
  const onOpenNoteRight = (id: string) =>
    openNote(id, { splitDirection: 'right' });
  const onOpenNoteBelow = (id: string) =>
    openNote(id, { splitDirection: 'below' });
  const onOpenInNewWindow = (id: string) => {
    const note = tree.notesById[id];
    if (!note) return;
    void openNoteWindow(note.id, note.title);
  };
</script>

<div class="flex h-full w-full flex-col">
  <TopBar />

  <div class="flex min-h-0 flex-1">
    {#if ui.leftSidebarOpen}
      <div
        class="shrink-0 border-r border-border"
        style="width: {ui.leftSidebarWidth}px;"
      >
        <FileExplorer
          {onOpenNote}
          {onOpenNoteRight}
          {onOpenNoteBelow}
          {onOpenInNewWindow}
        />
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

<SettingsDialog />
