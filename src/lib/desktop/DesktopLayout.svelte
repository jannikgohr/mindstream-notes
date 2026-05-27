<script lang="ts">
  import {
    mount,
    unmount,
    onDestroy,
    onMount,
    tick,
    type ComponentType,
    type Component
  } from 'svelte';
  import type {
    DockviewApi,
    IDockviewPanel,
    IContentRenderer,
    GroupPanelPartInitParameters,
    DockviewGroupPanel
  } from 'dockview-core';
  import TopBar from './DesktopTopBar.svelte';
  import FileExplorer from '$lib/components/FileExplorer.svelte';
  import MetadataPanel from '$lib/components/MetadataPanel.svelte';
  import NoteEditor from '$lib/components/NoteEditor.svelte';
  import FreeformNoteEditor from '$lib/components/FreeformNoteEditor.svelte';
  import DrawingNoteEditor from '$lib/components/DrawingNoteEditor.svelte';
  import UnknownNoteKindError from '$lib/components/UnknownNoteKindError.svelte';
  import ResizeHandle from '$lib/components/ResizeHandle.svelte';
  import SettingsDialog from '$lib/settings/SettingsDialog.svelte';
  import { PopoutHeaderAction } from './dockview-popout-action';
  import {
    focusExistingNoteWindow,
    isKnownNoteKind,
    openNoteWindow
  } from '$lib/api';
  import { clearSavedLayout, loadSavedLayout, saveLayout } from '$lib/api';
  import {
    setActiveNote,
    setLeftSidebarWidth,
    setRightSidebarWidth,
    ui
  } from '$lib/state.svelte';
  import { loadTree, tree } from '$lib/stores/tree.svelte';
  import { subscribeOpenNoteRequest } from '$lib/stores/open-note-intent.svelte';

  let dockHost: HTMLDivElement | null = $state(null);
  let dock: DockviewApi | null = null;
  let lastActiveGroup: DockviewGroupPanel | null = null;
  const openPanels = new Map<string, IDockviewPanel>();
  let saveLayoutTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Renders a Svelte component inside a dockview panel. Parameterised on
   * the component so the same renderer class serves both the markdown
   * NoteEditor and the freeform drawing canvas (and anything we add
   * later). The dockview `component` name (set in `openNote()` based on
   * `note.note_kind`) picks which renderer to instantiate via the
   * `createComponent` switch below.
   */
  class SvelteRenderer implements IContentRenderer {
    // Constructor-parameter property syntax (`constructor(private X)`)
    // isn't recognised by Svelte's <script> TypeScript pipeline, so the
    // fields are declared explicitly and assigned in the constructor.
    private el: HTMLElement = document.createElement('div');
    private instance: ReturnType<typeof mount> | null = null;
    // Widening ComponentType to accept `any` props completely satisfies both the
    // Svelte 5 mount wrapper and the legacy class/functional definitions from
    // the WebStorm ambient module shim.
    private Component: ComponentType<any> | Component<any, any, any>;

    constructor(Component: any) {
      this.Component = Component;
    }

    get element(): HTMLElement {
      return this.el;
    }

    init(parameters: GroupPanelPartInitParameters): void {
      this.el.style.height = '100%';
      this.el.style.width = '100%';
      const noteId = (parameters.params as { noteId?: string })?.noteId;
      if (!noteId) return;

      // By using a type cast here, we satisfy mount's internal generics
      // while safely passing the verified noteId down to the target layout.
      this.instance = mount(this.Component as Component<any>, {
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
            return new SvelteRenderer(NoteEditor);
          case 'freeformNote':
            return new SvelteRenderer(FreeformNoteEditor);
          case 'inkNote':
            return new SvelteRenderer(DrawingNoteEditor);
          case 'unknownNoteKind':
            return new SvelteRenderer(UnknownNoteKindError);
          default:
            // Older saved layouts may reference panel names we no longer
            // recognise. Defaulting to the markdown editor is safer than
            // failing the whole dockview restore.
            return new SvelteRenderer(NoteEditor);
        }
      },
      theme: { name: 'bridge', className: 'dockview-theme-bridge' },
      disableFloatingGroups: false,
      disableDnd: false,
      createRightHeaderActionComponent: () => new PopoutHeaderAction(dock)
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

    /*
     * Tab/group drag → flag the <body> so freeform panels can opt out of
     * pointer events for the duration of the drag.
     *
     * Why: tldraw (mounted inside freeform panels) installs `dragover` /
     * `drop` listeners on `.tl-container` in @tldraw/editor's
     * useDocumentEvents.js that call `e.stopPropagation()` and re-dispatch
     * onto `.tl-canvas`. dockview's own `dragover` listener uses
     * `useCapture: true` so it still fires (which is why the drop indicator
     * shows up correctly), but its `drop` listener is bubble-phase only —
     * tldraw's stopPropagation kills the bubble before dockview ever sees
     * the drop, so the layout change never happens and the freeform panel
     * looks like it can't be dropped onto.
     *
     * Fix: while a dockview drag is in progress, hide tldraw from pointer
     * routing entirely (see `body.dv-tab-dragging .tl-container` in
     * app.css). dockview's drop overlay sits above tldraw at z-index 1000,
     * so the drop fires on the overlay where its handlers are wired
     * normally. External file drops (image → tldraw asset import) still
     * work because they don't go through onWillDragPanel/Group — they
     * originate outside the window.
     */
    dock.onWillDragPanel(markDragging);
    dock.onWillDragGroup(markDragging);

    if (!tree.ready) await loadTree();

    const restored = tryRestoreLayout();
    if (!restored) {
      const first = pickInitialNote();
      if (first) void openNote(first);
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

  export async function openNote(id: string, opts: OpenNoteOptions = {}) {
    if (!dock) return;
    const note = tree.notesById[id];
    if (!note) return;

    // Stop if note is already open
    const existing = openPanels.get(id);
    if (existing) {
      existing.api.setActive();
      return;
    }

    if (await focusExistingNoteWindow(id)) return;
    const openedWhileChecking = openPanels.get(id);
    if (openedWhileChecking) {
      openedWhileChecking.api.setActive();
      return;
    }

    // Re-add a group if last panel was closed
    if (dock.groups.length === 0) {
      dock.addGroup()
      lastActiveGroup = dock.groups[0]
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

    // Pick the dockview component by note kind. A note_kind that this
    // app version doesn't recognise (synced from a newer-version peer)
    // routes to the UnknownNoteKindError panel — falling through to
    // NoteEditor would let the user "edit" a binary doc and corrupt
    // the body on save.
    const componentName = isKnownNoteKind(note.note_kind)
      ? note.note_kind === 'freeform'
        ? 'freeformNote'
        : note.note_kind === 'ink'
          ? 'inkNote'
          : 'noteEditor'
      : 'unknownNoteKind';
    const panel = dock.addPanel({
      id: `note:${id}`,
      component: componentName,
      title: note.title,
      params: { noteId: id },
      ...(position ? { position } : {})
    });

    openPanels.set(id, panel);
    setActiveNote(id);
  }

  /**
   * Tag the document body for the duration of a dockview tab/group drag,
   * so CSS in app.css can disable pointer events on tldraw subtrees.
   * Idempotent — `add`/`remove` on a classList is safe to call repeatedly.
   * See the long comment in setupDockview() above for why this exists.
   */
  function markDragging() {
    document.body.classList.add('dv-tab-dragging');
  }
  function clearDragging() {
    document.body.classList.remove('dv-tab-dragging');
  }

  /**
   * Reposition the tabs-overflow popup so it appears under whichever
   * chevron was just clicked, rather than at the top-right of the
   * dockview root.
   *
   * Why: dockview's popover service writes inline `top` / `left` to the
   * cursor click coordinate, and our CSS in app.css overrides that with
   * a `top: 40px; right: 0 !important;` fallback that pins to the
   * dockview root — fine for a single group, broken for split-pane
   * layouts where each group has its own chevron. This handler reads
   * the clicked chevron's bounding rect, then writes the popup
   * wrapper's `top` / `right` (relative to the popover anchor's
   * containing block) so it sits flush under the originating chevron.
   *
   * Inline styles set with `!important` beat CSS `!important` (inline
   * specificity wins ties at the same importance level), which is what
   * lets this overwrite the CSS fallback.
   *
   * Returns true if the popup was found and repositioned, so the caller
   * can retry on rAF if dockview hadn't yet committed the popup to the
   * DOM by the time our bubble-phase listener fired (synchronous path
   * usually works because dockview's own listener — closer to the
   * chevron — runs first and creates the popup before we bubble up).
   */
  function repositionOverflowPopup(chevron: HTMLElement): boolean {
    const popup = chevron.ownerDocument.querySelector(
      '.dv-tabs-overflow-container'
    );
    if (!popup) return false;
    // The popup wrapper is the popup's parent — dockview's popover
    // service positions THAT element, not the popup container itself.
    const wrapper = popup.parentElement as HTMLElement | null;
    if (!wrapper) return false;
    const anchor = wrapper.parentElement;
    if (!anchor) return false;
    const anchorRect = anchor.getBoundingClientRect();
    const chevronRect = chevron.getBoundingClientRect();
    wrapper.style.setProperty(
      'top',
      `${chevronRect.bottom - anchorRect.top}px`,
      'important'
    );
    wrapper.style.setProperty('left', 'auto', 'important');
    wrapper.style.setProperty(
      'right',
      `${anchorRect.right - chevronRect.right}px`,
      'important'
    );
    return true;
  }

  /**
   * Was the overflow popup already in the DOM at the moment a chevron
   * pointerdown fired? Set by `handleChevronPointerDown` and read by
   * `handleChevronClick` to decide between "first click → open" and
   * "second click on the same chevron → toggle close".
   *
   * We have to sample at pointerdown rather than at click because
   * dockview's popupService installs a window-level pointerdown listener
   * that auto-closes the popup on outside clicks (the chevron is
   * outside the popup's DOM subtree, so it counts as "outside"). By
   * click time the popup is usually already gone, making it impossible
   * to tell apart "user is opening for the first time" from "user just
   * closed via the auto-close and we should NOT reopen".
   */
  let popupOpenAtChevronPointerdown = false;

  function handleChevronPointerDown(e: PointerEvent) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const chevron = target.closest('.dv-tabs-overflow-dropdown-default');
    if (!chevron) return;
    popupOpenAtChevronPointerdown = !!chevron.ownerDocument.querySelector(
      '.dv-tabs-overflow-container'
    );
  }

  function handleChevronClick(e: MouseEvent) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const chevron = target.closest(
      '.dv-tabs-overflow-dropdown-default'
    ) as HTMLElement | null;
    if (!chevron) return;

    if (popupOpenAtChevronPointerdown) {
      // Toggle-close path. Two cases land here:
      //   - Normal: popupService's outside-pointerdown handler already
      //     removed the popup when the chevron was pressed. We just
      //     need to stop dockview's click handler (registered in bubble
      //     phase on the dropdown root) from reopening it. We listen in
      //     CAPTURE phase on dockHost so this stopImmediatePropagation
      //     fires before dockview's listener can run.
      //   - Within the 200ms grace window after open: popupService
      //     suppresses its own pointerdown close, so the popup is still
      //     in the DOM. Force-remove the wrapper ourselves; dockview's
      //     bookkeeping (_active + its window-level listeners) get
      //     reconciled on the next chevron click via close()'s
      //     null-safe early return path.
      e.stopImmediatePropagation();
      const stillOpen = chevron.ownerDocument.querySelector(
        '.dv-tabs-overflow-container'
      );
      stillOpen?.parentElement?.remove();
      popupOpenAtChevronPointerdown = false;
      return;
    }

    // Open path. We're in capture phase, so dockview's click handler
    // (target/bubble) hasn't fired yet — the popup isn't in the DOM
    // and a synchronous reposition would no-op. Defer to rAF so the
    // reposition reads the just-created wrapper after dockview's
    // listener runs.
    requestAnimationFrame(() => repositionOverflowPopup(chevron));
  }

  onMount(() => {
    void tick().then(setupDockview);
    const onResize = () => {};
    window.addEventListener('resize', onResize);
    // Wikilink clicks (inside an editor) and any other intent source
    // dispatch through the open-note bus rather than prop-drilling up
    // here. Unsubscribed on unmount so a stale handler from a
    // re-mounted layout doesn't double-open a note.
    const unsub = subscribeOpenNoteRequest((id) => {
      void openNote(id);
    });

    // Cleanup the dv-tab-dragging body class on every drag termination:
    //   - `dragend` fires on the source element after a successful drop
    //     OR a cancellation (Esc, drop outside any target). useCapture
    //     ensures we run before any inner listener can stopPropagation.
    //   - `drop` is a belt-and-braces fallback — some browsers fire drop
    //     just before dragend, and if anything ever did stopPropagation on
    //     dragend we still want the class gone.
    window.addEventListener('dragend', clearDragging, true);
    window.addEventListener('drop', clearDragging, true);

    // Reposition the tabs-overflow popup relative to whichever chevron
    // was clicked, AND give the chevron click toggle-close semantics —
    // see handleChevronClick() / repositionOverflowPopup() for the full
    // explanation.
    //
    // Both listeners are delegated on dockHost so they catch every
    // chevron, including ones added later via splits. The bind:this for
    // dockHost has already resolved by the time onMount runs, so no
    // need to defer through tick().
    //
    // Capture phase on both is what lets us:
    //   - sample popup state at pointerdown BEFORE popupService's own
    //     window-level pointerdown listener (bubble phase) removes it.
    //   - stop dockview's click handler (bubble phase on the dropdown
    //     root) with stopImmediatePropagation on the toggle-close path.
    dockHost?.addEventListener('pointerdown', handleChevronPointerDown, true);
    dockHost?.addEventListener('click', handleChevronClick, true);

    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('dragend', clearDragging, true);
      window.removeEventListener('drop', clearDragging, true);
      dockHost?.removeEventListener(
        'pointerdown',
        handleChevronPointerDown,
        true
      );
      dockHost?.removeEventListener('click', handleChevronClick, true);
      // Defensive — if we unmount mid-drag (HMR, route change), don't
      // leave the class stuck on <body>.
      clearDragging();
      unsub();
    };
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

  // Keep open editor tab titles in sync with the file tree. This catches
  // remote renames pulled by `sync_now` (where the title in tree.notesById
  // changes under the still-open tab) as well as local renames triggered
  // from the file tree's context menu. Iterating over Object.keys(notesById)
  // makes the effect track both the key set and each visited title; new
  // panels opened *after* this runs already see the current title at open
  // time (see openNote() below) so we don't need to track openPanels.
  $effect(() => {
    for (const noteId of Object.keys(tree.notesById)) {
      const panel = openPanels.get(noteId);
      if (panel) panel.api.setTitle(tree.notesById[noteId].title);
    }
  });

  // Adapter functions handed to FileExplorer.
  const onOpenNote = (id: string) => {
    void openNote(id);
  };
  const onOpenNoteRight = (id: string) =>
    void openNote(id, { splitDirection: 'right' });
  const onOpenNoteBelow = (id: string) =>
    void openNote(id, { splitDirection: 'below' });
  const onOpenInNewWindow = (id: string) => {
    const note = tree.notesById[id];
    if (!note) return;
    void openNoteWindow(note.id, note.title, null, null);
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
