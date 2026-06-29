import { describe, expect, it, vi } from 'vitest';
import {
  requestOpenNote,
  subscribeOpenNoteRequest
} from './open-note-intent.svelte';

describe('open-note intent bus', () => {
  it('fans a request out to every subscriber and reports handled', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeOpenNoteRequest(a);
    const offB = subscribeOpenNoteRequest(b);

    expect(requestOpenNote('n1')).toBe(true);
    expect(a).toHaveBeenCalledWith('n1');
    expect(b).toHaveBeenCalledWith('n1');

    offA();
    offB();
  });

  it('stops calling a handler after it unsubscribes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = vi.fn();
    const off = subscribeOpenNoteRequest(handler);
    off();
    expect(requestOpenNote('n1')).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[open-note-intent] no subscriber; nothing handled request for',
      'n1'
    );
    warn.mockRestore();
  });

  it('returns false and warns when nothing is subscribed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(requestOpenNote('orphan')).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
