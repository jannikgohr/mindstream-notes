import { describe, expect, it } from 'vitest';
import { indexGraph, type GraphIndex } from './schema-graph';

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
const ids = (graph: GraphIndex) => graph.nodes.map((n) => n.id);
const links = (graph: GraphIndex) =>
  Array.from({ length: graph.pairs.length / 2 }, (_, l) =>
    [graph.pairs[2 * l], graph.pairs[2 * l + 1]]
      .map((i) => graph.nodes[i].id)
      .sort()
      .join('-')
  );
const near = (graph: GraphIndex, id: string) => {
  const i = ids(graph).indexOf(id);
  return [...graph.adjacent.slice(graph.offset[i], graph.offset[i + 1])]
    .map((j) => graph.nodes[j].id)
    .sort();
};

describe('indexGraph', () => {
  it('links the given notes once per pair, skipping self-links and notes left out', () => {
    const graph = indexGraph(
      { nodes, links: [], depth: 1, orphans: true },
      outgoing
    );
    expect(ids(graph)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(links(graph)).toEqual(['a-b', 'b-c', 'c-d']);
    expect(near(graph, 'b')).toEqual(['a', 'c']);
    expect(near(graph, 'e')).toEqual([]);
  });

  it('drops unlinked notes unless asked to keep them', () => {
    expect(
      ids(indexGraph({ nodes, links: [], depth: 1, orphans: false }, outgoing))
    ).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps notes within depth links of the focus, in either direction', () => {
    const around = (focus: string, depth: number) =>
      ids(
        indexGraph({ nodes, links: [], focus, depth, orphans: false }, outgoing)
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
    const graph = indexGraph(
      {
        nodes: withTag,
        links: [
          ['e', 'tag:x'],
          ['a', 'tag:x'],
          ['tag:x', 'missing']
        ],
        focus: 'e',
        depth: 2,
        orphans: false
      },
      outgoing
    );
    // e → #x → a is two links; b is a third.
    expect(ids(graph)).toEqual(['a', 'e', 'tag:x']);
    expect(links(graph)).toEqual(['a-tag:x', 'e-tag:x']);
  });

  it('puts the oldest first, a tag with its first note, and orders links to match', () => {
    const born: Record<string, number> = { a: 5, b: 1, c: 4, d: 2, e: 3 };
    const graph = indexGraph(
      {
        nodes: [...nodes, { id: 'tag:x', label: '#x' }],
        links: [
          ['c', 'tag:x'],
          ['e', 'tag:x']
        ],
        depth: 1,
        orphans: true
      },
      outgoing,
      (id) => born[id] ?? NaN
    );
    expect(ids(graph)).toEqual(['b', 'd', 'e', 'tag:x', 'c', 'a']);
    // Notes of one age keep their order, each followed by its tags.
    const tagged = indexGraph(
      {
        nodes: [...nodes, { id: 'tag:x', label: '#x' }],
        links: [['b', 'tag:x']],
        depth: 1,
        orphans: true
      },
      outgoing,
      (id) => (id.startsWith('tag:') ? NaN : 7)
    );
    expect(ids(tagged)).toEqual(['a', 'b', 'tag:x', 'c', 'd', 'e']);
    // A link shows once both its ends are in: after 4 nodes, only e-#x.
    expect(links(graph).slice(0, 1)).toEqual(['e-tag:x']);
    expect(links(graph).slice(1, 4).sort()).toEqual(['b-c', 'c-d', 'c-tag:x']);
    expect(links(graph).slice(4)).toEqual(['a-b']);
    expect([...graph.linksAmong]).toEqual([0, 0, 0, 0, 1, 4, 5]);
  });
});
