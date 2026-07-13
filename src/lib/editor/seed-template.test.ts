/**
 * The seed-template fix hinges on one invariant: converting the same content
 * into a Yjs XmlFragment with a FIXED client id yields byte-identical bytes,
 * so two devices seeding the same note share one origin op and a merge keeps
 * the content once. seedDeterministicTemplate itself needs a live Milkdown
 * ctx (parser + schema), which isn't constructible in a unit test — so these
 * exercise the exact primitive it relies on (prosemirrorToYXmlFragment on a
 * fixed-client-id doc) with a minimal ProseMirror schema.
 */

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';
import { Schema, type Node as PMNode } from 'prosemirror-model';

import { TEMPLATE_ORIGIN_CLIENT_ID } from './seed-template';

// Minimal doc/paragraph/text schema — enough to stand in for a parsed note.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    text: { group: 'inline' }
  }
});

function docFrom(...paragraphs: string[]): PMNode {
  return schema.node(
    'doc',
    null,
    paragraphs.map((p) =>
      schema.node('paragraph', null, p ? [schema.text(p)] : [])
    )
  );
}

/** Mirror of seedDeterministicTemplate's core: node → fixed-origin update. */
function originUpdate(node: PMNode): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = TEMPLATE_ORIGIN_CLIENT_ID;
  prosemirrorToYXmlFragment(node, doc.getXmlFragment('prosemirror'));
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function fragmentText(update: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc.getXmlFragment('prosemirror').toString();
}

describe('deterministic seed template origin', () => {
  it('produces byte-identical bytes for the same content', () => {
    const a = originUpdate(docFrom('# Welcome', 'local-first note app'));
    const b = originUpdate(docFrom('# Welcome', 'local-first note app'));
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('two devices sharing the origin merge to a single copy', () => {
    // Both devices seed the identical origin, then each appends its own edit
    // on the live doc (its own random client id).
    const base = originUpdate(docFrom('# Welcome', 'local-first note app'));

    const deviceA = new Y.Doc();
    Y.applyUpdate(deviceA, base);
    deviceA.getXmlFragment('prosemirror').push([new Y.XmlText('edit A')]);

    const deviceB = new Y.Doc();
    Y.applyUpdate(deviceB, base);
    deviceB.getXmlFragment('prosemirror').push([new Y.XmlText('edit B')]);

    // Merge both ways — converges either order.
    const merged = new Y.Doc();
    Y.applyUpdate(merged, Y.encodeStateAsUpdate(deviceA));
    Y.applyUpdate(merged, Y.encodeStateAsUpdate(deviceB));
    const text = merged.getXmlFragment('prosemirror').toString();

    // The seed content appears exactly once (no stacked origin)...
    expect((text.match(/local-first/g) ?? []).length).toBe(1);
    // ...and both devices' edits survive.
    expect(text).toContain('edit A');
    expect(text).toContain('edit B');
  });

  it('different content yields different bytes', () => {
    const a = originUpdate(docFrom('# Welcome'));
    const b = originUpdate(docFrom('# Ideas'));
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
});
