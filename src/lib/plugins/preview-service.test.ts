import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance
} from 'vitest';

const { previewStart, previewStop, previewUpdate } = vi.hoisted(() => ({
  previewStart: vi.fn(),
  previewStop: vi.fn(),
  previewUpdate: vi.fn()
}));

vi.mock('$lib/api/plugins', () => ({
  pluginsPreviewStart: previewStart,
  pluginsPreviewStop: previewStop,
  pluginsPreviewUpdate: previewUpdate
}));

import {
  PREVIEW_PROXY_READY,
  PreviewServiceController,
  previewProxyUrl,
  type PreviewServiceOptions
} from './preview-service';

// Minimal WebSocket stand-in: records the URL, exposes onmessage/onerror the
// controller assigns, and lets tests push frames in. happy-dom ships a real
// WebSocket that would try to open a socket, so we swap the global out.
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly close = vi.fn();
  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
  static last(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }
}

const HANDLE = {
  sessionKey: 'note-1',
  dataUrl: 'http://127.0.0.1:9/index.html',
  controlUrl: 'ws://127.0.0.1:9/control',
  proxyUrl: 'http://127.0.0.1:9/proxy'
};

function makeOpts(over: Partial<PreviewServiceOptions> = {}): {
  opts: PreviewServiceOptions;
  onJump: MockInstance;
  onReady: MockInstance;
  onError: MockInstance;
} {
  const onJump = vi.fn();
  const onReady = vi.fn();
  const onError = vi.fn();
  return {
    onJump,
    onReady,
    onError,
    opts: {
      pluginId: 'com.example.typst',
      serviceId: 'preview',
      sessionKey: 'note-1',
      jumpEvent: 'editorScrollTo',
      onJump,
      onReady,
      onError,
      ...over
    }
  };
}

describe('previewProxyUrl', () => {
  it('injects theme + layout params without dropping existing ones', () => {
    const out = previewProxyUrl(
      'http://127.0.0.1:9/proxy?keep=1',
      '#000',
      '#fff',
      '8px',
      'thin'
    );
    const url = new URL(out);
    expect(url.searchParams.get('keep')).toBe('1');
    expect(url.searchParams.get('bg')).toBe('#000');
    expect(url.searchParams.get('fg')).toBe('#fff');
    expect(url.searchParams.get('gutter')).toBe('8px');
    expect(url.searchParams.get('scrollbar')).toBe('thin');
  });

  it('exports the proxy-ready message name', () => {
    expect(PREVIEW_PROXY_READY).toBe('ms-preview-proxy-ready');
  });
});

describe('PreviewServiceController', () => {
  let originalWs: typeof WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    previewStart.mockReset();
    previewStop.mockReset();
    previewUpdate.mockReset();
    previewStart.mockResolvedValue(HANDLE);
    previewStop.mockResolvedValue(undefined);
    previewUpdate.mockResolvedValue(undefined);
    FakeWebSocket.instances = [];
    originalWs = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWs;
    vi.useRealTimers();
  });

  it('starts the server, connects the control socket, and reports ready', async () => {
    const { opts, onReady, onError } = makeOpts();
    const ctl = new PreviewServiceController(opts);
    await ctl.start('hello');

    expect(previewStart).toHaveBeenCalledWith(
      'com.example.typst',
      'preview',
      'note-1',
      'hello'
    );
    expect(FakeWebSocket.last().url).toBe(HANDLE.controlUrl);
    expect(onReady).toHaveBeenCalledWith(HANDLE.dataUrl, HANDLE.proxyUrl);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports start failures through onError', async () => {
    previewStart.mockRejectedValue(new Error('spawn failed'));
    const { opts, onError, onReady } = makeOpts();
    await new PreviewServiceController(opts).start('x');
    expect(onError).toHaveBeenCalledWith('spawn failed');
    expect(onReady).not.toHaveBeenCalled();
  });

  it('stops the server (and skips onReady) if disposed mid-start', async () => {
    let resolveStart: (v: typeof HANDLE) => void = () => {};
    previewStart.mockReturnValue(
      new Promise<typeof HANDLE>((r) => (resolveStart = r))
    );
    const { opts, onReady } = makeOpts();
    const ctl = new PreviewServiceController(opts);
    const started = ctl.start('x');
    ctl.dispose();
    resolveStart(HANDLE);
    await started;
    expect(onReady).not.toHaveBeenCalled();
    expect(previewStop).toHaveBeenCalledWith('note-1');
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('translates a matching control frame into a normalized jump', async () => {
    const { opts, onJump } = makeOpts();
    const ctl = new PreviewServiceController(opts);
    await ctl.start('x');
    FakeWebSocket.last().emit(
      JSON.stringify({
        event: 'editorScrollTo',
        filepath: '/main.typ',
        start: [4, 2]
      })
    );
    expect(onJump).toHaveBeenCalledWith({
      filepath: '/main.typ',
      line: 4,
      column: 2
    });
  });

  it('defaults a missing filepath to empty string', async () => {
    const { opts, onJump } = makeOpts();
    const ctl = new PreviewServiceController(opts);
    await ctl.start('x');
    FakeWebSocket.last().emit(
      JSON.stringify({ event: 'editorScrollTo', start: [1, 0] })
    );
    expect(onJump).toHaveBeenCalledWith({ filepath: '', line: 1, column: 0 });
  });

  it('ignores non-string, unparseable, mismatched, and malformed frames', async () => {
    const { opts, onJump } = makeOpts();
    const ctl = new PreviewServiceController(opts);
    await ctl.start('x');
    const ws = FakeWebSocket.last();
    ws.emit({ not: 'a string' });
    ws.emit('{ broken json');
    ws.emit(JSON.stringify({ event: 'somethingElse', start: [1, 1] }));
    ws.emit(JSON.stringify({ event: 'editorScrollTo', start: [1] }));
    ws.emit(JSON.stringify({ event: 'editorScrollTo', start: ['a', 'b'] }));
    expect(onJump).not.toHaveBeenCalled();
  });

  it('debounces body updates and pushes only the latest', async () => {
    const { opts } = makeOpts();
    const ctl = new PreviewServiceController(opts);
    await ctl.start('x');
    ctl.updateBody('v1');
    ctl.updateBody('v2');
    expect(previewUpdate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(previewUpdate).toHaveBeenCalledTimes(1);
    expect(previewUpdate).toHaveBeenCalledWith('note-1', 'v2');
  });

  it('ignores updates before start and after dispose', async () => {
    const { opts } = makeOpts();
    const ctl = new PreviewServiceController(opts);
    ctl.updateBody('too-early');
    vi.advanceTimersByTime(200);
    expect(previewUpdate).not.toHaveBeenCalled();

    await ctl.start('x');
    ctl.updateBody('queued');
    ctl.dispose();
    vi.advanceTimersByTime(200);
    expect(previewUpdate).not.toHaveBeenCalled();
  });

  it('dispose closes the socket and stops the server', async () => {
    const { opts } = makeOpts();
    const ctl = new PreviewServiceController(opts);
    await ctl.start('x');
    const ws = FakeWebSocket.last();
    ctl.dispose();
    expect(ws.close).toHaveBeenCalled();
    expect(previewStop).toHaveBeenCalledWith('note-1');
  });

  it('survives a WebSocket constructor that throws (jump is best-effort)', async () => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
      constructor() {
        throw new Error('no socket');
      }
    };
    const { opts, onReady, onError } = makeOpts();
    const ctl = new PreviewServiceController(opts);
    await ctl.start('x');
    // Control socket is non-fatal: the iframe still renders.
    expect(onReady).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
