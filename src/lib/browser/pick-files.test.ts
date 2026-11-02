import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickFiles } from './pick-files';

afterEach(() => vi.restoreAllMocks());

function choose(respond: (input: HTMLInputElement) => void) {
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
    this: HTMLInputElement
  ) {
    respond(this);
  });
}

describe('file picker', () => {
  it('resolves with the picked files and leaves nothing behind', async () => {
    const file = new File(['a'], 'a.md');
    let attached = false;
    choose((input) => {
      attached = input.isConnected;
      Object.defineProperty(input, 'files', { value: [file] });
      input.dispatchEvent(new Event('change'));
    });

    await expect(
      pickFiles((input) => {
        input.accept = '.md';
      })
    ).resolves.toEqual([file]);
    expect(attached).toBe(true);
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('applies the caller’s settings before opening', async () => {
    let accept = '';
    choose((input) => {
      accept = input.accept;
      input.dispatchEvent(new Event('cancel'));
    });
    await pickFiles((input) => {
      input.accept = '.zip';
    });
    expect(accept).toBe('.zip');
  });

  it('resolves with null when the picker is cancelled', async () => {
    choose((input) => input.dispatchEvent(new Event('cancel')));
    await expect(pickFiles(() => {})).resolves.toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});
