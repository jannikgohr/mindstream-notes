import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  initHotkeys,
  popActiveEditor,
  pushActiveEditor,
  type ActiveEditor
} from './manager.svelte';

let teardownHotkeys: (() => void) | null = null;
let activeEditor: ActiveEditor | null = null;

function forceWindowsModKey() {
  Object.defineProperty(navigator, 'platform', {
    value: 'Win32',
    configurable: true
  });
}

function registerMarkdownEditor(dispatch: ActiveEditor['dispatch']) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  activeEditor = { kind: 'markdown', host, dispatch };
  pushActiveEditor(activeEditor);
}

function press(init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init
  });
  document.dispatchEvent(event);
  return event;
}

afterEach(() => {
  if (activeEditor) {
    popActiveEditor(activeEditor);
    activeEditor.host.remove();
    activeEditor = null;
  }
  teardownHotkeys?.();
  teardownHotkeys = null;
});

describe('initHotkeys', () => {
  it('dispatches simple markdown modifier shortcuts', () => {
    forceWindowsModKey();
    const dispatch = vi.fn();
    registerMarkdownEditor(dispatch);
    teardownHotkeys = initHotkeys();

    const event = press({ key: 'b', code: 'KeyB', ctrlKey: true });

    expect(dispatch).toHaveBeenCalledWith('editor.markdown.bold');
    expect(event.defaultPrevented).toBe(true);
  });

  it('matches shifted number-row defaults when the layout emits a symbol', () => {
    forceWindowsModKey();
    const dispatch = vi.fn();
    registerMarkdownEditor(dispatch);
    teardownHotkeys = initHotkeys();

    const event = press({
      key: '(',
      code: 'Digit8',
      ctrlKey: true,
      shiftKey: true
    });

    expect(dispatch).toHaveBeenCalledWith('editor.markdown.bulletList');
    expect(event.defaultPrevented).toBe(true);
  });
});
