import type {
  IDockviewGroupPanel,
  IGroupHeaderProps,
  IHeaderActionsRenderer
} from 'dockview-core';
import { notes } from '$lib/state.svelte';
import { openNoteWindow } from '$lib/tauri';

/**
 * Renderer plugged into dockview's `createRightHeaderActionComponent`. Each
 * tab group gets its own instance; clicking the button pops the active
 * note out into a brand-new Tauri window via the IPC bridge. In `pnpm dev`
 * (no Tauri) the bridge falls back to `window.open()` so this still works
 * for browser-only smoke tests.
 */
export class PopoutHeaderAction implements IHeaderActionsRenderer {
  private readonly el: HTMLDivElement;
  private readonly btn: HTMLButtonElement;
  private currentGroup: IDockviewGroupPanel | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'dv-popout-host';

    this.btn = document.createElement('button');
    this.btn.type = 'button';
    this.btn.title = 'Open active note in a new window';
    this.btn.setAttribute('aria-label', 'Open active note in a new window');
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
    const panel = this.currentGroup?.activePanel;
    const params = panel?.params as { noteId?: string } | undefined;
    if (!params?.noteId) return;
    const note = notes.byId[params.noteId];
    if (!note) return;
    void openNoteWindow(note.id, note.title);
  };

  dispose(): void {
    this.btn.removeEventListener('click', this.onClick);
  }
}
