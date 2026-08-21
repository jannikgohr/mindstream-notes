import { beforeEach, describe, expect, it } from 'vitest';
import { createFloatingPortal } from './floating-portal';

/** host inside a scrolling pane, the shape NoteEditor mounts. */
function mountPane() {
  document.body.innerHTML = '';
  const pane = document.createElement('div');
  pane.style.overflowY = 'auto';
  const host = document.createElement('div');
  pane.appendChild(host);
  document.body.appendChild(pane);
  return { pane, host };
}

/** jsdom has no layout, so scrollTop is a plain property. */
function scrollTo(pane: HTMLElement, top: number) {
  Object.defineProperty(pane, 'scrollTop', { value: top, configurable: true });
  pane.dispatchEvent(new Event('scroll'));
}

/** MutationObserver callbacks are microtasks. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createFloatingPortal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('mounts a milkdown-classed layer on the body', () => {
    const { host } = mountPane();
    const portal = createFloatingPortal(host);
    expect(portal.root.parentElement).toBe(document.body);
    // Crepe's menu CSS and our --crepe-color-* mapping are both scoped
    // under .milkdown, so the layer has to carry it.
    expect(portal.root.classList.contains('milkdown')).toBe(true);
    expect(portal.root.classList.contains('milkdown-floating-portal')).toBe(
      true
    );
    portal.destroy();
    expect(document.querySelector('.milkdown-floating-portal')).toBeNull();
  });

  it('offsets the layer by how far the pane scrolled', async () => {
    const { pane, host } = mountPane();
    const portal = createFloatingPortal(host);
    const menu = document.createElement('div');
    portal.root.appendChild(menu);
    menu.style.top = '100px';
    await flush();

    scrollTo(pane, 80);
    expect(portal.root.style.transform).toBe('translateY(-80px)');
    scrollTo(pane, 0);
    expect(portal.root.style.transform).toBe('');
  });

  it('re-anchors when the menu is positioned again', async () => {
    const { pane, host } = mountPane();
    const portal = createFloatingPortal(host);
    const menu = document.createElement('div');
    portal.root.appendChild(menu);
    await flush();

    scrollTo(pane, 50);
    expect(portal.root.style.transform).toBe('translateY(-50px)');

    // Crepe writes left/top whenever it re-positions against the caret —
    // from there the drift starts over.
    menu.style.top = '240px';
    await flush();
    expect(portal.root.style.transform).toBe('');
    scrollTo(pane, 70);
    expect(portal.root.style.transform).toBe('translateY(-20px)');
  });

  it('ignores its own transform writes', async () => {
    const { pane, host } = mountPane();
    const portal = createFloatingPortal(host);
    portal.root.appendChild(document.createElement('div'));
    await flush();

    scrollTo(pane, 40);
    await flush();
    // A naive observer would treat the transform it just wrote as a
    // re-position and reset the offset to zero.
    expect(portal.root.style.transform).toBe('translateY(-40px)');
  });

  it('stops following once destroyed', async () => {
    const { pane, host } = mountPane();
    const portal = createFloatingPortal(host);
    portal.root.appendChild(document.createElement('div'));
    await flush();
    portal.destroy();
    scrollTo(pane, 120);
    expect(portal.root.style.transform).toBe('');
  });

  it('works when nothing above the host scrolls', () => {
    document.body.innerHTML = '';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const portal = createFloatingPortal(host);
    expect(portal.root.style.transform).toBe('');
    portal.destroy();
  });
});
