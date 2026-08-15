/**
 * Document analysis for the WYSIWYG diagnostics plugin, driven through a
 * real ProseMirror document.
 *
 * The contract under test is the one that decides whether a squiggle lands
 * on the right word: a segment's `from` must be the document position of
 * its first character, so a string offset within the segment text adds
 * directly to it with no translation step. Inline leaf nodes are the trap —
 * an image counts as one position but has no text, so anything that
 * flattens it to "" or to a multi-character placeholder silently shifts
 * every later word in the block.
 */

import { describe, expect, it } from 'vitest';
import { Schema, type Node as ProseNode } from '@milkdown/kit/prose/model';
import { EditorState } from '@milkdown/kit/prose/state';
import { DecorationSet, EditorView } from '@milkdown/kit/prose/view';
import {
  analyzeDocument,
  diagnosticDecorations,
  diagnosticsPlugin,
  diagnosticsPluginKey,
  withinDocument
} from './diagnostics';
import type { Diagnostic } from '$lib/diagnostics/types';
import { noteHref } from '../wikilink-href';
import { userHref } from '../user-mention-href';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    heading: { group: 'block', content: 'inline*', toDOM: () => ['h1', 0] },
    code_block: {
      group: 'block',
      content: 'text*',
      code: true,
      marks: '',
      toDOM: () => ['pre', ['code', 0]]
    },
    image: { group: 'inline', inline: true, toDOM: () => ['img'] },
    text: { group: 'inline' }
  },
  marks: {
    code: { toDOM: () => ['code', 0] },
    link: {
      attrs: { href: {} },
      toDOM: (mark) => ['a', { href: mark.attrs.href as string }, 0]
    }
  }
});

const para = (...content: ProseNode[]) =>
  schema.node('paragraph', null, content);
const doc = (...blocks: ProseNode[]) => schema.node('doc', null, blocks);
const t = (text: string, marks: ProseNode['marks'] = []) =>
  schema.text(text, marks);

/** The document position each segment's text starts at, per the segment. */
function textAt(document: ProseNode, from: number, length: number): string {
  return document.textBetween(
    from,
    from + length,
    ' ',
    String.fromCharCode(0xfffc)
  );
}

describe('analyzeDocument', () => {
  it('produces one segment per textblock', () => {
    const d = doc(para(t('first para')), para(t('second para')));
    expect(analyzeDocument(d).segments.map((s) => s.text)).toEqual([
      'first para',
      'second para'
    ]);
  });

  it('anchors a segment at the position of its first character', () => {
    const d = doc(para(t('hello')));
    const [segment] = analyzeDocument(d).segments;
    // Position 0 is before the paragraph; 1 is its first character.
    expect(segment.from).toBe(1);
    expect(textAt(d, segment.from, segment.text.length)).toBe('hello');
  });

  it('keeps offsets aligned across multiple blocks', () => {
    const d = doc(para(t('aa')), para(t('bbb')));
    for (const segment of analyzeDocument(d).segments) {
      expect(textAt(d, segment.from, segment.text.length)).toBe(segment.text);
    }
  });

  it('keeps offsets aligned after an inline leaf node', () => {
    // The trap: the image occupies one position but contributes no text.
    const d = doc(para(t('before '), schema.node('image'), t(' after')));
    const [segment] = analyzeDocument(d).segments;
    expect(segment.text).toHaveLength('before   after'.length);
    expect(textAt(d, segment.from, segment.text.length)).toBe(segment.text);
    // The word after the image must still map back to itself.
    const at = segment.text.indexOf('after');
    expect(textAt(d, segment.from + at, 5)).toBe('after');
  });

  it('includes headings', () => {
    const d = doc(schema.node('heading', null, [t('A title')]));
    expect(analyzeDocument(d).segments.map((s) => s.text)).toEqual(['A title']);
  });

  it('skips empty and whitespace-only blocks', () => {
    const d = doc(para(), para(t('   ')), para(t('real')));
    expect(analyzeDocument(d).segments.map((s) => s.text)).toEqual(['real']);
  });

  describe('non-prose regions', () => {
    it('excludes code blocks entirely rather than skipping them', () => {
      const d = doc(
        para(t('prose')),
        schema.node('code_block', null, [t('notaword')])
      );
      expect(analyzeDocument(d).segments.map((s) => s.text)).toEqual(['prose']);
    });

    it('marks inline code as skipped', () => {
      const d = doc(
        para(t('run '), t('npmm', [schema.mark('code')]), t(' now'))
      );
      const { segments, skips } = analyzeDocument(d);
      expect(segments[0].text).toBe('run npmm now');
      expect(skips).toHaveLength(1);
      expect(textAt(d, skips[0].from, skips[0].to - skips[0].from)).toBe(
        'npmm'
      );
    });

    it('marks wikilink text as skipped', () => {
      const link = schema.mark('link', { href: noteHref('abc') });
      const d = doc(para(t('see '), t('Meeting Notiz', [link])));
      const { skips } = analyzeDocument(d);
      expect(skips).toHaveLength(1);
      expect(textAt(d, skips[0].from, skips[0].to - skips[0].from)).toBe(
        'Meeting Notiz'
      );
    });

    it('marks @mention text as skipped', () => {
      const link = schema.mark('link', { href: userHref('jannik') });
      const d = doc(para(t('ask '), t('@jannikg', [link])));
      expect(analyzeDocument(d).skips).toHaveLength(1);
    });

    it('still checks the text of an ordinary external link', () => {
      const link = schema.mark('link', { href: 'https://example.com' });
      const d = doc(para(t('see '), t('the docs', [link])));
      expect(analyzeDocument(d).skips).toEqual([]);
    });
  });
});

