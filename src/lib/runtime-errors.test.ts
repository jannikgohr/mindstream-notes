import { afterEach, describe, expect, it, vi } from 'vitest';
const { invoke, isTauri } = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn()
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('$lib/api/core', () => ({ isTauri }));
import {
  installRuntimeErrorReporting,
  reportRuntimeError
} from './runtime-errors';

afterEach(() => vi.restoreAllMocks());
describe('runtime error reporting', () => {
  it('reports rejected promises and removes listeners on cleanup', () => {
    isTauri.mockReturnValue(false);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cleanup = installRuntimeErrorReporting();
    const event = new Event('unhandledrejection');
    Object.defineProperty(event, 'reason', { value: new Error('save failed') });
    window.dispatchEvent(event);
    expect(log).toHaveBeenCalledWith('[client] unhandled error', 'save failed');
    cleanup();
    log.mockClear();
    window.dispatchEvent(event);
    expect(log).not.toHaveBeenCalled();
  });
  it('bounds native log entries and handles reporting failures', async () => {
    isTauri.mockReturnValue(true);
    invoke.mockRejectedValue(new Error('logger unavailable'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportRuntimeError('x'.repeat(5000));
    expect(invoke).toHaveBeenCalledWith('report_client_error', {
      message: 'x'.repeat(4096)
    });
    await Promise.resolve();
    expect(log).toHaveBeenCalledWith(
      '[client] error reporting failed',
      expect.any(Error)
    );
  });
});
