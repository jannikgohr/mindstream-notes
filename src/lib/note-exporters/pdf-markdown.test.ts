import { beforeEach, expect, it, vi } from 'vitest';
const source = vi.hoisted(() => ({
  destroy: vi.fn(),
  cleanup: vi.fn(),
  getDocument: vi.fn(),
  getPage: vi.fn(),
  getTextContent: vi.fn(),
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
  getDocument: source.getDocument
}));
import { annotationsMarkdown } from './pdf-markdown';
import type { PdfAnnotation } from '$lib/pdf/types';

beforeEach(() => {
  vi.resetAllMocks();
  source.getTextContent.mockResolvedValue({ items: source.text });
  source.getPage.mockResolvedValue({
    cleanup: source.cleanup,
    getTextContent: source.getTextContent
  });
  source.getDocument.mockImplementation(() => ({
    destroy: source.destroy,
    promise: Promise.resolve({ numPages: 2, getPage: source.getPage })
  }));
});

function annotation(over: Partial<PdfAnnotation>): PdfAnnotation {
  return {
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
  };
}

it('exports highlighted text and comments in page order, retaining resolved comments and excluding deleted entries', async () => {
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

it('escapes the title and reports when no active highlights or comments remain', async () => {
  const result = await annotationsMarkdown(
    'Reading *notes*\nNext #Heading',
    new Uint8Array([1]),
    [annotation({ type: 'ink' }), annotation({ deletedAt: 'now' })]
  );
  expect(result).toContain('# Reading \\*notes\\* Next \\#Heading');
  expect(result).toContain('No highlights or comments.');
  expect(source.getPage).not.toHaveBeenCalled();
  expect(source.destroy).toHaveBeenCalledOnce();
});

it('orders annotations on the same page by position and ID, skipping out-of-range pages', async () => {
  const result = await annotationsMarkdown('Reading', new Uint8Array([1]), [
    annotation({ type: 'comment', id: 'z', body: 'Third entry' }),
    annotation({ type: 'comment', id: 'a', body: 'Second entry' }),
    annotation({
      type: 'comment',
      id: 'top',
      rects: [{ x: 0, y: 300, width: 10, height: 10 }],
      body: 'First entry'
    }),
    annotation({ type: 'comment', id: 'empty', rects: [], body: 'Last entry' }),
    annotation({ pageIndex: -1, body: 'Before start' }),
    annotation({ pageIndex: 2, body: 'After end' })
  ]);
  const positions = [
    'First entry',
    'Second entry',
    'Third entry',
    'Last entry'
  ].map((text) => result.indexOf(text));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(result).not.toContain('Before start');
  expect(result).not.toContain('After end');
});

it('ignores blank and marked-content items when no text intersects a highlight', async () => {
  source.getTextContent.mockResolvedValue({
    items: [
      { type: 'beginMarkedContent' },
      { ...source.text[0], str: '  ' },
      source.text[1]
    ]
  });
  const result = await annotationsMarkdown('Reading', new Uint8Array([1]), [
    annotation({})
  ]);
  expect(result).toContain('### Highlight');
  expect(result).not.toContain('>');
  expect(source.cleanup).toHaveBeenCalledOnce();
});

it.each(['load', 'text'])(
  'destroys the PDF task after a %s failure',
  async (failure) => {
    const error = new Error('PDF unavailable');
    if (failure === 'load')
      source.getDocument.mockImplementationOnce(() => ({
        destroy: source.destroy,
        promise: Promise.reject(error)
      }));
    else source.getTextContent.mockRejectedValueOnce(error);
    await expect(
      annotationsMarkdown('Reading', new Uint8Array([1]), [annotation({})])
    ).rejects.toBe(error);
    expect(source.destroy).toHaveBeenCalledOnce();
  }
);
