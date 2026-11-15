import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDiagnosticRunner } from './runner';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('diagnostic runner', () => {
  it('delivers during edits and consumes the pending debounce in one trailing run', async () => {
    vi.useFakeTimers();
    const waits = [deferred(), deferred()];
    const contexts: {
      signal: AbortSignal;
      publish(action: () => void): void;
    }[] = [];
    const draw = vi.fn();
    const run = vi.fn(async (context) => {
      contexts.push(context);
      await waits[contexts.length - 1].promise;
      context.publish(draw);
    });
    const runner = createDiagnosticRunner({
      debounceMs: 400,
      clear: vi.fn(),
      run
    });
    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    runner.documentChanged();
    await vi.advanceTimersByTimeAsync(400);
    runner.documentChanged();
    expect(run).toHaveBeenCalledTimes(1);
    contexts[0].publish(draw);
    expect(draw).toHaveBeenCalledTimes(1);
    waits[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    contexts[0].publish(draw);
    expect(draw).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    waits[1].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    runner.destroy();
  });

  it('clears disabled findings and blocks aborted or destroyed delivery before settling', async () => {
    vi.useFakeTimers();
    const wait = deferred();
    let enabled = true;
    let context!: { signal: AbortSignal; publish(action: () => void): void };
    const clear = vi.fn();
    const draw = vi.fn();
    const run = vi.fn(async (value) => {
      context = value;
      await wait.promise;
    });
    const runner = createDiagnosticRunner({
      debounceMs: 400,
      enabled: () => enabled,
      clear,
      run
    });
    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    enabled = false;
    runner.invalidate();
    expect(clear).toHaveBeenCalledOnce();
    expect(context.signal.aborted).toBe(true);
    context.publish(draw);
    runner.documentChanged();
    runner.destroy();
    wait.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    context.publish(draw);
    expect(draw).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
  });

  it('recovers from synchronous and asynchronous preparation failures', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => {
        throw new Error('sync');
      })
      .mockRejectedValueOnce(new Error('async'))
      .mockResolvedValue(undefined);
    const runner = createDiagnosticRunner({
      debounceMs: 1,
      clear: vi.fn(),
      run
    });
    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    runner.invalidate();
    await vi.advanceTimersByTimeAsync(0);
    runner.invalidate();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(3);
    runner.destroy();
  });

  it('handles synchronous publication that invalidates and abort listeners that destroy', async () => {
    vi.useFakeTimers();
    const wait = deferred();
    const draw = vi.fn();
    const run = vi.fn(async ({ signal, publish }) => {
      signal.addEventListener('abort', () => runner.destroy());
      publish(() => runner.invalidate());
      publish(draw);
      await wait.promise;
    });
    const runner = createDiagnosticRunner({
      debounceMs: 1,
      clear: vi.fn(),
      run
    });
    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    wait.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledOnce();
    expect(draw).not.toHaveBeenCalled();
  });
});

it('rejects invalidated partial and final results until a fresh run starts', async () => {
  vi.useFakeTimers();
  const wait = deferred();
  const draw = vi.fn();
  let oldPublish!: (action: () => void) => void;
  const run = vi
    .fn()
    .mockImplementationOnce(async ({ publish }) => {
      oldPublish = publish;
      await wait.promise;
      publish(draw);
    })
    .mockResolvedValue(undefined);
  const runner = createDiagnosticRunner({ debounceMs: 1, clear: vi.fn(), run });
  runner.start();
  await vi.advanceTimersByTimeAsync(0);
  runner.invalidate();
  oldPublish(draw);
  expect(run).toHaveBeenCalledOnce();
  wait.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(2);
  oldPublish(draw);
  expect(draw).not.toHaveBeenCalled();
  runner.destroy();
});
