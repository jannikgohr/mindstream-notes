/**
 * T3 — handwriting recognition: an ink note, the vision server the user
 * configured, and search.
 *
 * Unit tests cover the request against a loopback socket and the per-page
 * bookkeeping against a document. Only the packaged app shows the pieces
 * meeting: strokes drawn on the canvas reach the server as an image, and what
 * it reads back becomes searchable without the note being edited again.
 *
 * The server is a stub that answers in the OpenAI chat-completions shape and
 * records what it received.
 *
 * Run: pnpm test:e2e:app --spec e2e-tests/app/specs/single/handwriting.e2e.ts
 */

import { expect } from '@wdio/globals';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  clickName,
  clientHelpers,
  closeSettings,
  setSettingText,
  waitForShell
} from '../../helpers/harness.js';
import { invokeTauri } from '../../helpers/tauri.js';

const MODEL = 'stub-vision';
const RECOGNIZED = 'Einkaufsliste Milch Brot';

/** Three pen strokes in page-relative units, enough to make a page "written on". */
const STROKES = [
  [
    [0.1, 0.1],
    [0.2, 0.15],
    [0.3, 0.1]
  ],
  [
    [0.35, 0.1],
    [0.35, 0.2]
  ],
  [
    [0.4, 0.2],
    [0.5, 0.1],
    [0.6, 0.2]
  ]
];

interface Received {
  path: string;
  authorization: string | undefined;
  body: {
    model?: string;
    messages?: Array<{ content?: Array<{ image_url?: { url?: string } }> }>;
  };
}

let server: Server;
let endpoint = '';
const received: Received[] = [];

function startStub(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({
          path: request.url ?? '',
          authorization: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        });
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: RECOGNIZED } }]
          })
        );
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      endpoint = `http://127.0.0.1:${port}/v1`;
      resolve();
    });
  });
}

/**
 * Draw strokes as a pen would. WebKitWebDriver has no native input, so the
 * pointer events are dispatched; pointer capture is stubbed because a
 * synthetic pointer id is not one WebKit will capture.
 */
async function drawStrokes(strokes: number[][][]): Promise<void> {
  await browser.execute((lines: number[][][]) => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      'canvas[aria-label="Handwritten note canvas"]'
    );
    if (!canvas) throw new Error('ink canvas not found');
    canvas.setPointerCapture = () => {};
    const rect = canvas.getBoundingClientRect();
    const size = rect.width * 0.6;
    const at = (point: number[]) => ({
      clientX: rect.left + rect.width * 0.2 + point[0] * size,
      clientY: rect.top + rect.height * 0.15 + point[1] * size
    });
    const fire = (type: string, point: number[], buttons: number) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          ...at(point),
          pointerId: 7,
          pointerType: 'pen',
          isPrimary: true,
          pressure: buttons ? 0.6 : 0,
          button: type === 'pointermove' ? -1 : 0,
          buttons,
          bubbles: true,
          cancelable: true
        })
      );
    for (const line of lines) {
      fire('pointerdown', line[0], 1);
      for (const point of line.slice(1)) fire('pointermove', point, 1);
      fire('pointerup', line[line.length - 1], 0);
    }
  }, strokes);
}

async function searchHits(query: string): Promise<string[]> {
  const hits = await invokeTauri<Array<{ note: { title: string } }>>(
    browser,
    'search_notes',
    { query }
  );
  return hits.map((hit) => hit.note.title);
}

describe('T3 handwriting recognition', function () {
  before(async () => {
    await startStub();
    await waitForShell();
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('makes what the server read searchable', async () => {
    await clickName('Open settings');
    await clickName('Editor');
    await setSettingText('Server URL', endpoint);
    await setSettingText('Model', MODEL);
    await setSettingText('API key', 'e2e-key');
    await closeSettings();

    const title = `Handwriting ${Date.now()}`;
    await clientHelpers(browser).newRootInk(title);
    await $('canvas[aria-label="Handwritten note canvas"]').waitForDisplayed({
      timeout: 30_000
    });
    await drawStrokes(STROKES);

    await browser.waitUntil(async () => received.length > 0, {
      timeout: 60_000,
      timeoutMsg: 'the app never sent the page to the server'
    });
    const request = received[0];
    expect(request.path).toBe('/v1/chat/completions');
    expect(request.authorization).toBe('Bearer e2e-key');
    expect(request.body.model).toBe(MODEL);
    expect(
      request.body.messages?.[0]?.content?.[1]?.image_url?.url?.startsWith(
        'data:image/png;base64,'
      )
    ).toBe(true);

    await browser.waitUntil(
      async () => (await searchHits('Einkaufsliste')).includes(title),
      {
        timeout: 30_000,
        timeoutMsg: 'the recognized text never reached search'
      }
    );
  });
});
