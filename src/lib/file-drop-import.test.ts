import { beforeEach, describe, expect, it, vi } from 'vitest';

const importPdfIn =
  vi.fn<(parent: string | null, file: File) => Promise<string>>();
const pushToast = vi.fn();

vi.mock('$lib/stores/tree.svelte', () => ({
  importPdfIn: (parent: string | null, file: File) => importPdfIn(parent, file)
}));
vi.mock('$lib/components/toast.svelte', () => ({
  pushToast: (...args: unknown[]) => pushToast(...args)
}));

import { importDroppedPdfs } from './file-drop-import';

const pdf = (name: string) =>
  new File(['pdf'], name, { type: 'application/pdf' });

describe('importDroppedPdfs', () => {
  beforeEach(() => {
    importPdfIn.mockReset();
    pushToast.mockReset();
  });

  it('imports every file into the folder and opens the last one', async () => {
    importPdfIn.mockResolvedValueOnce('n1').mockResolvedValueOnce('n2');
    const open = vi.fn();
    const [a, b] = [pdf('a.pdf'), pdf('b.pdf')];

    await importDroppedPdfs([a, b], 'folder-1', open);

    expect(importPdfIn.mock.calls).toEqual([
      ['folder-1', a],
      ['folder-1', b]
    ]);
    expect(open.mock.calls).toEqual([['n2']]);
    expect(pushToast).not.toHaveBeenCalled();
  });

  it('reports a failure but still opens what imported before it', async () => {
    importPdfIn
      .mockResolvedValueOnce('n1')
      .mockRejectedValueOnce(new Error('disk full'));
    const open = vi.fn();

    await importDroppedPdfs([pdf('a.pdf'), pdf('b.pdf')], null, open);

    expect(open.mock.calls).toEqual([['n1']]);
    expect(pushToast).toHaveBeenCalledTimes(1);
    expect(pushToast.mock.calls[0][0]).toContain('disk full');
    expect(pushToast.mock.calls[0][1]).toEqual({ variant: 'error' });
  });

  it('opens nothing when the first import fails', async () => {
    importPdfIn.mockRejectedValueOnce(new Error('nope'));
    const open = vi.fn();

    await importDroppedPdfs([pdf('a.pdf')], null, open);

    expect(open).not.toHaveBeenCalled();
    expect(pushToast).toHaveBeenCalledTimes(1);
  });
});
