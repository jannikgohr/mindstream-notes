import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installBlockHandleGuard } from './block-handle-guard';

/**
 * Mirrors the DOM Crepe's BlockHandle mounts: a `.milkdown-block-handle`
 * container with the add button as the first `.operation-item` and the
 * drag grip as the second. The `onAdd` spy stands in for Crepe's
 * target-phase pointerup listener.
 */
function mountHandle() {
  const handle = document.createElement('div');
  handle.className = 'milkdown-block-handle';
  const addButton = document.createElement('div');
  addButton.className = 'operation-item';
  const dragGrip = document.createElement('div');
  dragGrip.className = 'operation-item';
  handle.append(addButton, dragGrip);
  document.body.append(handle);

  const onAdd = vi.fn();
  addButton.addEventListener('pointerup', onAdd);
  return { handle, addButton, dragGrip, onAdd };
}

function pointer(type: 'pointerdown' | 'pointerup', target: Element) {
  target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  document.body.innerHTML = '';
  installBlockHandleGuard(document);
});

describe('installBlockHandleGuard', () => {
  it('lets a full click on the add button through', () => {
    const { addButton, onAdd } = mountHandle();
    pointer('pointerdown', addButton);
    pointer('pointerup', addButton);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('swallows a pointerup whose pointerdown started elsewhere', () => {
    const { addButton, onAdd } = mountHandle();
    const elsewhere = document.createElement('p');
    document.body.append(elsewhere);

    pointer('pointerdown', elsewhere);
    pointer('pointerup', addButton);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('recovers after a swallowed release: the next real click works', () => {
    const { addButton, onAdd } = mountHandle();
    const elsewhere = document.createElement('p');
    document.body.append(elsewhere);

    pointer('pointerdown', elsewhere);
    pointer('pointerup', addButton);
    pointer('pointerdown', addButton);
    pointer('pointerup', addButton);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('clicks on descendants of the add button still count', () => {
    const { addButton, onAdd } = mountHandle();
    const icon = document.createElement('span');
    addButton.append(icon);

    pointer('pointerdown', icon);
    pointer('pointerup', icon);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('does not interfere with the drag grip', () => {
    const { dragGrip } = mountHandle();
    const gripUp = vi.fn();
    dragGrip.addEventListener('pointerup', gripUp);

    const elsewhere = document.createElement('p');
    document.body.append(elsewhere);
    pointer('pointerdown', elsewhere);
    pointer('pointerup', dragGrip);
    expect(gripUp).toHaveBeenCalledTimes(1);
  });
});
