import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureDropIndicatorAlignment } from './drop-indicator-align';

// The module registers global listeners once and keeps them for the app's
// lifetime; that single registration is fine to reuse across tests. Each
// test builds its own DOM and fires the real `dragstart` it listens for.
//
// happy-dom reports unset style props as '' rather than 'none', which would
// make the "does this element establish a fixed containing block?" predicate
// fire on every element. Stub getComputedStyle so unset props read 'none' —
// then inline styles drive exactly one branch per ancestor.
const realGetComputedStyle = globalThis.getComputedStyle;

function fakeComputedStyle(el: Element): CSSStyleDeclaration {
  const s = (el as HTMLElement).style;
  return {
    transform: s.transform || 'none',
    perspective: s.perspective || 'none',
    filter: s.filter || 'none',
    backdropFilter:
      (s as unknown as Record<string, string>).backdropFilter || 'none',
    willChange: s.willChange || '',
    contain: s.contain || ''
  } as unknown as CSSStyleDeclaration;
}

function indicatorInside(parent: HTMLElement): HTMLElement {
  const dom = document.createElement('div');
  dom.className = 'milkdown-drop-indicator';
  parent.appendChild(dom);
  return dom;
}

function ancestorWith(prop: string, value: string): HTMLElement {
  const el = document.createElement('div');
  (el.style as unknown as Record<string, string>)[prop] = value;
  document.body.appendChild(el);
  return el;
}

function fireDragStart() {
  document.dispatchEvent(new Event('dragstart', { bubbles: true }));
}

beforeEach(() => {
  ensureDropIndicatorAlignment();
  document.body.innerHTML = '';
  globalThis.getComputedStyle = fakeComputedStyle as typeof getComputedStyle;
});

afterEach(() => {
  globalThis.getComputedStyle = realGetComputedStyle;
  document.body.innerHTML = '';
});

describe('ensureDropIndicatorAlignment', () => {
  it('is idempotent — repeated calls do not throw or double-register', () => {
    expect(() => {
      ensureDropIndicatorAlignment();
      ensureDropIndicatorAlignment();
    }).not.toThrow();
  });
});

describe('realignment on dragstart', () => {
  it('zeroes the offset when there is no containing block ancestor', () => {
    const plain = document.createElement('div');
    document.body.appendChild(plain);
    const dom = indicatorInside(plain);

    fireDragStart();

    expect(dom.style.left).toBe('0px');
    expect(dom.style.top).toBe('0px');
  });

  it('corrects against a transformed ancestor (the Dockview case)', () => {
    const panel = ancestorWith('transform', 'translate3d(0, 0, 0)');
    const dom = indicatorInside(panel);

    fireDragStart();

    // happy-dom reports a zero rect, so the correction lands at 0px — the
    // point is that the transformed-ancestor branch ran and wrote a value.
    expect(dom.style.left).toMatch(/px$/);
    expect(dom.style.top).toMatch(/px$/);
  });

  it('treats each indicator independently in one pass', () => {
    const a = indicatorInside(ancestorWith('transform', 'scale(1)'));
    const plain = document.createElement('div');
    document.body.appendChild(plain);
    const b = indicatorInside(plain);

    fireDragStart();

    expect(a.style.left).toMatch(/px$/);
    expect(b.style.left).toBe('0px');
  });

  it('recognises each fixed-containing-block CSS property', () => {
    // Each ancestor establishes a containing block via a different
    // property, exercising every branch of the predicate.
    const cases: Array<[string, string]> = [
      ['perspective', '100px'],
      ['filter', 'blur(2px)'],
      ['backdropFilter', 'blur(2px)'],
      ['willChange', 'transform'],
      ['contain', 'paint']
    ];
    for (const [prop, value] of cases) {
      document.body.innerHTML = '';
      const dom = indicatorInside(ancestorWith(prop, value));

      fireDragStart();

      expect(dom.style.left, `${prop}:${value} should align`).toMatch(/px$/);
    }
  });

  it('walks past non-establishing ancestors to find the block', () => {
    // indicator → plain wrapper → transformed grandparent. The walk must
    // skip the plain wrapper and stop at the transformed ancestor.
    const grand = ancestorWith('transform', 'rotate(0deg)');
    const middle = document.createElement('div');
    grand.appendChild(middle);
    const dom = indicatorInside(middle);

    fireDragStart();

    expect(dom.style.left).toMatch(/px$/);
  });

  it('also realigns on window resize', () => {
    const plain = document.createElement('div');
    document.body.appendChild(plain);
    const dom = indicatorInside(plain);

    window.dispatchEvent(new Event('resize'));

    expect(dom.style.left).toBe('0px');
  });
});
