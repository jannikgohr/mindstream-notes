import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { computePosition } from '@floating-ui/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UserMentionMenu from './UserMentionMenu.svelte';
import { createUserMentionBridge } from '$lib/editor/plugins/user-mention-bridge.svelte';

// computePosition calls stay pending until a test lands them, so each test
// picks the order in which repositions finish.
const pending = vi.hoisted(() => [] as Array<() => void>);
vi.mock('@floating-ui/dom', () => ({
  computePosition: vi.fn(
    () => new Promise((resolve) => pending.push(() => resolve({ x: 0, y: 0 })))
  ),
  flip: vi.fn(),
  offset: vi.fn(),
  shift: vi.fn(),
  size: vi.fn()
}));
vi.mock('$lib/settings/i18n.svelte', () => ({ tUi: (key: string) => key }));

const caret = { top: 1, left: 1, right: 2, bottom: 2, width: 1, height: 1 };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const menu = () => document.querySelector('.user-mention-menu');

function createBridge() {
  const bridge = createUserMentionBridge();
  bridge.state.users = [{ username: 'ada', accessLevel: null, isSelf: true }];
  return bridge;
}

beforeEach(() => {
  pending.length = 0;
  vi.mocked(computePosition).mockClear();
});

afterEach(() => {
  cleanup();
});

describe('typeahead popup positioning', () => {
  it('stays hidden when an older reposition lands after a reopen', async () => {
    const bridge = createBridge();
    render(UserMentionMenu, { bridge });

    bridge.state.caretRect = caret;
    bridge.state.open = true;
    await tick();
    bridge.state.open = false;
    await tick();
    bridge.state.caretRect = { ...caret, top: 3 };
    bridge.state.open = true;
    await tick();
    expect(pending).toHaveLength(2);

    pending[0]();
    await settle();
    expect(menu()?.classList.contains('invisible')).toBe(true);

    pending[1]();
    await settle();
    expect(menu()?.classList.contains('invisible')).toBe(false);
  });

  it('repositions on resize only while open, and not after teardown', async () => {
    const bridge = createBridge();
    const { unmount } = render(UserMentionMenu, { bridge });

    bridge.state.caretRect = caret;
    bridge.state.open = true;
    await tick();
    window.dispatchEvent(new Event('resize'));
    expect(computePosition).toHaveBeenCalledTimes(2);

    bridge.state.open = false;
    await tick();
    window.dispatchEvent(new Event('resize'));
    expect(computePosition).toHaveBeenCalledTimes(2);

    bridge.state.open = true;
    await tick();
    unmount();
    expect(menu()).toBeNull();
    window.dispatchEvent(new Event('resize'));
    expect(computePosition).toHaveBeenCalledTimes(3);
  });
});
