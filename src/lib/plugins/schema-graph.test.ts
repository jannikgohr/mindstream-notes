import { describe, expect, it } from 'vitest';
import { visibleGraph } from './schema-graph';

// a → b → c → d, e alone, and x is a note the plugin left out.
const outgoing = new Map([
  ['a', ['b', 'x']],
  ['b', ['c', 'a']],
  ['c', ['d', 'c']],
  ['d', []],
  ['e', []],
  ['x', ['a']]
]);
const nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
const ids = (graph: { nodes: { id: string }[] }) =>
  graph.nodes.map((n) => n.id);

describe('visibleGraph', () => {
  it('links the given notes once per pair, skipping self-links and notes left out', () => {
    const graph = visibleGraph(
      { nodes, links: [], depth: 1, orphans: true },
      outgoing
    );
    expect(ids(graph)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(graph.links).toEqual([
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd']
    ]);
  });

  it('drops unlinked notes unless asked to keep them', () => {
    expect(
      ids(
        visibleGraph({ nodes, links: [], depth: 1, orphans: false }, outgoing)
      )
    ).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps notes within depth links of the focus, in either direction', () => {
    const around = (focus: string, depth: number) =>
      ids(
        visibleGraph(
          { nodes, links: [], focus, depth, orphans: false },
          outgoing
        )
      );
    expect(around('c', 1)).toEqual(['b', 'c', 'd']);
    expect(around('d', 2)).toEqual(['b', 'c', 'd']);
    // The focus stays even with no links.
    expect(around('e', 3)).toEqual(['e']);
    // A focus the plugin left out, or no open note, shows nothing.
    expect(around('x', 1)).toEqual([]);
    expect(around('', 1)).toEqual([]);
  });

  it('adds the plugin’s own links, and reaches through them like note links', () => {
    const withTag = [...nodes, { id: 'tag:x', label: '#x' }];
    const links: [string, string][] = [
      ['e', 'tag:x'],
      ['a', 'tag:x'],
      ['tag:x', 'missing']
    ];
    const graph = visibleGraph(
      { nodes: withTag, links, focus: 'e', depth: 2, orphans: false },
      outgoing
    );
    // e → #x → a is two links; b is a third.
    expect(ids(graph)).toEqual(['a', 'e', 'tag:x']);
    expect(graph.links).toEqual([
      ['e', 'tag:x'],
      ['a', 'tag:x']
    ]);
  });
});
