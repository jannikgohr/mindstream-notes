import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FILE_DROP_ACCEPT_ATTR,
  FILE_DROP_SINGLE_ATTR,
  IMAGE_ACCEPT,
  PDF_ACCEPT,
  droppedPdfFiles,
  fileDropZoneFor,
  fileMatchesAccept,
  installFileDropRouter,
  isFileDrag,
  routeFileDrop,
  type FileDropZone
} from './file-drop';

function dragEvent(files: File[], types: string[] = ['Files']): DragEvent {
  return {
    dataTransfer: { files, types }
  } as unknown as DragEvent;
}

const png = () => new File(['png'], 'photo.png', { type: 'image/png' });
const pdf = () => new File(['pdf'], 'scan.pdf', { type: 'application/pdf' });
const txt = () => new File(['text'], 'notes.txt', { type: 'text/plain' });

const imageZone: FileDropZone = { accept: ['image/*'], single: false };
const singleImageZone: FileDropZone = { accept: ['image/png'], single: true };
const pdfZone: FileDropZone = {
  accept: ['application/pdf', '.pdf'],
  single: false
};

describe('file drop helpers', () => {
  it('recognises external file drags before the files are readable', () => {
    expect(isFileDrag(dragEvent([], ['Files']))).toBe(true);
    expect(isFileDrag(dragEvent([], ['text/plain']))).toBe(false);
  });

  it('accepts PDFs by MIME type or extension', () => {
    const typed = new File(['pdf'], 'document.bin', {
      type: 'application/pdf'
    });
    const named = new File(['pdf'], 'scan.PDF');
    const text = new File(['text'], 'notes.txt', { type: 'text/plain' });
    expect(droppedPdfFiles(dragEvent([typed, named, text]))).toEqual([
      typed,
      named
    ]);
  });

  it('matches accept tokens the way <input accept> does', () => {
    expect(fileMatchesAccept(png(), ['image/*'])).toBe(true);
    expect(fileMatchesAccept(png(), ['image/png'])).toBe(true);
    expect(fileMatchesAccept(png(), ['image/jpeg'])).toBe(false);
    expect(fileMatchesAccept(pdf(), ['image/*'])).toBe(false);
    // Extension match covers platforms that hand over no MIME type.
    expect(fileMatchesAccept(new File(['pdf'], 'Scan.PDF'), ['.pdf'])).toBe(
      true
    );
    expect(fileMatchesAccept(txt(), [])).toBe(false);
  });
});

describe('fileDropZoneFor', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function mount(html: string): HTMLElement {
    document.body.innerHTML = html;
    return document.body;
  }

  it('finds the innermost zone around the target', () => {
    const root = mount(
      `<div ${FILE_DROP_ACCEPT_ATTR}="${PDF_ACCEPT}">
         <div ${FILE_DROP_ACCEPT_ATTR}="${IMAGE_ACCEPT}" ${FILE_DROP_SINGLE_ATTR}>
           <p id="inner">text</p>
         </div>
         <p id="outer">text</p>
       </div>
       <p id="outside">text</p>`
    );
    expect(fileDropZoneFor(root.querySelector('#inner'))).toEqual({
      accept: ['image/*'],
      single: true
    });
    expect(fileDropZoneFor(root.querySelector('#outer'))).toEqual({
      accept: ['application/pdf', '.pdf'],
      single: false
    });
    expect(fileDropZoneFor(root.querySelector('#outside'))).toBeNull();
    expect(fileDropZoneFor(null)).toBeNull();
  });

  it('resolves a text-node target through its parent', () => {
    const root = mount(
      `<div ${FILE_DROP_ACCEPT_ATTR}="${IMAGE_ACCEPT}"><p id="p">text</p></div>`
    );
    const text = root.querySelector('#p')!.firstChild;
    expect(fileDropZoneFor(text)?.accept).toEqual(['image/*']);
  });

  it('treats an empty accept list as no zone', () => {
    const root = mount(`<div ${FILE_DROP_ACCEPT_ATTR}=""><p id="p"></p></div>`);
    expect(fileDropZoneFor(root.querySelector('#p'))).toBeNull();
  });
});

