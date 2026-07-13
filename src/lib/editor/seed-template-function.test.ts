import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const milkdown = vi.hoisted(() => ({
  getDoc: vi.fn(),
  parserCtx: Symbol('parserCtx'),
  schemaCtx: Symbol('schemaCtx')
}));

const yProsemirror = vi.hoisted(() => ({
  prosemirrorToYXmlFragment: vi.fn(
    (node: { textContent?: string }, fragment: Y.XmlFragment) => {
      fragment.push([new Y.XmlText(node.textContent ?? '')]);
    }
  )
}));

vi.mock('@milkdown/kit/core', () => milkdown);
vi.mock('y-prosemirror', () => yProsemirror);

describe('seedDeterministicTemplate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when markdown parses to no document', async () => {
    milkdown.getDoc.mockReturnValueOnce(null);
    const { seedDeterministicTemplate } = await import('./seed-template');
    const ctx = {
      get: vi.fn((key: symbol) => key)
    };
    const liveDoc = new Y.Doc();

    seedDeterministicTemplate(ctx as never, liveDoc, '');

    expect(yProsemirror.prosemirrorToYXmlFragment).not.toHaveBeenCalled();
    expect(liveDoc.getXmlFragment('prosemirror').length).toBe(0);
  });

  it('applies a fixed-origin template update into the live doc', async () => {
    milkdown.getDoc.mockReturnValueOnce({ textContent: 'Seed body' });
    const { seedDeterministicTemplate, TEMPLATE_ORIGIN_CLIENT_ID } =
      await import('./seed-template');
    const ctx = {
      get: vi.fn((key: symbol) => key)
    };
    const liveDoc = new Y.Doc();

    seedDeterministicTemplate(ctx as never, liveDoc, 'Seed body');

    expect(milkdown.getDoc).toHaveBeenCalledWith(
      'Seed body',
      milkdown.parserCtx,
      milkdown.schemaCtx
    );
    expect(yProsemirror.prosemirrorToYXmlFragment).toHaveBeenCalledTimes(1);
    expect(liveDoc.getXmlFragment('prosemirror').toString()).toContain(
      'Seed body'
    );
    expect(
      Y.decodeStateVector(Y.encodeStateVector(liveDoc)).has(
        TEMPLATE_ORIGIN_CLIENT_ID
      )
    ).toBe(true);
  });
});
