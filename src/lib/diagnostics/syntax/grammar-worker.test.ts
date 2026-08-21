import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrammarRequest, GrammarResponse } from './grammar-protocol';
import type { DiagnosticGrammar } from './grammar';

const posted: GrammarResponse[] = [];
let onmessage: ((event: MessageEvent<GrammarRequest>) => void) | undefined;

/**
 * A Worker global, since the module's whole job is to be one: it installs an
 * `onmessage` handler at import and answers with `postMessage`.
 */
function installWorkerGlobal(): void {
  vi.stubGlobal('self', {
    postMessage: (message: GrammarResponse) => posted.push(message),
    set onmessage(handler: (event: MessageEvent<GrammarRequest>) => void) {
      onmessage = handler;
    }
  });
}

/** Only the `data` is read, so a plain object stands in for the event. */
const send = (request: GrammarRequest) =>
  onmessage?.({ data: request } as MessageEvent<GrammarRequest>);

async function load(): Promise<void> {
  vi.resetModules();
  installWorkerGlobal();
  await import('./grammar-worker');
}

beforeEach(() => {
  posted.length = 0;
  onmessage = undefined;
});

describe('grammar worker', () => {
  it('answers a request with the grammar ranges, correlated by id', async () => {
    await load();
    const grammar: DiagnosticGrammar = { lineComments: ['%'] };
    send({ id: 7, grammar, text: 'prose % a comment' });

    expect(posted).toEqual([{ id: 7, ranges: [{ from: 6, to: 17 }] }]);
  });

  it('handles requests in order', async () => {
    await load();
    const grammar: DiagnosticGrammar = { lineComments: ['%'] };
    send({ id: 1, grammar, text: 'no comment here' });
    send({ id: 2, grammar, text: '% all comment' });

    expect(posted.map((m) => m.id)).toEqual([1, 2]);
  });

  it('reports a broken grammar as an error rather than hanging', async () => {
    await load();
    // A grammar the scanner cannot walk at all: broken plugin, not a broken
    // document, so the runner needs to hear about it rather than retry.
    send({
      id: 3,
      grammar: null as unknown as DiagnosticGrammar,
      text: 'prose'
    });

    expect(posted).toHaveLength(1);
    expect(posted[0].id).toBe(3);
    expect(posted[0].error).toBeTruthy();
    expect(posted[0].ranges).toBeUndefined();
  });
});
