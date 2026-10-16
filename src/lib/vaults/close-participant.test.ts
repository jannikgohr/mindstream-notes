import { describe, expect, it, vi } from 'vitest';
import { createCloseParticipant } from './close-participant';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function participant(flush: () => Promise<void>) {
  const restore = vi.fn();
  const options = {
    flush,
    acknowledge: vi.fn(async (_id: string, _saved: boolean) => {}),
    freeze: vi.fn(() => restore),
    failed: vi.fn(),
    phase: vi.fn(),
    onError: vi.fn()
  };
  return { ...createCloseParticipant(options), ...options, restore };
}

describe('controlled worker close', () => {
  it('freezes while services drain and flushes only once preparation begins', async () => {
    const window = participant(vi.fn(async () => {}));
    await window.receive({ id: 'first', phase: 'waiting' });
    await window.receive({ id: 'first', phase: 'waiting' });
    expect(window.freeze).toHaveBeenCalledTimes(1);
    expect(window.flush).not.toHaveBeenCalled();
    expect(window.acknowledge).not.toHaveBeenCalled();
    await window.receive({ id: 'first', phase: 'prepare' });
    await window.receive({ id: 'first', phase: 'waiting' });
    await window.receive({ id: 'first', phase: 'prepare' });
    expect(window.freeze).toHaveBeenCalledTimes(1);
    expect(window.flush).toHaveBeenCalledTimes(1);
    expect(window.phase.mock.calls).toEqual([['waiting'], ['prepare']]);
    expect(window.acknowledge.mock.calls).toEqual([['first', true]]);
    expect(window.restore).not.toHaveBeenCalled();
  });

  it('resumes on a service-drain cancellation and ignores late waiting/preparation', async () => {
    const window = participant(vi.fn(async () => {}));
    await window.receive({ id: 'first', phase: 'waiting' });
    await window.receive({ id: 'first', phase: 'cancel' });
    await window.receive({ id: 'first', phase: 'waiting' });
    await window.receive({ id: 'first', phase: 'prepare' });
    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.failed).toHaveBeenCalledTimes(1);
    expect(window.flush).not.toHaveBeenCalled();
    expect(window.acknowledge).not.toHaveBeenCalled();
    await window.receive({ id: 'next', phase: 'waiting' });
    await window.receive({ id: 'next', phase: 'prepare' });
    expect(window.acknowledge.mock.calls).toEqual([['next', true]]);
  });

  it('distinguishes recovery cancellation from persistence failure and resumes editing', async () => {
    const window = participant(vi.fn(async () => {}));
    await window.receive({ id: 'first', phase: 'waiting' });
    await window.receive({ id: 'first', phase: 'cancel', reason: 'recovery' });
    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.failed).toHaveBeenCalledWith('recovery');
    expect(window.flush).not.toHaveBeenCalled();
  });

  it('ignores a late waiting phase from a cancelled batch during a newer save', async () => {
    const saving = deferred();
    const window = participant(vi.fn(() => saving.promise));
    await window.receive({ id: 'first', phase: 'waiting' });
    await window.receive({ id: 'first', phase: 'cancel' });
    const next = window.receive({ id: 'next', phase: 'prepare' });
    await window.receive({ id: 'first', phase: 'waiting' });
    expect(window.freeze).toHaveBeenCalledTimes(2);
    saving.resolve();
    await next;
    expect(window.acknowledge.mock.calls).toEqual([['next', true]]);
  });

  it('ignores preparation delivered after its cancellation', async () => {
    const window = participant(vi.fn(async () => {}));
    await window.receive({ id: 'first', phase: 'cancel' });
    await window.receive({ id: 'first', phase: 'prepare' });
    expect(window.freeze).not.toHaveBeenCalled();
    expect(window.flush).not.toHaveBeenCalled();
    expect(window.acknowledge).not.toHaveBeenCalled();
  });
  it('deduplicates preparation and stays frozen after saving until native exit', async () => {
    const saving = deferred();
    const window = participant(vi.fn(() => saving.promise));
    const first = window.receive({ id: 'first', phase: 'prepare' });
    await window.receive({ id: 'first', phase: 'prepare' });
    expect(window.freeze).toHaveBeenCalledTimes(1);
    expect(window.acknowledge).not.toHaveBeenCalled();
    saving.resolve();
    await first;
    expect(window.acknowledge.mock.calls).toEqual([['first', true]]);
    expect(window.restore).not.toHaveBeenCalled();
  });

  it('cancels a timed-out close and ignores its late save when a new close begins', async () => {
    const old = deferred();
    const next = deferred();
    const window = participant(
      vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    );
    const first = window.receive({ id: 'first', phase: 'prepare' });
    await window.receive({ id: 'first', phase: 'cancel' });
    expect(window.restore).toHaveBeenCalledTimes(1);
    const second = window.receive({ id: 'second', phase: 'prepare' });
    old.resolve();
    await first;
    await window.receive({ id: 'first', phase: 'cancel' });
    expect(window.acknowledge).not.toHaveBeenCalled();
    expect(window.restore).toHaveBeenCalledTimes(1);
    next.resolve();
    await second;
    expect(window.acknowledge.mock.calls).toEqual([['second', true]]);
  });

  it('reports failed persistence and only resumes input after native cancellation', async () => {
    const window = participant(async () => {
      throw new Error('disk full');
    });
    await window.receive({ id: 'first', phase: 'prepare' });
    expect(window.acknowledge.mock.calls).toEqual([['first', false]]);
    expect(window.restore).not.toHaveBeenCalled();
    await window.receive({ id: 'first', phase: 'cancel' });
    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.failed).toHaveBeenCalledTimes(1);
  });

  it('does not resume editing when a successful acknowledgement reply is lost', async () => {
    const window = participant(async () => {});
    window.acknowledge.mockRejectedValue(new Error('reply lost'));
    await window.receive({ id: 'first', phase: 'prepare' });
    expect(window.acknowledge.mock.calls).toEqual([
      ['first', true],
      ['first', false]
    ]);
    expect(window.restore).not.toHaveBeenCalled();
  });

  it('releases input and reports an unsaved close when the window goes away mid-close', async () => {
    const window = participant(async () => {});
    window.acknowledge.mockRejectedValueOnce(new Error('window gone'));
    await window.receive({ id: 'first', phase: 'waiting' });
    window.dispose();
    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.acknowledge.mock.calls).toEqual([['first', false]]);
    await vi.waitFor(() => expect(window.onError).toHaveBeenCalledTimes(1));
    await window.receive({ id: 'second', phase: 'prepare' });
    expect(window.freeze).toHaveBeenCalledTimes(1);
    window.dispose();
    expect(window.acknowledge).toHaveBeenCalledTimes(1);
  });

  it('remembers a bounded number of cancellations', async () => {
    const window = participant(async () => {});
    for (let index = 0; index <= 64; index += 1) {
      await window.receive({ id: `cancelled-${index}`, phase: 'cancel' });
    }
    // The newest cancellations still suppress their delayed notifications.
    await window.receive({ id: 'cancelled-64', phase: 'waiting' });
    expect(window.freeze).not.toHaveBeenCalled();
    // The oldest one was forgotten to keep the set bounded.
    await window.receive({ id: 'cancelled-0', phase: 'waiting' });
    expect(window.freeze).toHaveBeenCalledTimes(1);
  });
});