describe('routeFileDrop', () => {
  it('imports PDFs and reports the rest when no zone is under the pointer', () => {
    const [a, b] = [pdf(), txt()];
    expect(routeFileDrop([a, b], null)).toEqual({
      zoneClaims: false,
      pdfs: [a],
      unusable: [b]
    });
  });

  it('leaves a drop to the zone that accepts it', () => {
    expect(routeFileDrop([png()], imageZone)).toEqual({
      zoneClaims: true,
      pdfs: [],
      unusable: []
    });
  });

  it('still imports the PDFs dropped alongside what the zone takes', () => {
    const [image, doc] = [png(), pdf()];
    expect(routeFileDrop([image, doc], imageZone)).toEqual({
      zoneClaims: true,
      pdfs: [doc],
      unusable: []
    });
  });

  it('keeps a PDF away from an editor that only takes images', () => {
    const doc = pdf();
    expect(routeFileDrop([doc], imageZone)).toEqual({
      zoneClaims: false,
      pdfs: [doc],
      unusable: []
    });
  });

  it('judges a single-file zone by the first file alone', () => {
    const [image, doc] = [png(), pdf()];
    expect(routeFileDrop([image, doc], singleImageZone).zoneClaims).toBe(true);
    // The zone would read the PDF and choke on it, so it gets nothing.
    expect(routeFileDrop([doc, image], singleImageZone)).toEqual({
      zoneClaims: false,
      pdfs: [doc],
      unusable: [image]
    });
  });

  it('does not import PDFs a zone already claimed', () => {
    const [doc, image] = [pdf(), png()];
    expect(routeFileDrop([doc, image], pdfZone)).toEqual({
      zoneClaims: true,
      pdfs: [],
      unusable: [image]
    });
  });
});

describe('installFileDropRouter', () => {
  let teardown: (() => void) | null = null;

  afterEach(() => {
    teardown?.();
    teardown = null;
    document.body.innerHTML = '';
  });

  function setup() {
    document.body.innerHTML = `
      <div id="editor" ${FILE_DROP_ACCEPT_ATTR}="${IMAGE_ACCEPT}"></div>
      <div id="elsewhere"></div>`;
    const importPdfs = vi.fn();
    const onUnusable = vi.fn();
    teardown = installFileDropRouter(window, { importPdfs, onUnusable });
    const editor = document.querySelector<HTMLElement>('#editor')!;
    const elsewhere = document.querySelector<HTMLElement>('#elsewhere')!;
    return { importPdfs, onUnusable, editor, elsewhere };
  }

  /** Dispatch a drag event carrying `files` and report what reached `el`. */
  function fire(
    el: HTMLElement,
    type: 'dragover' | 'drop',
    files: File[],
    types: string[] = ['Files']
  ) {
    const reached = vi.fn();
    el.addEventListener(type, reached);
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { files, types, dropEffect: 'none' }
    });
    el.dispatchEvent(event);
    el.removeEventListener(type, reached);
    return { event, reached: reached.mock.calls.length > 0 };
  }

  it('hands an image to the editor it was dropped on', () => {
    const { importPdfs, onUnusable, editor } = setup();
    const { event, reached } = fire(editor, 'drop', [png()]);
    expect(reached).toBe(true);
    expect(importPdfs).not.toHaveBeenCalled();
    expect(onUnusable).not.toHaveBeenCalled();
    // Nothing in this test handled the drop, so the safety net cancels it.
    expect(event.defaultPrevented).toBe(true);
  });

  it('imports a PDF dropped on an editor without letting the editor see it', () => {
    const { importPdfs, onUnusable, editor } = setup();
    const doc = pdf();
    const { event, reached } = fire(editor, 'drop', [doc]);
    expect(reached).toBe(false);
    expect(importPdfs).toHaveBeenCalledWith([doc]);
    expect(onUnusable).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('imports the PDF from a mixed drop and still lets the editor have it', () => {
    const { importPdfs, editor } = setup();
    const doc = pdf();
    const { reached } = fire(editor, 'drop', [png(), doc]);
    expect(reached).toBe(true);
    expect(importPdfs).toHaveBeenCalledWith([doc]);
  });

  it('reports a drop nothing can use', () => {
    const { importPdfs, onUnusable, elsewhere } = setup();
    const file = txt();
    const { event, reached } = fire(elsewhere, 'drop', [file]);
    expect(reached).toBe(false);
    expect(importPdfs).not.toHaveBeenCalled();
    expect(onUnusable).toHaveBeenCalledWith([file]);
    expect(event.defaultPrevented).toBe(true);
  });

  it('cancels every file dragover but only lets zones see it', () => {
    const { editor, elsewhere } = setup();
    const inZone = fire(editor, 'dragover', []);
    expect(inZone.event.defaultPrevented).toBe(true);
    expect(inZone.reached).toBe(true);

    const outside = fire(elsewhere, 'dragover', []);
    expect(outside.event.defaultPrevented).toBe(true);
    expect(outside.reached).toBe(false);
  });

  it('ignores drags that carry no files', () => {
    const { importPdfs, onUnusable, elsewhere } = setup();
    for (const type of ['dragover', 'drop'] as const) {
      const { event, reached } = fire(elsewhere, type, [], ['text/plain']);
      expect(reached).toBe(true);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(importPdfs).not.toHaveBeenCalled();
    expect(onUnusable).not.toHaveBeenCalled();
  });

  it('stops routing once torn down', () => {
    const { importPdfs, elsewhere } = setup();
    teardown?.();
    teardown = null;
    const { event, reached } = fire(elsewhere, 'drop', [pdf()]);
    expect(reached).toBe(true);
    expect(importPdfs).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
