import { describe, expect, it } from 'vitest';
import { createPersistenceDrain } from './drain';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('accepted persistence writes', () => {
  it('waits for a write accepted while an earlier write is draining', async () => {
    const writes = createPersistenceDrain();
    const first = deferred();
    const second = deferred();
    writes.track(first.promise);
    let finished = false;
    const flushing = writes.flush().then(() => {
      finished = true;
    });
    writes.track(second.promise);
    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);
    second.resolve();
    await flushing;
    expect(finished).toBe(true);
  });

  it('waits for other writes after one fails, then rejects the close drain', async () => {
    const writes = createPersistenceDrain();
    const failing = deferred();
    const other = deferred();
    writes.track(failing.promise);
    writes.track(other.promise);
    let settled = false;
    const flushed = writes.flush();
    const assertion = expect(flushed).rejects.toThrow('disk full');
    void flushed.catch(() => {
      settled = true;
    });
    failing.reject(new Error('disk full'));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    other.resolve();
    await assertion;
    await writes.flush();
  });
});
