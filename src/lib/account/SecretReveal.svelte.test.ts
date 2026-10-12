/**
 * The component's one job is to keep the user from moving on before they
 * have said the key is stored, because nothing can show it a second time.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SecretReveal from './SecretReveal.svelte';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(lines: string[], onDone = vi.fn()) {
  render(SecretReveal, {
    title: 'Your recovery key',
    explanation: 'Keep it.',
    lines,
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
});
