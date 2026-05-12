<script lang="ts">
  /**
   * Mobile shell.
   *
   * One screen at a time, driven by `ui.leftSidebarOpen`:
   *   true   → file tree (FileExplorer) fullscreen — the "home" screen.
   *   false  → editor (dockview) fullscreen.
   *
   * Tapping a note flips the flag to false so the editor takes over;
   * MobileTopBar's back arrow flips it back. `ui.rightSidebarOpen` opens
   * MobileMetadataOverlay above the editor.
   *
   * Multi-window features (popout button on dock tabs, "Open in new
   * window" context-menu entry) are not wired up here — see DesktopLayout
   * for those.
   *
   * The shell uses `safe-top` / `safe-bottom` so the chrome doesn't paint
   * under the Android status bar or gesture bar with edge-to-edge enabled.
   */
  import { mount, unmount, onDestroy, onMount, tick } from 'svelte';
  import type {
    DockviewApi,
    IDockviewPanel,
    IContentRenderer,
    GroupPanelPartInitParameters,
    DockviewGroupPanel
  } from 'dockview-core';
  import MobileTopBar from './MobileTopBar.svelte';
  import MobileMetadataOverlay from './MobileMetadataOverlay.svelte';
  import FileExplorer from '$lib/components/FileExplorer.svelte';
  import NoteEditor from '$lib/components/NoteEditor.svelte';
  import SettingsDialog from '$lib/settings/SettingsDialog.svelte';
  import { clearSavedLayout, loadSavedLayout, saveLayout } from '$lib/api';
  import { setActiveNote, ui } from '$lib/state.svelte';
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
      disableFloatingGroups: true,
      disableDnd: true
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

    tryRestoreLayout();

    lastActiveGroup = dock.activeGroup ?? lastActiveGroup;
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

  export function openNote(id: string) {
    if (!dock) return;
    const note = tree.notesById[id];
    if (!note) return;

    const existing = openPanels.get(id);
    if (existing) {
      existing.api.setActive();
      // Surface the editor screen so the tap actually feels like
      // navigation, not a silent state change behind the tree.
      ui.leftSidebarOpen = false;
      return;
    }

    if (dock.groups.length === 0) {
      dock.addGroup();
      lastActiveGroup = dock.groups[0];
    }

    const target = lastActiveGroup ?? dock.activeGroup ?? null;
    const panel = dock.addPanel({
      id: `note:${id}`,
      component: 'noteEditor',
      title: note.title,
      params: { noteId: id },
      ...(target ? { position: { referenceGroup: target } } : {})
    });

    openPanels.set(id, panel);
    setActiveNote(id);
    ui.leftSidebarOpen = false;
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

  // Trigger a dockview relayout whenever the editor screen comes back
  // into view (toggled via the back arrow). Dockview measures during its
  // own ResizeObserver, but the parent's display flips from `hidden`
  // before that fires, so we nudge it.
  $effect(() => {
    void ui.leftSidebarOpen;
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
  // Mobile has no split-pane affordance, so the secondary openers all
  // route to the same single-pane open. onOpenInNewWindow stays
  // undefined so the file-tree context menu hides "Open in new window".
  const onOpenNoteRight = onOpenNote;
  const onOpenNoteBelow = onOpenNote;
</script>

<div class="safe-top safe-bottom safe-x flex h-full w-full flex-col">
  <MobileTopBar />

  <div class="relative min-h-0 flex-1">
    <!--
      Both screens stay mounted; visibility flips via `hidden` so
      dockview keeps its panel state and the file tree doesn't re-
      collapse every navigation. Use `display: none`/`block` rather
      than conditional rendering so neither component remounts.
    -->
    <div class="absolute inset-0" class:hidden={!ui.leftSidebarOpen}>
      <FileExplorer
        {onOpenNote}
        {onOpenNoteRight}
        {onOpenNoteBelow}
      />
    </div>

    <div class="absolute inset-0" class:hidden={ui.leftSidebarOpen}>
      <div bind:this={dockHost} class="dockview-theme-bridge h-full w-full"></div>
    </div>
  </div>
</div>

<MobileMetadataOverlay />
<SettingsDialog />
