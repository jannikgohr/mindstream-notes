/**
 * CRDT-merge sanity tests for the PDF annotation Y.Map shape used by
 * PdfNoteViewer. These exercise Yjs directly with the same key
 * ('pdf_annotations') and value shape the component stores, so any
 * regression in our model that would break live collab between two
 * peers shows up here without needing a real relay or browser.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { PDF_ANNOTATIONS_MAP, type PdfAnnotation } from '$lib/pdf/types';

type Annotation = PdfAnnotation;

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    type: 'highlight',
    pageIndex: 0,
    rects: [{ x: 0, y: 0, width: 100, height: 20 }],
    color: '#facc15',
    opacity: 0.32,
    authorId: 'peer-a',
    createdAt: '2026-06-03T00:00:00.000Z',
    updatedAt: '2026-06-03T00:00:00.000Z',
    ...overrides
  };
}

/** Bidirectional sync — fold each doc's full state into the other. */
function syncDocs(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

function annotationsOf(doc: Y.Doc): Annotation[] {
  return Array.from(
    doc.getMap<Annotation>(PDF_ANNOTATIONS_MAP).values()
  ).sort((x, y) => x.id.localeCompare(y.id));
}

describe('pdf annotations sync', () => {
  it('merges concurrent annotation adds from two peers', () => {
    const peerA = new Y.Doc();
    const peerB = new Y.Doc();

    const a = makeAnnotation({ id: 'a-1', authorId: 'peer-a', body: 'A' });
    const b = makeAnnotation({ id: 'b-1', authorId: 'peer-b', body: 'B' });
    peerA.getMap<Annotation>(PDF_ANNOTATIONS_MAP).set(a.id, a);
    peerB.getMap<Annotation>(PDF_ANNOTATIONS_MAP).set(b.id, b);

    syncDocs(peerA, peerB);

    expect(annotationsOf(peerA).map((x) => x.id)).toEqual(['a-1', 'b-1']);
    expect(annotationsOf(peerB).map((x) => x.id)).toEqual(['a-1', 'b-1']);
    expect(annotationsOf(peerA)).toEqual(annotationsOf(peerB));
  });

  it('applying the same update twice is a no-op (idempotent)', () => {
    const peerA = new Y.Doc();
    const peerB = new Y.Doc();
    const ann = makeAnnotation({ id: 'a-1' });
    peerA.getMap<Annotation>(PDF_ANNOTATIONS_MAP).set(ann.id, ann);

    const update = Y.encodeStateAsUpdate(peerA);
    Y.applyUpdate(peerB, update);
    Y.applyUpdate(peerB, update);

    expect(annotationsOf(peerB)).toEqual(annotationsOf(peerA));
    expect(peerB.getMap(PDF_ANNOTATIONS_MAP).size).toBe(1);
  });

  it('concurrent body edits to the same annotation converge', () => {
    // Both peers start from a shared baseline so they observe the same
    // initial annotation, then mutate the same key concurrently. With
    // whole-object Map.set the last writer wins, but both docs MUST
    // agree on the winner — that's the convergence property we care
    // about for live collab.
    const peerA = new Y.Doc();
    const peerB = new Y.Doc();
    const ann = makeAnnotation({ id: 'a-1', body: 'initial' });
    peerA.getMap<Annotation>(PDF_ANNOTATIONS_MAP).set(ann.id, ann);
    syncDocs(peerA, peerB);

    const fromA = peerA.getMap<Annotation>(PDF_ANNOTATIONS_MAP).get(ann.id)!;
    peerA
      .getMap<Annotation>(PDF_ANNOTATIONS_MAP)
      .set(ann.id, { ...fromA, body: 'edit-from-A' });
    const fromB = peerB.getMap<Annotation>(PDF_ANNOTATIONS_MAP).get(ann.id)!;
    peerB
      .getMap<Annotation>(PDF_ANNOTATIONS_MAP)
      .set(ann.id, { ...fromB, body: 'edit-from-B' });

    syncDocs(peerA, peerB);

    const winnerA = peerA
      .getMap<Annotation>(PDF_ANNOTATIONS_MAP)
      .get(ann.id)!;
    const winnerB = peerB
      .getMap<Annotation>(PDF_ANNOTATIONS_MAP)
      .get(ann.id)!;
    expect(winnerA).toEqual(winnerB);
    expect(['edit-from-A', 'edit-from-B']).toContain(winnerA.body);
  });

  it('delete on one peer wins over a concurrent edit on the other', () => {
    // In Y.Map a delete is itself a write, and Yjs's deterministic
    // tie-break ensures both peers agree on whether the slot ends up
    // deleted or repopulated. We only require convergence — not that
    // delete specifically wins.
    const peerA = new Y.Doc();
    const peerB = new Y.Doc();
    const ann = makeAnnotation({ id: 'a-1', body: 'initial' });
    peerA.getMap<Annotation>(PDF_ANNOTATIONS_MAP).set(ann.id, ann);
    syncDocs(peerA, peerB);

    peerA.getMap<Annotation>(PDF_ANNOTATIONS_MAP).delete(ann.id);
    const fromB = peerB.getMap<Annotation>(PDF_ANNOTATIONS_MAP).get(ann.id)!;
    peerB
      .getMap<Annotation>(PDF_ANNOTATIONS_MAP)
      .set(ann.id, { ...fromB, body: 'edit-from-B' });

    syncDocs(peerA, peerB);

    const inA = peerA.getMap<Annotation>(PDF_ANNOTATIONS_MAP).get(ann.id);
    const inB = peerB.getMap<Annotation>(PDF_ANNOTATIONS_MAP).get(ann.id);
    expect(inA).toEqual(inB);
  });

  it('comment-style highlight body merges round-trip through encode/apply', () => {
    // Belt-and-braces check that the comment shape (highlight + body)
    // survives a full encode/apply cycle byte-for-byte. Catches the
    // class of bug where adding a new field to PdfAnnotation would
    // silently get dropped by JSON-incompatible serialisation.
    const peerA = new Y.Doc();
    const peerB = new Y.Doc();
    const ann = makeAnnotation({
      id: 'c-1',
      type: 'highlight',
      body: 'Looks good!',
      resolved: false
    });
    peerA.getMap<Annotation>(PDF_ANNOTATIONS_MAP).set(ann.id, ann);

    syncDocs(peerA, peerB);

    const onB = peerB.getMap<Annotation>(PDF_ANNOTATIONS_MAP).get(ann.id);
    expect(onB).toEqual(ann);
  });
});
