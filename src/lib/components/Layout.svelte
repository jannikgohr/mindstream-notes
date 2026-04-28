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
  import { notes, setActiveNote, ui } from '$lib/state.svelte';

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
      theme: { name: 'bridge', className: 'dockview-theme-bridge' }
    });

    dock = component.api;

    dock.onDidActivePanelChange((panel) => {
      if (panel?.params && typeof panel.params.noteId === 'string') {
        setActiveNote(panel.params.noteId);
      }
    });

    // Open the welcome note as the initial tab.
    openNote('welcome');
  }

  function openNote(id: string) {
    if (!dock) return;
    const note = notes.byId[id];
    if (!note) return;

    const existing = openPanels.get(id);
    if (existing) {
      existing.api.setActive();
      return;
    }

    const panel = dock.addPanel({
      id: `note:${id}`,
      component: 'noteEditor',
      title: note.title,
      params: { noteId: id }
    });

    openPanels.set(id, panel);
    panel.api.onDidDispose(() => openPanels.delete(id));
    setActiveNote(id);
  }

  onMount(() => {
    // Defer one tick so the host div has a real size before dockview measures.
    void tick().then(setupDockview);

    const onResize = () => {
      if (!dockHost || !dock) return;
      // dockview-core auto-resizes via ResizeObserver, but force a layout
      // call when the sidebars toggle so it picks up the new width quickly.
      const { width, height } = dockHost.getBoundingClientRect();
      // @ts-expect-error — `layout` exists on the underlying component
      dock['component']?.layout?.(width, height);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  onDestroy(() => {
    dock?.clear();
  });

  // React to sidebar collapse/expand: dockview measures with ResizeObserver,
  // but trigger an explicit relayout for snappier behaviour.
  $effect(() => {
    // Reading these makes the effect track them.
    void ui.leftSidebarOpen;
    void ui.rightSidebarOpen;
    if (!dockHost) return;
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
    });
  });
</script>

<div class="flex h-full w-full flex-col">
  <TopBar />

  <div class="flex min-h-0 flex-1">
    {#if ui.leftSidebarOpen}
      <div
        class="w-[240px] shrink-0 border-r border-border"
        style="min-width: 200px;"
      >
        <FileExplorer onOpenNote={openNote} />
      </div>
    {/if}

    <main class="min-w-0 flex-1">
      <div bind:this={dockHost} class="dockview-theme-bridge h-full w-full"></div>
    </main>

    {#if ui.rightSidebarOpen}
      <div
        class="w-[260px] shrink-0 border-l border-border"
        style="min-width: 220px;"
      >
        <MetadataPanel />
      </div>
    {/if}
  </div>
</div>
