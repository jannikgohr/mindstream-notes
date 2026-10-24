import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installSelectionToolbarAutoHide } from './selection-toolbar';

function mountEditor() {
  const host = document.createElement('div');
  const milkdown = document.createElement('div');
  const toolbar = document.createElement('div');
  const content = document.createElement('div');
  content.className = 'ProseMirror';
  content.textContent = 'Select this text';
  toolbar.className = 'milkdown-toolbar';
  toolbar.dataset.show = 'true';
  milkdown.append(content, toolbar);
  host.append(milkdown);
  document.body.append(host);
  return { host, toolbar, content };
}

function pointerAt(
  target: EventTarget,
  type: string,
  options: PointerEventInit = {}
) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      ...options
    })
  );
}

function pressAt(target: Element | Document) {
  pointerAt(target, 'pointerdown');
}

const cleanups: (() => void)[] = [];

function installGuard(host: HTMLElement) {
  const destroy = installSelectionToolbarAutoHide(host);
  cleanups.push(destroy);
  return destroy;
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.useFakeTimers({
    toFake: ['requestAnimationFrame', 'cancelAnimationFrame']
  });
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

describe('installSelectionToolbarAutoHide', () => {
  it('hides a shown toolbar when the press lands outside the editor', () => {
    const { host, toolbar } = mountEditor();
    installGuard(host);
    const outside = document.createElement('button');
    document.body.append(outside);

    pressAt(outside);
    expect(toolbar.dataset.show).toBe('false');
  });

  it('leaves presses inside the editor to the provider', () => {
    const { host, toolbar } = mountEditor();
    installGuard(host);
    const paragraph = document.createElement('p');
    host.append(paragraph);

    pressAt(paragraph);
    expect(toolbar.dataset.show).toBe('true');
  });

  it('does not hide when the toolbar itself is pressed', () => {
    const { host, toolbar } = mountEditor();
    installGuard(host);

    pressAt(toolbar);
    expect(toolbar.dataset.show).toBe('true');
    expect(host.dataset.selectionDragging).toBeUndefined();
  });

  it('ignores toolbars that are already hidden', () => {
    const { host, toolbar } = mountEditor();
    toolbar.dataset.show = 'false';
    installGuard(host);
    const outside = document.createElement('button');
    document.body.append(outside);

    pressAt(outside);
    expect(toolbar.dataset.show).toBe('false');
  });

  it('self-removes once the editor host is unmounted', () => {
    const { host, toolbar } = mountEditor();
    installGuard(host);
    host.remove();
    toolbar.dataset.show = 'true';

    // First press after unmount detaches the listener; nothing throws
    // and the (detached) toolbar is untouched.
    pressAt(document.body);
    expect(toolbar.dataset.show).toBe('true');
  });

  it('suppresses the toolbar until the frame after release outside the editor', () => {
    const { host, content, toolbar } = mountEditor();
    installGuard(host);

    pressAt(content);
    // The provider can still change visibility during the selection gesture.
    toolbar.dataset.show = 'true';
    expect(host.dataset.selectionDragging).toBe('true');

    pointerAt(document.body, 'pointerup');
    expect(host.dataset.selectionDragging).toBe('true');
    vi.advanceTimersToNextFrame();
    expect(host.dataset.selectionDragging).toBeUndefined();
    expect(toolbar.dataset.show).toBe('true');
  });

  it('ignores release from a different pointer', () => {
    const { host, content } = mountEditor();
    installGuard(host);
    pressAt(content);

    pointerAt(document, 'pointerup', { pointerId: 2 });
    vi.advanceTimersToNextFrame();
    expect(host.dataset.selectionDragging).toBe('true');
  });

  it.each(['pointercancel', 'blur'])('clears a gesture on %s', (type) => {
    const { host, content } = mountEditor();
    installGuard(host);
    pressAt(content);

    if (type === 'blur') window.dispatchEvent(new Event('blur'));
    else pointerAt(document, type);

    expect(host.dataset.selectionDragging).toBeUndefined();
  });

  it('keeps a second gesture suppressed when it starts before the release frame', () => {
    const { host, content } = mountEditor();
    installGuard(host);
    pressAt(content);
    pointerAt(document, 'pointerup');
    pressAt(content);

    vi.advanceTimersToNextFrame();
    expect(host.dataset.selectionDragging).toBe('true');
  });

  it('does not suppress another editor or a secondary-button gesture', () => {
    const first = mountEditor();
    const second = mountEditor();
    installGuard(first.host);
    installGuard(second.host);

    pointerAt(first.content, 'pointerdown', { button: 2 });
    expect(first.host.dataset.selectionDragging).toBeUndefined();

    pressAt(first.content);
    expect(first.host.dataset.selectionDragging).toBe('true');
    expect(second.host.dataset.selectionDragging).toBeUndefined();
  });

  it('cleans up listeners and a pending release frame on destruction', () => {
    const { host, content } = mountEditor();
    const destroy = installGuard(host);
    pressAt(content);
    pointerAt(document, 'pointerup');

    destroy();
    expect(host.dataset.selectionDragging).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    pressAt(content);
    expect(host.dataset.selectionDragging).toBeUndefined();
  });
});
