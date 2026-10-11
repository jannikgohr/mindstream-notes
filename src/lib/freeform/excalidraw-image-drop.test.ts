import { describe, expect, it } from 'vitest';
import {
  prepareDroppedImage,
  stripExcalidrawSceneMetadata
} from './excalidraw-image-drop';

const EXCALIDRAW_MIME = 'application/vnd.excalidraw+json';

function pngChunk(name: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(12 + data.length));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index += 1) {
    bytes[4 + index] = name.charCodeAt(index);
  }
  bytes.set(data, 8);
  return bytes;
}

function pngWithText(keyword: string): File {
  const encoder = new TextEncoder();
  const text = encoder.encode(`${keyword}\0payload`);
  return new File(
    [
      Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk('tEXt', text),
      pngChunk('IEND', new Uint8Array())
    ],
    'drawing.png',
    { type: 'image/png', lastModified: 123 }
  );
}

describe('Excalidraw image drops', () => {
  it('gives a MIME-less image the type its extension names', async () => {
    // Excalidraw can't sniff these from the bytes and would refuse them.
    const svg = await prepareDroppedImage(
      new File(['<svg xmlns="http://www.w3.org/2000/svg" />'], 'diagram.SVG')
    );
    expect(svg.type).toBe('image/svg+xml');
    expect(svg.name).toBe('diagram.SVG');
    expect(
      (await prepareDroppedImage(new File(['webp'], 'photo.webp'))).type
    ).toBe('image/webp');

    const typed = new File(['jpg'], 'photo.jpg', { type: 'image/jpeg' });
    expect(await prepareDroppedImage(typed)).toBe(typed);
  });

  it('strips the scene from an export whose type the desktop left blank', async () => {
    const scene = pngWithText(EXCALIDRAW_MIME);
    const untyped = new File([scene], 'drawing.excalidraw.png');
    const ready = await prepareDroppedImage(untyped);
    expect(ready.type).toBe('image/png');
    expect(ready.size).toBeLessThan(untyped.size);
    expect(await stripExcalidrawSceneMetadata(ready)).toBe(ready);
  });

  it('removes the Excalidraw PNG text chunk without changing other chunks', async () => {
    const scene = pngWithText(EXCALIDRAW_MIME);
    const safe = await stripExcalidrawSceneMetadata(scene);
    expect(safe).not.toBe(scene);
    expect(safe.type).toBe('image/png');
    expect(safe.lastModified).toBe(123);
    expect(new Uint8Array(await safe.arrayBuffer())).toEqual(
      new Uint8Array([
        137,
        80,
        78,
        71,
        13,
        10,
        26,
        10,
        ...pngChunk('IEND', new Uint8Array())
      ])
    );

    const ordinary = pngWithText('Comment');
    expect(await stripExcalidrawSceneMetadata(ordinary)).toBe(ordinary);
  });

  it('removes only the SVG metadata block that carries a scene', async () => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg">
      <metadata>keep me</metadata>
      <metadata><!-- payload-type:${EXCALIDRAW_MIME} --><!-- payload-start -->scene<!-- payload-end --></metadata>
      <rect width="10" height="10" />
    </svg>`;
    const file = new File([source], 'drawing.svg', {
      type: 'image/svg+xml'
    });
    const safe = await stripExcalidrawSceneMetadata(file);
    const clean = await safe.text();
    expect(clean).toContain('<metadata>keep me</metadata>');
    expect(clean).toContain('<metadata></metadata>');
    expect(clean).not.toContain(`payload-type:${EXCALIDRAW_MIME}`);
    expect(clean).toContain('<rect width="10" height="10" />');
  });
});
