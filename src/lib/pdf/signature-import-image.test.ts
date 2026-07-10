import { afterEach, describe, expect, it, vi } from 'vitest';
import { openCameraStream } from './signature-import-image';

describe('openCameraStream', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to any camera when the environment camera is unavailable', async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new Error('no rear camera'))
      .mockResolvedValueOnce(stream);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });

    await expect(openCameraStream()).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      video: { facingMode: 'environment' },
      audio: false
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      video: true,
      audio: false
    });
  });

  it('keeps the original camera error when both attempts fail', async () => {
    const original = new Error('permission denied');
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(original)
      .mockRejectedValueOnce(new Error('generic failed'));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });

    await expect(openCameraStream()).rejects.toBe(original);
  });
});
