import { cleanup, render } from '@testing-library/svelte';
import { flushSync, settled } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Owner from './__tests__/LazyOwner.svelte';
import Child from './__tests__/LazyChild.svelte';

function setup(keepMountedWhenInactive = false) {
  const state = $state({
    items: [] as number[],
    collectionId: null as string | null,
    view: 'invite'
  });
  const requests: {
    resolve: (module: { default: typeof Child }) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const load = vi.fn(
    () =>
      new Promise<{ default: typeof Child }>((resolve, reject) =>
        requests.push({ resolve, reject })
      )
  );
  const when = () => state.items.length > 0;
  const result = render(Owner, { when, load, keepMountedWhenInactive });
  flushSync();
  return { state, requests, load, result };
}
async function settle() {
  await Promise.resolve();
  flushSync();
  await settled();
}
beforeEach(() => {
  vi.spyOn(document, 'dispatchEvent');
});
function eventCount(type: string) {
  return new Set(
    vi
      .mocked(document.dispatchEvent)
      .mock.calls.filter(([event]) => event.type === type)
      .map(([event]) => event)
  ).size;
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('loads on activation, preserves a loaded instance on queue 1 to 2, and unmounts on close', async () => {
  const { state, requests, load, result } = setup();
  expect(load).toHaveBeenCalledTimes(0);
  state.items.push(1);
  flushSync();
  requests[0].resolve({ default: Child });
  await settle();
  const child = result.getByTestId('lazy-child');
  state.items.push(2);
  flushSync();
  expect(load).toHaveBeenCalledTimes(2);
  expect(result.getByTestId('lazy-child')).toBe(child);
  requests[1].resolve({ default: Child });
  await settle();
  expect(result.getByTestId('lazy-child')).toBe(child);
  state.items = [];
  flushSync();
  await settle();
  expect(result.getByTestId('owner').getAttribute('data-loaded')).toBe('false');
  expect(eventCount('lazy-mount')).toBe(1);
  expect(eventCount('lazy-unmount')).toBe(1);
});

it.each([false, true])(
  'accepts only the reopened request, stale resolves first=%s',
  async (staleFirst) => {
    const { state, requests, result } = setup();
    state.items = [1];
    flushSync();
    state.items = [];
    flushSync();
    state.items = [2];
    flushSync();
    requests[staleFirst ? 0 : 1].resolve({ default: Child });
    await settle();
    expect(!!result.queryByTestId('lazy-child')).toBe(!staleFirst);
    requests[staleFirst ? 1 : 0].resolve({ default: Child });
    await settle();
    expect(result.getAllByTestId('lazy-child')).toHaveLength(1);
  }
);

it('invalidates pending queue 1 to 2 without a boolean transition', async () => {
  const { state, requests, load, result } = setup();
  state.items = [1];
  flushSync();
  state.items.push(2);
  flushSync();
  expect(load).toHaveBeenCalledTimes(2);
  requests[0].resolve({ default: Child });
  await settle();
  expect(result.queryByTestId('lazy-child')).toBeNull();
  requests[1].resolve({ default: Child });
  await settle();
  expect(result.getByTestId('lazy-child')).toBeTruthy();
});

it('retains the toast host only after an active load succeeds', async () => {
  const { state, requests, result, load } = setup(true);
  state.items = [1];
  flushSync();
  state.items = [];
  flushSync();
  requests[0].resolve({ default: Child });
  await settle();
  expect(result.queryByTestId('lazy-child')).toBeNull();
  state.items = [2];
  flushSync();
  requests[1].resolve({ default: Child });
  await settle();
  const child = result.getByTestId('lazy-child');
  state.items = [];
  flushSync();
  expect(result.getByTestId('lazy-child')).toBe(child);
  state.items = [3];
  flushSync();
  requests[2].resolve({ default: Child });
  await settle();
  expect(result.getByTestId('lazy-child')).toBe(child);
  expect(load).toHaveBeenCalledTimes(3);
  expect(eventCount('lazy-mount')).toBe(1);
  expect(eventCount('lazy-unmount')).toBe(0);
});

it('reports only current failures, keeps loaded instances and waits for a dependency change to retry', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { state, requests, result, load } = setup();
  state.items = [1];
  flushSync();
  requests[0].reject('current');
  await settle();
  expect(error).toHaveBeenCalledTimes(1);
  expect(result.queryByTestId('lazy-child')).toBeNull();
  expect(load).toHaveBeenCalledTimes(1);
  state.items.push(2);
  flushSync();
  requests[1].resolve({ default: Child });
  await settle();
  const child = result.getByTestId('lazy-child');
  state.items.push(3);
  flushSync();
  requests[2].reject('reload');
  await settle();
  expect(result.getByTestId('lazy-child')).toBe(child);
  expect(error).toHaveBeenCalledTimes(2);
  state.items.push(4);
  flushSync();
  state.items = [];
  flushSync();
  requests[3].reject('closed');
  await settle();
  expect(error).toHaveBeenCalledTimes(2);
});

it('tracks share A to B, preserves identity, and closes invite when switching to access', async () => {
  const state = $state({ collectionId: null as string | null, view: 'invite' });
  const requests: ((module: { default: typeof Child }) => void)[] = [];
  const load = vi.fn(
    () =>
      new Promise<{ default: typeof Child }>((resolve) =>
        requests.push(resolve)
      )
  );
  const result = render(Owner, {
    load,
    when: () => state.collectionId !== null && state.view === 'invite'
  });
  flushSync();
  state.collectionId = 'A';
  flushSync();
  state.collectionId = 'B';
  flushSync();
  requests[0]({ default: Child });
  await settle();
  expect(result.queryByTestId('lazy-child')).toBeNull();
  requests[1]({ default: Child });
  await settle();
  const child = result.getByTestId('lazy-child');
  state.collectionId = 'C';
  flushSync();
  expect(result.getByTestId('lazy-child')).toBe(child);
  state.view = 'access';
  flushSync();
  requests[2]({ default: Child });
  await settle();
  expect(result.getByTestId('owner').getAttribute('data-loaded')).toBe('false');
  expect(eventCount('lazy-unmount')).toBe(1);
  expect(load).toHaveBeenCalledTimes(3);
});

it('owns requests separately and ignores fulfillment and rejection after destruction', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const first = setup();
  const second = setup();
  first.state.items = [1];
  second.state.items = [1];
  flushSync();
  first.state.items.push(2);
  flushSync();
  first.result.unmount();
  first.requests[0].resolve({ default: Child });
  first.requests[1].reject('destroyed');
  second.requests[0].resolve({ default: Child });
  await settle();
  expect(second.result.getAllByTestId('lazy-child')).toHaveLength(1);
  expect(error).not.toHaveBeenCalled();
});
