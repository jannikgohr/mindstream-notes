import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardDrag, type CardDragParams } from './drag';
import { DndState } from '../components/useDrag.svelte';

let node: HTMLDivElement;
let card: HTMLElement;
let target: HTMLElement;
let dnd: DndState;
let action: ReturnType<typeof cardDrag>;
const exec = vi.fn().mockResolvedValue(undefined);
const store = {
  getState: () => ({
    viewData: {
      columns: [
        { id: 'todo', cards: [{ id: 'a' }, { id: 'b' }] },
        { id: 'done', cards: [] }
      ]
    }
  }),
  exec
} as unknown as CardDragParams['store'];
function pointer(type: string, x: number, element: EventTarget = window) {
  element.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      button: 0,
      pointerId: 1,
      clientX: x,
      clientY: 10
    })
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  exec.mockClear();
  node = document.createElement('div');
  node.innerHTML =
    '<div data-kanban-column-cards="todo"><div data-kanban-card-id="a"></div><div data-kanban-card-id="b"></div></div><div data-kanban-column-cards="done"></div>';
  document.body.append(node);
  card = node.querySelector('[data-kanban-card-id="a"]')!;
  target = node.querySelector('[data-kanban-column-cards="done"]')!;
  node.hasPointerCapture = () => false;
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(target);
  dnd = new DndState();
  action = cardDrag(node, { store, dnd });
});
afterEach(() => {
  action.destroy();
  node.remove();
  vi.runAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('card drag interactions', () => {
  it('commits a cross-column move only after the drag threshold', () => {
    pointer('pointerdown', 10, card);
    pointer('pointermove', 12);
    expect(dnd.active).toBe(false);
    pointer('pointermove', 40);
    expect(dnd.active).toBe(true);
    expect(dnd.target).toEqual({ column: 'done', beforeId: null });
    pointer('pointerup', 40);
    expect(exec).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledWith('move-card', { id: 'a', column: 'done' });
    expect(dnd.active).toBe(false);
    expect(document.body.style.userSelect).toBe('');
  });
  it.each(['escape', 'cancel', 'readonly', 'destroy'])(
    'cancels without writing on %s',
    (mode) => {
      pointer('pointerdown', 10, card);
      pointer('pointermove', 40);
      if (mode === 'escape')
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      if (mode === 'cancel') pointer('pointercancel', 40);
      if (mode === 'readonly') action.update({ store, dnd, readonly: true });
      if (mode === 'destroy') action.destroy();
      pointer('pointerup', 40);
      expect(exec).not.toHaveBeenCalled();
      expect(dnd.active).toBe(false);
      expect(dnd.target).toBeNull();
    }
  );
  it('does not start a drag in a read-only board', () => {
    action.update({ store, dnd, readonly: true });
    pointer('pointerdown', 10, card);
    pointer('pointermove', 40);
    pointer('pointerup', 40);
    expect(exec).not.toHaveBeenCalled();
    expect(dnd.active).toBe(false);
  });
  it('cancels a pending touch hold on teardown', () => {
    action.update({ store, dnd, onEdgeSwitch: () => null });
    pointer('pointerdown', 10, card);
    action.destroy();
    vi.advanceTimersByTime(1000);
    expect(dnd.active).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});
