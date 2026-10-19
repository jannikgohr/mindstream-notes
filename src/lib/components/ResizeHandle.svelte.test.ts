import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ResizeHandle from './ResizeHandle.svelte';

beforeEach(() => {
  HTMLElement.prototype.setPointerCapture ??= () => {};
  HTMLElement.prototype.releasePointerCapture ??= () => {};
});

afterEach(cleanup);

function drag(handle: HTMLElement, from: number, moves: number[]) {
  fireEvent.pointerDown(handle, { button: 0, clientX: from, pointerId: 1 });
  for (const clientX of moves)
    fireEvent.pointerMove(handle, { clientX, pointerId: 1 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
}

describe('ResizeHandle', () => {
  it('follows the pointer but commits one width per drag', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(ResizeHandle, {
      side: 'left',
      value: 250,
      min: 200,
      max: 300,
      onChange,
      onCommit
    });

    drag(screen.getByRole('separator'), 100, [110, 120, 120, 200]);

    expect(onChange.mock.calls).toEqual([[260], [270], [300]]);
    expect(onCommit.mock.calls).toEqual([[300]]);
  });

  it('inverts the delta for a right sidebar', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(ResizeHandle, {
      side: 'right',
      value: 250,
      min: 200,
      max: 300,
      onChange,
      onCommit
    });

    drag(screen.getByRole('separator'), 100, [80]);

    expect(onChange.mock.calls).toEqual([[270]]);
    expect(onCommit.mock.calls).toEqual([[270]]);
  });

  it('does not commit a click that never moved the width', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(ResizeHandle, {
      side: 'left',
      value: 250,
      onChange,
      onCommit
    });

    drag(screen.getByRole('separator'), 100, [100]);

    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
