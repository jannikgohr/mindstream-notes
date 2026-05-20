import type {
  DockviewApi,
  IDockviewGroupPanel,
  IGroupHeaderProps,
  IHeaderActionsRenderer
} from 'dockview-core';
import { mount, unmount } from 'svelte';
import { tree } from '$lib/stores/tree.svelte';
import { openNoteWindow } from '$lib/api';
import { tUi } from '$lib/settings/i18n.svelte';
import NoteStatusIcons from './NoteStatusIcons.svelte';

/**
 * Renderer plugged into dockview's `createRightHeaderActionComponent`.
 * Each tab group gets its own instance; clicking the button pops the
 * active note into a brand-new Tauri window and (if `dock` is provided)
 * removes the source tab so the note isn't open in two places at once.
 *
 * The element is a flex row of:
 *   1. A Svelte-mounted `<NoteStatusIcons>` component that reads the
 *      active note's collab + save state from the per-note status
 *      store and renders icon-only chips with translated tooltips.
 *   2. The popout button (plain DOM, predates the Svelte mount).
 *
 * Hybrid is intentional — the button's behaviour ties to the group's
 * `activePanel` which is delivered via dockview's plain-DOM `init`
 * callback, so wrapping the button in Svelte would gain nothing and
 * complicate disposal ordering.
 */
export class PopoutHeaderAction implements IHeaderActionsRenderer {
  private readonly el: HTMLDivElement;
  private readonly statusMount: HTMLDivElement;
  private readonly btn: HTMLButtonElement;
  private readonly dock: DockviewApi | null;
  private currentGroup: IDockviewGroupPanel | null = null;
  private statusInstance: ReturnType<typeof mount> | null = null;

  constructor(dock: DockviewApi | null) {
    this.dock = dock;
    this.el = document.createElement('div');
    this.el.className = 'dv-popout-host';

    // Status-icons mount point first — sits to the LEFT of the popout
    // button (flex-row source order = visual order). The Svelte
    // component owns its own styling/spacing; we don't add any here.
    this.statusMount = document.createElement('div');
    this.el.appendChild(this.statusMount);
    this.statusInstance = mount(NoteStatusIcons, { target: this.statusMount });

    this.btn = document.createElement('button');
    this.btn.type = 'button';
    // tUi snapshot at construction. The header action is recreated
    // when dockview rebuilds the chrome (e.g. on theme switch), so
    // language changes get picked up on the next dock layout cycle —
    // good enough for a tooltip.
    const popoutLabel = tUi('editor.popout');
    this.btn.title = popoutLabel;
    this.btn.setAttribute('aria-label', popoutLabel);
    this.btn.className = 'dv-popout-button';
    // Lucide "square-arrow-out-up-right" — the standard pop-out glyph.
    this.btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14"
           viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
           aria-hidden="true">
        <path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/>
        <path d="m21 3-9 9"/>
        <path d="M15 3h6v6"/>
      </svg>
    `;
    this.btn.addEventListener('click', this.onClick);
    this.el.appendChild(this.btn);
  }

  get element(): HTMLElement {
    return this.el;
  }

  init(params: IGroupHeaderProps): void {
    this.currentGroup = params.group;
  }

  private onClick = () => {
    const panelGroup = this.currentGroup;
    const panel = panelGroup?.activePanel;
    const params = panel?.params as { noteId?: string } | undefined;
    if (!params?.noteId) return;
    const note = tree.notesById[params.noteId];
    if (!note) return;
    void openNoteWindow(note.id, note.title, panelGroup, this.dock);
  };

  dispose(): void {
    this.btn.removeEventListener('click', this.onClick);
    if (this.statusInstance) {
      unmount(this.statusInstance);
      this.statusInstance = null;
    }
  }
}
