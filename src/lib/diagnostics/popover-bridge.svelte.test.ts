import { afterEach, describe, expect, it } from 'vitest';
import { diagnosticAnchorFrom } from './popover-bridge.svelte';

/**
 * jsdom has no layout, so every rect is zero unless a test says otherwise.
 * These stubs stand in for what the browser measures.
 */
function rect(left: number, top: number, bottom: number, width = 40): DOMRect {
  return {
    left,
    top,
    bottom,
    right: left + width,
    width,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({})
  } as DOMRect;
}

function squiggle(measured: DOMRect | null): HTMLElement {
  const el = document.createElement('span');
  el.dataset.diagnosticKind = 'spelling';
  el.textContent = 'wrods';
  if (measured) el.getBoundingClientRect = () => measured;
  document.body.append(el);
  return el;
}

/** A contextmenu event as the plugins raise it, aimed at `target`. */
function event(target: EventTarget, x: number, y: number): MouseEvent {
  const e = new MouseEvent('contextmenu', { clientX: x, clientY: y });
  Object.defineProperty(e, 'target', { value: target });
  return e;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('diagnosticAnchorFrom', () => {
  it('measures the flagged word rather than the pointer', () => {
    // The whole point: on touch the pointer is in the middle of the word, so
    // anchoring to it puts the menu over the line being corrected.
    const el = squiggle(rect(120, 195, 214));

    expect(diagnosticAnchorFrom(event(el, 160, 205))).toEqual({
      left: 120,
      top: 195,
      bottom: 214
    });
  });

  it('finds the decoration when the event lands on a child of it', () => {
    // Marks nest: a misspelling inside bold text puts a <strong> between the
    // decoration and the text node the pointer actually hit.
    const el = squiggle(rect(120, 195, 214));
    const inner = document.createElement('strong');
    el.append(inner);

    expect(diagnosticAnchorFrom(event(inner, 160, 205)).top).toBe(195);
  });

  it('falls back to the pointer when the event missed a decoration', () => {
    const plain = document.createElement('p');
    document.body.append(plain);

    expect(diagnosticAnchorFrom(event(plain, 160, 205))).toEqual({
      left: 160,
      top: 205,
      bottom: 205
    });
  });

  it('falls back to the pointer when the decoration has no box', () => {
    // A decoration that is display:none or not yet laid out measures 0x0;
    // trusting that would pin the menu to the top-left corner.
    const el = squiggle(rect(0, 0, 0, 0));

    expect(diagnosticAnchorFrom(event(el, 160, 205))).toEqual({
      left: 160,
      top: 205,
      bottom: 205
    });
  });

  it('falls back to the pointer when the target is not an element', () => {
    // `window` is a legitimate EventTarget with no closest().
    expect(diagnosticAnchorFrom(event(window, 160, 205)).left).toBe(160);
  });
});
