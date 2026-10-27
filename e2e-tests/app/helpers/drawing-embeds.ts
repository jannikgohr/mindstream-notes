/**
 * Adding and reading web embeds in an open drawing canvas.
 *
 * Pasting a URL onto the canvas is how a user adds an embed. WebKitWebDriver
 * has no native input, so the paste and the pointer position Excalidraw
 * reads for it are dispatched as DOM events, built the way Excalidraw's own
 * `createPasteEvent` builds one.
 */

export interface EmbedView {
  kind: 'iframe' | 'placeholder';
  src: string | null;
  text: string;
}

/** Wait for the open note's drawing canvas. */
export async function waitForCanvas(
  client: WebdriverIO.Browser
): Promise<void> {
  await client
    .$('.freeform-canvas-host .excalidraw')
    .waitForDisplayed({ timeout: 30_000 });
}

/** Paste one URL per line onto the canvas, as Ctrl+V over it would. */
export async function pasteOnCanvas(
  client: WebdriverIO.Browser,
  lines: string[]
): Promise<void> {
  await client.execute((text: string) => {
    const host = document.querySelector('.freeform-canvas-host');
    const container = host?.querySelector<HTMLElement>('.excalidraw');
    if (!host || !container) throw new Error('drawing canvas not found');
    const rect = host.getBoundingClientRect();
    // Left of centre and high up, clear of Excalidraw's own panels, so the
    // canvas is what lies under the pointer when the paste lands.
    const clientX = rect.left + rect.width * 0.3;
    const clientY = rect.top + rect.height * 0.3;
    document.dispatchEvent(
      new PointerEvent('pointermove', { clientX, clientY, bubbles: true })
    );
    container.focus();
    const paste = new ClipboardEvent('paste', {
      clipboardData: new DataTransfer(),
      bubbles: true,
      cancelable: true
    });
    paste.clipboardData?.setData('text/plain', text);
    document.dispatchEvent(paste);
  }, lines.join('\n'));
}

/**
 * Shift+1, zoom to fit. Pasted embeds come out 560×840 and side by side, and
 * Excalidraw only mounts the ones in view.
 */
export async function zoomToFit(client: WebdriverIO.Browser): Promise<void> {
  await client.execute(() => {
    document
      .querySelector<HTMLElement>('.freeform-canvas-host .excalidraw')
      ?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '!',
          code: 'Digit1',
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      );
  });
}

/** The embeds on the canvas, in scene order. */
export function embeds(client: WebdriverIO.Browser): Promise<EmbedView[]> {
  return client.execute(() =>
    Array.from(
      document.querySelectorAll('.excalidraw__embeddable-container')
    ).map((container) => {
      const iframe = container.querySelector('iframe');
      return {
        kind: iframe ? ('iframe' as const) : ('placeholder' as const),
        src: iframe?.getAttribute('src') ?? null,
        text: (container.textContent ?? '').replace(/\s+/g, ' ').trim()
      };
    })
  );
}

export async function waitForEmbeds(
  client: WebdriverIO.Browser,
  count: number
): Promise<EmbedView[]> {
  await zoomToFit(client);
  await client.waitUntil(async () => (await embeds(client)).length === count, {
    timeout: 30_000,
    timeoutMsg: `the drawing did not show ${count} embeds`
  });
  return embeds(client);
}
