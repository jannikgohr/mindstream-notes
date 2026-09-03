import { describe, expect, it, vi, afterEach } from 'vitest';
import { onAppSuspend } from './suspend-flush';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => setVisibility('visible'));

describe('onAppSuspend', () => {
  it('flushes when the document becomes hidden', () => {
    const flush = vi.fn();
    const stop = onAppSuspend(flush);
    setVisibility('hidden');
    expect(flush).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not flush when the document becomes visible again', () => {
    const flush = vi.fn();
    const stop = onAppSuspend(flush);
    setVisibility('visible');
    expect(flush).not.toHaveBeenCalled();
    stop();
  });

  it('flushes on pagehide', () => {
    const flush = vi.fn();
    const stop = onAppSuspend(flush);
    window.dispatchEvent(new Event('pagehide'));
    expect(flush).toHaveBeenCalledTimes(1);
    stop();
  });

  it('stops listening once the returned disposer runs', () => {
    const flush = vi.fn();
    onAppSuspend(flush)();
    setVisibility('hidden');
    window.dispatchEvent(new Event('pagehide'));
    expect(flush).not.toHaveBeenCalled();
  });

  it('tolerates both events firing for one suspend', () => {
    const flush = vi.fn();
    const stop = onAppSuspend(flush);
    setVisibility('hidden');
    window.dispatchEvent(new Event('pagehide'));
    expect(flush).toHaveBeenCalledTimes(2);
    stop();
  });
});
