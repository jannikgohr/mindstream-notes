/**
 * The component's one job is to keep the user from moving on before they
 * have said the key is stored, because nothing can show it a second time.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretFile } from '$lib/api/account';

const { accountSaveSecretFile, isTauri, isMobile } = vi.hoisted(() => ({
  accountSaveSecretFile: vi.fn(),
  isTauri: vi.fn(() => true),
  isMobile: vi.fn(() => false)
}));

vi.mock('$lib/api/account', () => ({ accountSaveSecretFile }));
vi.mock('$lib/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/api/core')>()),
  isTauri
}));
vi.mock('$lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/platform')>()),
  isMobile
}));

import SecretReveal from './SecretReveal.svelte';

const FILE: SecretFile = {
  title: 'Save your recovery key',
  kind: 'Text file',
  suggestedName: 'mindstream-recovery-key-ann.txt',
  contents: ['Mindstream Notes recovery key', '', 'AAAA-BBBB', ''].join('\n')
};

beforeEach(() => {
  accountSaveSecretFile.mockReset();
  isTauri.mockReturnValue(true);
  isMobile.mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(lines: string[], onDone = vi.fn(), file?: SecretFile) {
  render(SecretReveal, {
    title: 'Your recovery key',
    explanation: 'Keep it.',
    lines,
    file,
    onDone
  });
  return onDone;
}

describe('SecretReveal', () => {
  it('shows every line it was given', () => {
    show(['AAAA-BBBB', 'CCCC-DDDD']);
    expect(screen.getByText('AAAA-BBBB')).toBeTruthy();
    expect(screen.getByText('CCCC-DDDD')).toBeTruthy();
  });

  it('lets the user on only once they say it is stored', async () => {
    const onDone = show(['AAAA-BBBB']);
    const done = screen.getByTestId('secret-reveal-done') as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    await fireEvent.click(done);
    expect(onDone).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByTestId('secret-reveal-stored'));
    expect(done.disabled).toBe(false);
    await fireEvent.click(done);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('copies all lines, one per line', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    show(['AAAA-BBBB', 'CCCC-DDDD']);

    await fireEvent.click(screen.getByText('Copy'));
    expect(writeText).toHaveBeenCalledWith('AAAA-BBBB\nCCCC-DDDD');
    expect(await screen.findByText('Copied')).toBeTruthy();
  });

  it('survives a clipboard that refuses', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    show(['AAAA-BBBB']);

    await fireEvent.click(screen.getByText('Copy'));
    // Still there to be copied by hand.
    expect(screen.getByText('AAAA-BBBB')).toBeTruthy();
    expect(screen.queryByText('Copied')).toBeNull();
  });

  describe('keeping it in a file', () => {
    it('offers no file where none was prepared', () => {
      show(['AAAA-BBBB']);
      expect(screen.queryByTestId('secret-reveal-save')).toBeNull();
    });

    it('offers none on a phone or outside the app', () => {
      isMobile.mockReturnValue(true);
      show(['AAAA-BBBB'], vi.fn(), FILE);
      expect(screen.queryByTestId('secret-reveal-save')).toBeNull();
      cleanup();

      isMobile.mockReturnValue(false);
      isTauri.mockReturnValue(false);
      show(['AAAA-BBBB'], vi.fn(), FILE);
      expect(screen.queryByTestId('secret-reveal-save')).toBeNull();
    });

    it('hands the prepared file over and says when it is saved', async () => {
      accountSaveSecretFile.mockResolvedValueOnce(true);
      show(['AAAA-BBBB'], vi.fn(), FILE);

      await fireEvent.click(screen.getByText('Save as a file'));
      expect(accountSaveSecretFile).toHaveBeenCalledWith(FILE);
      expect(await screen.findByText('Saved')).toBeTruthy();
    });

    it('says nothing when the user closes the dialog without choosing', async () => {
      accountSaveSecretFile.mockResolvedValueOnce(false);
      show(['AAAA-BBBB'], vi.fn(), FILE);

      await fireEvent.click(screen.getByText('Save as a file'));
      await Promise.resolve();
      expect(screen.queryByText('Saved')).toBeNull();
      expect(screen.queryByTestId('secret-reveal-save-failed')).toBeNull();
    });

    it('says so when the file could not be written, and leaves the way on closed', async () => {
      accountSaveSecretFile.mockRejectedValueOnce(new Error('disk full'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      show(['AAAA-BBBB'], vi.fn(), FILE);

      await fireEvent.click(screen.getByText('Save as a file'));
      expect(await screen.findByText("Couldn't save the file.")).toBeTruthy();
      // Saving is not the same as saying it is stored. That stays a choice.
      const done = screen.getByTestId(
        'secret-reveal-done'
      ) as HTMLButtonElement;
      expect(done.disabled).toBe(true);
    });
  });
});
