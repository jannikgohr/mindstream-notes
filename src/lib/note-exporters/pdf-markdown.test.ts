import { expect, it, vi } from 'vitest';
const source = vi.hoisted(() => ({
  destroy: vi.fn(),
  cleanup: vi.fn(),
  text: [
    {
      str: 'Selected words',
      transform: [1, 0, 0, 12, 20, 80],
      width: 80,
      height: 12
    },
    {
      str: 'Unselected words',
      transform: [1, 0, 0, 12, 20, 40],
      width: 90,
      height: 12
    }
  ]
}));
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    destroy: source.destroy,
    promise: Promise.resolve({
      numPages: 2,
      getPage: async () => ({
        cleanup: source.cleanup,
        getTextContent: async () => ({ items: source.text })
      })
    })
  })
}));
import { annotationsMarkdown } from './pdf-markdown';
import type { PdfAnnotation } from '$lib/pdf/types';

it('exports highlighted text and comments in page order, retaining resolved comments and excluding deleted entries', async () => {
  const annotation = (over: Partial<PdfAnnotation>): PdfAnnotation => ({
    id: 'one',
    type: 'highlight',
    pageIndex: 0,
    rects: [{ x: 15, y: 78, width: 100, height: 16 }],
    color: '#ff0',
    opacity: 1,
    authorId: 'user',
    createdAt: '',
    updatedAt: '',
    ...over
  });
  const result = await annotationsMarkdown('Reading', new Uint8Array([1]), [
    annotation({
      id: 'two',
      type: 'comment',
      pageIndex: 1,
      body: 'A useful comment',
      resolved: true
    }),
    annotation({}),
    annotation({ id: 'deleted', body: 'Deleted text', deletedAt: 'now' })
  ]);
  expect(result).toContain('> Selected words');
  expect(result).not.toContain('Unselected words');
  expect(result).not.toContain('Deleted text');
  expect(result).toContain('Comment (resolved)');
  expect(result).toContain('A useful comment');
  expect(result.indexOf('## Page 1')).toBeLessThan(result.indexOf('## Page 2'));
  expect(source.destroy).toHaveBeenCalledOnce();
});
