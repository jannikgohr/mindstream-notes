import { afterEach, describe, expect, it } from 'vitest';
import {
  closeDiagnosticPopover,
  diagnosticAnchorFrom,
  diagnosticPopover,
  openDiagnosticPopover
} from './popover-bridge.svelte';
import type { Diagnostic } from './types';

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

describe('openDiagnosticPopover', () => {
  const diagnostic = (replacements: string[]): Diagnostic => ({
    from: 0,
    to: 14,
    kind: 'spelling',
    message: 'Possible spelling mistake found.',
    replacements,
    source: 'plugins.languagetool.check'
  });

  const open = (
    word: string,
    replacements: string[],
    fetched: string[] = []
  ) => {
    openDiagnosticPopover(
      {
        word,
        diagnostic: diagnostic(replacements),
        anchor: { left: 0, top: 0, bottom: 0 },
        apply: () => {}
      },
      async () => fetched
    );
    // The lookup is awaited internally even when it resolves immediately.
    return Promise.resolve().then(() => Promise.resolve());
  };

  afterEach(() => closeDiagnosticPopover());

  it('drops a fetched suggestion identical to the flagged word', async () => {
    // The real report: LanguageTool flags a correct German compound with no
    // replacements of its own, so the local dictionary answers — and it
    // ranks the exact match first, offering the word as its own correction.
    await open(
      'Vertragsnummer',
      [],
      ['Vertragsnummer', 'Vertragsnummern', 'Vertragssummer']
    );

    expect(diagnosticPopover.suggestions).toEqual([
      'Vertragsnummern',
      'Vertragssummer'
    ]);
  });

  it('drops a provider replacement identical to the flagged word', async () => {
    await open('Vertragsnummer', ['Vertragsnummer', 'Vertragsnummern']);

    expect(diagnosticPopover.suggestions).toEqual(['Vertragsnummern']);
  });

  it('keeps a suggestion that differs only in case', async () => {
    // A case flip is a real correction, so equality has to stay exact.
    await open('nr', [], ['Nr', 'nr']);

    expect(diagnosticPopover.suggestions).toEqual(['Nr']);
  });

  it('offers nothing rather than the word when it was the only candidate', async () => {
    // An empty list reads as "no suggestion for this", which is honest. The
    // word itself reads as a correction that does nothing when applied.
    await open('Vertragsnummer', [], ['Vertragsnummer']);

    expect(diagnosticPopover.suggestions).toEqual([]);
    expect(diagnosticPopover.loading).toBe(false);
  });

  it('leaves an ordinary suggestion list untouched', async () => {
    // The filter must not become a general re-ranking: a provider that
    // supplies its own replacements keeps its order and its entries.
    await open('teh', ['the', 'tea', 'ten']);

    expect(diagnosticPopover.suggestions).toEqual(['the', 'tea', 'ten']);
  });
});