describe('diagnosticDecorations', () => {
  const diag = (over: Partial<Diagnostic>): Diagnostic => ({
    from: 1,
    to: 5,
    kind: 'spelling',
    message: 'x',
    replacements: [],
    source: 'test',
    ...over
  });

  it('creates one decoration per diagnostic', () => {
    const d = doc(para(t('hello world')));
    const set = diagnosticDecorations(d, [diag({ from: 1, to: 6 })]);
    expect(set.find()).toHaveLength(1);
  });

  it('drops a diagnostic that runs past the end of the document', () => {
    // A stale result racing an edit — DecorationSet.create would throw and
    // take the editor down with it.
    const d = doc(para(t('hi')));
    expect(() =>
      diagnosticDecorations(d, [diag({ from: 1, to: 999 })])
    ).not.toThrow();
    expect(
      diagnosticDecorations(d, [diag({ from: 1, to: 999 })]).find()
    ).toEqual([]);
  });

  it('drops an empty or inverted range', () => {
    const d = doc(para(t('hello')));
    expect(diagnosticDecorations(d, [diag({ from: 3, to: 3 })]).find()).toEqual(
      []
    );
    expect(diagnosticDecorations(d, [diag({ from: 4, to: 2 })]).find()).toEqual(
      []
    );
  });
});

/**
 * Lifecycle regressions, both from real bugs.
 *
 * A plugin can see its own document change and re-check. It cannot see the
 * language selection change or a dictionary finish installing — and both
 * change the verdict for text nobody has touched. The first version only
 * re-checked on `docChanged`, so enabling German left every German word
 * underlined, each one "correcting" to its own spelling: the squiggle was
 * stale while the suggestion lookup was live.
 */
