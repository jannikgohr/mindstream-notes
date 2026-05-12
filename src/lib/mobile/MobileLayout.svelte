<script lang="ts">
  /**
   * Mobile shell. Mirrors DesktopLayout's dockview-based note workspace
   * but drops the multi-window affordances that don't make sense on a
   * phone/tablet: no popout button on dockview tab headers, no
   * "Open in new window" entry in the file-tree context menu. Anything
   * that lives in `$lib/desktop/` should stay imported from there only;
   * see `$lib/platform.ts` for how the platform branch is chosen.
   */
  import { mount, unmount, onDestroy, onMount, tick } from 'svelte';
  import type {
    DockviewApi,
    IDockviewPanel,
    IContentRenderer,
    GroupPanelPartInitParameters,
    DockviewGroupPanel
  } from 'dockview-core';
  import TopBar from '$lib/components/TopBar.svelte';
  import FileExplorer from '$lib/components/FileExplorer.svelte';
  import MetadataPanel from '$lib/components/MetadataPanel.svelte';
  import NoteEditor from '$lib/components/NoteEditor.svelte';
  import ResizeHandle from '$lib/components/ResizeHandle.svelte';
  import SettingsDialog from '$lib/settings/SettingsDialog.svelte';
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

    // No createRightHeaderActionComponent: the popout button is desktop-only.
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
      disableDnd: false
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

    if (!tree.ready) await loadTree();

    const restored = tryRestoreLayout();
    if (!restored) {
      const first = pickInitialNote();
      if (first) openNote(first);
    }

    lastActiveGroup = dock.activeGroup ?? lastActiveGroup;
  }

  function pickInitialNote(): string | null {
    const ids = Object.keys(tree.notesById);
    return ids[0] ?? null;
  }

  function tryRestoreLayout(): boolean {
    if (!dock) return false;
    const saved = loadSavedLayout();
    if (!saved || !saved.dock) return false;
    try {
      const sanitized = sanitizeDockBlob(saved.dock);
      if (!sanitized) {
        clearSavedLayout();
        return false;
      }
      const api = dock as unknown as { fromJSON: (s: unknown) => void };
      api.fromJSON(sanitized);
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

    if (dock.groups.length === 0) {
      dock.addGroup();
      lastActiveGroup = dock.groups[0];
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

  $effect(() => {
    for (const noteId of Object.keys(tree.notesById)) {
      const panel = openPanels.get(noteId);
      if (panel) panel.api.setTitle(tree.notesById[noteId].title);
    }
  });

  const onOpenNote = (id: string) => openNote(id);
  const onOpenNoteRight = (id: string) =>
    openNote(id, { splitDirection: 'right' });
  const onOpenNoteBelow = (id: string) =>
    openNote(id, { splitDirection: 'below' });
  // onOpenInNewWindow is intentionally omitted — the file-tree context
  // menu hides the entry when the prop is undefined.
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
