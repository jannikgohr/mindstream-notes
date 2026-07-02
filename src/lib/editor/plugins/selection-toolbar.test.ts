import { beforeEach, describe, expect, it } from 'vitest';
import { installSelectionToolbarAutoHide } from './selection-toolbar';

function mountEditor() {
  const host = document.createElement('div');
  const milkdown = document.createElement('div');
  const toolbar = document.createElement('div');
  toolbar.className = 'milkdown-toolbar';
  toolbar.dataset.show = 'true';
  milkdown.append(toolbar);
  host.append(milkdown);
  document.body.append(host);
  return { host, toolbar };
}

function pressAt(target: Element | Document) {
  target.dispatchEvent(
    new Event('pointerdown', { bubbles: true, cancelable: true })
  );
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('installSelectionToolbarAutoHide', () => {
  it('hides a shown toolbar when the press lands outside the editor', () => {
    const { host, toolbar } = mountEditor();
    installSelectionToolbarAutoHide(host);
    const outside = document.createElement('button');
    document.body.append(outside);

    pressAt(outside);
    expect(toolbar.dataset.show).toBe('false');
  });

  it('leaves presses inside the editor to the provider', () => {
    const { host, toolbar } = mountEditor();
    installSelectionToolbarAutoHide(host);
    const paragraph = document.createElement('p');
    host.append(paragraph);

    pressAt(paragraph);
    expect(toolbar.dataset.show).toBe('true');
  });

  it('does not hide when the toolbar itself is pressed', () => {
    const { host, toolbar } = mountEditor();
    installSelectionToolbarAutoHide(host);

    pressAt(toolbar);
    expect(toolbar.dataset.show).toBe('true');
  });

  it('ignores toolbars that are already hidden', () => {
    const { host, toolbar } = mountEditor();
    toolbar.dataset.show = 'false';
    installSelectionToolbarAutoHide(host);
    const outside = document.createElement('button');
    document.body.append(outside);

    pressAt(outside);
    expect(toolbar.dataset.show).toBe('false');
  });

  it('self-removes once the editor host is unmounted', () => {
    const { host, toolbar } = mountEditor();
    installSelectionToolbarAutoHide(host);
    host.remove();
    toolbar.dataset.show = 'true';

    // First press after unmount detaches the listener; nothing throws
    // and the (detached) toolbar is untouched.
    pressAt(document.body);
    expect(toolbar.dataset.show).toBe('true');
  });
});