describe('diagnosticsPlugin lifecycle', () => {
  interface Harness {
    view: EditorView;
    invalidate: () => void;
    setEnabled: (value: boolean) => void;
    checks: number;
    decorationCount: () => number;
  }

  function mount(text: string, startEnabled = true): Harness {
    const listeners = new Set<() => void>();
    let enabled = startEnabled;
    const harness = {
      checks: 0
    } as Harness;

    const plugin = diagnosticsPlugin({
      debounceMs: 0,
      enabled: () => enabled,
      subscribeInvalidate: (recheck) => {
        listeners.add(recheck);
        return () => listeners.delete(recheck);
      },
      check: async (segments) => {
        harness.checks += 1;
        // Flag the whole of every segment, so any check produces exactly
        // one decoration per paragraph.
        return segments.map((segment) => ({
          from: segment.from,
          to: segment.to,
          kind: 'spelling' as const,
          message: 'x',
          replacements: [],
          source: 'test'
        }));
      }
    });

    const host = document.createElement('div');
    document.body.append(host);
    const view = new EditorView(host, {
      state: EditorState.create({ doc: doc(para(t(text))), plugins: [plugin] })
    });

    harness.view = view;
    harness.invalidate = () => listeners.forEach((listener) => listener());
    harness.setEnabled = (value) => {
      enabled = value;
    };
    harness.decorationCount = () =>
      (
        diagnosticsPluginKey.getState(view.state)?.deco ?? DecorationSet.empty
      ).find().length;
    return harness;
  }

  /** The plugin schedules on a timer and then awaits the check. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  it('checks once on open without needing an edit', async () => {
    const h = mount('hello world');
    await settle();
    expect(h.checks).toBe(1);
    expect(h.decorationCount()).toBe(1);
    h.view.destroy();
  });

  it('re-checks when invalidated, with no document change', async () => {
    const h = mount('hello world', false);
    await settle();
    expect(h.decorationCount()).toBe(0);

    // The user enables a language: nothing in the document changed.
    h.setEnabled(true);
    h.invalidate();
    await settle();

    expect(h.decorationCount()).toBe(1);
    h.view.destroy();
  });

  it('clears what it drew when checking is turned off', async () => {
    const h = mount('hello world');
    await settle();
    expect(h.decorationCount()).toBe(1);

    h.setEnabled(false);
    h.invalidate();
    await settle();

    // Leaving stale squiggles after the feature is switched off is worse
    // than never having drawn them.
    expect(h.decorationCount()).toBe(0);
    h.view.destroy();
  });

  it('does not call the checker at all while disabled', async () => {
    const h = mount('hello world', false);
    await settle();
    expect(h.checks).toBe(0);
    h.view.destroy();
  });

  it('stops listening once destroyed', async () => {
    const h = mount('hello world');
    await settle();
    const before = h.checks;
    h.view.destroy();

    h.invalidate();
    await settle();
    expect(h.checks).toBe(before);
  });
});

/**
 * The reported bug: after applying one suggestion, clicking further ones
 * did nothing.
 *
 * Decorations were mapped through edits but the diagnostics behind them
 * were not, so right-click hit-tested against pre-edit positions and the
 * range handed to "apply" pointed at text that had moved.
 */
describe('positions survive edits', () => {
  function mounted(text: string) {
    const plugin = diagnosticsPlugin({
      debounceMs: 0,
      check: async (segments) =>
        segments.flatMap((segment) => {
          const at = segment.text.indexOf('teh');
          return at === -1
            ? []
            : [
                {
                  from: segment.from + at,
                  to: segment.from + at + 3,
                  kind: 'spelling' as const,
                  message: 'x',
                  replacements: ['the'],
                  source: 'test'
                }
              ];
        })
    });
    const host = document.createElement('div');
    document.body.append(host);
    const view = new EditorView(host, {
      state: EditorState.create({ doc: doc(para(t(text))), plugins: [plugin] })
    });
    return view;
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  const state = (view: EditorView) =>
    diagnosticsPluginKey.getState(view.state)!;

  it('keeps the diagnostic on its word after an edit earlier in the doc', async () => {
    const view = mounted('one teh two');
    await settle();
    const before = state(view).diagnostics[0];
    expect(view.state.doc.textBetween(before.from, before.to)).toBe('teh');

    // Insert ahead of the diagnostic — everything after it shifts.
    view.dispatch(view.state.tr.insertText('XXXX ', 1));

    const after = state(view).diagnostics[0];
    expect(after.from).toBe(before.from + 5);
    // The real assertion: the range still covers the same word.
    expect(view.state.doc.textBetween(after.from, after.to)).toBe('teh');
    view.destroy();
  });

  it('keeps decorations and diagnostics in step', async () => {
    // They are drawn from one and clicked through the other; drift between
    // them is exactly what made a click land on nothing.
    const view = mounted('one teh two');
    await settle();
    view.dispatch(view.state.tr.insertText('XXXX ', 1));

    const { diagnostics, deco } = state(view);
    const drawn = deco.find();
    expect(drawn).toHaveLength(1);
    expect(drawn[0].from).toBe(diagnostics[0].from);
    expect(drawn[0].to).toBe(diagnostics[0].to);
    view.destroy();
  });

  it('drops a diagnostic whose word was deleted', async () => {
    const view = mounted('one teh two');
    await settle();
    const { from, to } = state(view).diagnostics[0];
    view.dispatch(view.state.tr.delete(from, to));

    // Range collapses, so nothing is drawn over it any more.
    expect(state(view).deco.find()).toHaveLength(0);
    view.destroy();
  });
});

/**
 * The apply path, driven the way a user drives it: right-click the squiggle,
 * then choose a replacement. Everything up to here was tested except the one
 * step that edits the document.
 */
describe('applying a suggestion', () => {
  function mounted(text: string) {
    let context: {
      word: string;
      apply: (replacement: string) => void;
    } | null = null;

    const plugin = diagnosticsPlugin({
      debounceMs: 0,
      check: async (segments) =>
        segments.flatMap((segment) => {
          const at = segment.text.indexOf('teh');
          return at === -1
            ? []
            : [
                {
                  from: segment.from + at,
                  to: segment.from + at + 3,
                  kind: 'spelling' as const,
                  message: 'x',
                  replacements: ['the'],
                  source: 'test'
                }
              ];
        }),
      onRequestMenu: (_diagnostic, _event, ctx) => {
        context = ctx;
      }
    });

    const host = document.createElement('div');
    document.body.append(host);
    const view = new EditorView(host, {
      state: EditorState.create({ doc: doc(para(t(text))), plugins: [plugin] })
    });
    return { view, menu: () => context };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  /** jsdom has no layout, so coordinate hit-testing is stubbed. */
  function rightClickAt(view: EditorView, pos: number) {
    view.posAtCoords = () => ({ pos, inside: -1 });
    view.dom.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    );
  }

  it('replaces the flagged word in the document', async () => {
    const view = mounted('one teh two');
    await settle();

    rightClickAt(view.view, 6);
    expect(view.menu()).not.toBeNull();
    expect(view.menu()!.word).toBe('teh');

    view.menu()!.apply('the');
    expect(view.view.state.doc.textContent).toBe('one the two');
    view.view.destroy();
  });

  it('replaces the right word after an earlier edit moved it', async () => {
    // The reported failure: apply stopped working once anything had changed.
    const view = mounted('one teh two');
    await settle();
    view.view.dispatch(view.view.state.tr.insertText('XXXX ', 1));

    const moved = diagnosticsPluginKey.getState(view.view.state)!
      .diagnostics[0];
    rightClickAt(view.view, moved.from + 1);

    view.menu()!.apply('the');
    expect(view.view.state.doc.textContent).toBe('XXXX one the two');
    view.view.destroy();
  });

  it('replaces only the flagged range, leaving the rest intact', async () => {
    const view = mounted('teh teh');
    await settle();
    rightClickAt(view.view, 2);
    view.menu()!.apply('the');
    expect(view.view.state.doc.textContent).toBe('the teh');
    view.view.destroy();
  });
});

describe('withinDocument', () => {
  it('drops a range that runs past the end of the document', () => {
    // Kept in state, such a diagnostic stays clickable and insertText
    // throws on it — which looks exactly like a suggestion doing nothing.
    const d = doc(para(t('hi')));
    const stale = {
      from: 1,
      to: 999,
      kind: 'spelling' as const,
      message: 'x',
      replacements: [],
      source: 'test'
    };
    expect(withinDocument(d, [stale])).toEqual([]);
  });

  it('drops a range that collapsed to nothing', () => {
    const d = doc(para(t('hi')));
    const collapsed = {
      from: 2,
      to: 2,
      kind: 'spelling' as const,
      message: 'x',
      replacements: [],
      source: 'test'
    };
    expect(withinDocument(d, [collapsed])).toEqual([]);
  });

  it('keeps a range that exists', () => {
    const d = doc(para(t('hello')));
    const ok = {
      from: 1,
      to: 6,
      kind: 'spelling' as const,
      message: 'x',
      replacements: [],
      source: 'test'
    };
    expect(withinDocument(d, [ok])).toEqual([ok]);
  });
});

/**
 * Results arriving after the document has moved.
 *
 * A LanguageTool round trip takes seconds, and a note keeps changing while
 * its content loads. Discarding results because the document changed meant
 * the first several checks were thrown away and nothing appeared until the
 * document went quiet — measured at ~20s for a 350-word note.
 */
describe('slow checks', () => {
  function mounted(text: string) {
    let release: ((value: Diagnostic[]) => void) | null = null;
    let calls = 0;

    const plugin = diagnosticsPlugin({
      debounceMs: 0,
      check: (segments) => {
        calls++;
        void segments;
        return new Promise<Diagnostic[]>((resolve) => {
          release = resolve;
        });
      }
    });

    const host = document.createElement('div');
    document.body.append(host);
    const view = new EditorView(host, {
      state: EditorState.create({ doc: doc(para(t(text))), plugins: [plugin] })
    });
    return {
      view,
      finish: (d: Diagnostic[]) => release?.(d),
      callCount: () => calls
    };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  const flagging = (from: number, to: number): Diagnostic => ({
    from,
    to,
    kind: 'spelling',
    message: 'x',
    replacements: [],
    source: 'test'
  });

  it('moves a late result onto the text where it now is', async () => {
    const h = mounted('one teh two');
    await settle();

    // The document changes while the request is outstanding.
    h.view.dispatch(h.view.state.tr.insertText('XXXX ', 1));
    // The answer describes the document as it was: "teh" at 5..8.
    h.finish([flagging(5, 8)]);
    await settle();

    const { diagnostics } = diagnosticsPluginKey.getState(h.view.state)!;
    expect(diagnostics).toHaveLength(1);
    expect(
      h.view.state.doc.textBetween(diagnostics[0].from, diagnostics[0].to)
    ).toBe('teh');
    h.view.destroy();
  });

  it('does not start a second request while one is outstanding', async () => {
    // Piling requests onto a server that already takes seconds only makes
    // the wait worse.
    const h = mounted('one teh two');
    await settle();
    expect(h.callCount()).toBe(1);

    h.view.dispatch(h.view.state.tr.insertText('a', 1));
    h.view.dispatch(h.view.state.tr.insertText('b', 1));
    await settle();
    expect(h.callCount()).toBe(1);

    h.view.destroy();
  });

  it('runs once more for the edits that arrived meanwhile', async () => {
    const h = mounted('one teh two');
    await settle();
    h.view.dispatch(h.view.state.tr.insertText('a', 1));
    await settle();

    h.finish([]);
    await settle();
    expect(h.callCount()).toBe(2);
    h.view.destroy();
  });
});
