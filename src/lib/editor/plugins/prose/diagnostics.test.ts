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
  diagnosticsPluginKey
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
      (diagnosticsPluginKey.getState(view.state) ?? DecorationSet.empty).find()
        .length;
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
