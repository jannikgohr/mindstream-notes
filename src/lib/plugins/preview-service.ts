/**
 * Frontend bridge to a plugin's long-lived preview server (see
 * `src-tauri/src/plugins/preview_service.rs`). It starts the server for one note
 * session, connects the **control-plane WebSocket** as the "editor", pushes body
 * edits (which make the server recompile), and turns the server's inverse-search
 * message into a normalized `jumpToSource` the editor uses to move the caret.
 *
 * The control-plane message *names* are supplied by the plugin manifest
 * (`nativeServices[].protocol`), so this stays free of tool-specific strings —
 * it only assumes the jump payload carries `{ filepath, start: [line, column] }`
 * (0-indexed), which is the typst-preview / tinymist shape.
 */
import {
  pluginsPreviewStart,
  pluginsPreviewStop,
  pluginsPreviewUpdate
} from '$lib/api/plugins';
import { toErrorMessage } from '$lib/api/errors';

export interface PreviewJump {
  filepath: string;
  /** 0-indexed source line. */
  line: number;
  /** 0-indexed source column. */
  column: number;
}

export interface PreviewServiceOptions {
  pluginId: string;
  serviceId: string;
  /** Stable per-note session id; the backend keys the running server by it. */
  sessionKey: string;
  /** Control-plane event name that means "jump the editor" (e.g. editorScrollTo). */
  jumpEvent: string;
  onJump: (jump: PreviewJump) => void;
  /** Called with the iframe URL once the server is listening. */
  onReady: (dataUrl: string, proxyUrl: string | null) => void;
  onError: (message: string) => void;
  /**
   * Snapshot of the plugin's own settings (id → stringified value), fed into
   * `{setting:<id>}` placeholders in the service's launch args (e.g. tinymist's
   * `--partial-rendering`). Read once at start; changing a setting takes effect
   * on the next preview start.
   */
  settings?: Record<string, string>;
}

const UPDATE_DEBOUNCE_MS = 200;

/**
 * URL of the per-session loopback reverse proxy. `bg` is the app-theme
 * background color to inject behind the pages; `gutter` is the page-to-scrollbar
 * spacing inside the iframe document.
 */
export function previewProxyUrl(
  proxyUrl: string,
  bg: string,
  fg: string,
  gutter: string,
  scrollbar: string
): string {
  const url = new URL(proxyUrl);
  url.searchParams.set('bg', bg);
  url.searchParams.set('fg', fg);
  url.searchParams.set('gutter', gutter);
  url.searchParams.set('scrollbar', scrollbar);
  return url.toString();
}

/** Message the proxied frontend posts to the parent once its scripts run. */
export const PREVIEW_PROXY_READY = 'ms-preview-proxy-ready';

export class PreviewServiceController {
  private ws: WebSocket | null = null;
  private disposed = false;
  private started = false;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingBody: string | null = null;

  constructor(private readonly opts: PreviewServiceOptions) {}

  /** Start the server with the initial body, then wire the control plane. */
  async start(input: string): Promise<void> {
    try {
      const handle = await pluginsPreviewStart(
        this.opts.pluginId,
        this.opts.serviceId,
        this.opts.sessionKey,
        input,
        this.opts.settings ?? {}
      );
      if (this.disposed) {
        void pluginsPreviewStop(this.opts.sessionKey);
        return;
      }
      this.started = true;
      this.connectControl(handle.controlUrl);
      this.opts.onReady(handle.dataUrl, handle.proxyUrl);
    } catch (err) {
      if (!this.disposed) this.opts.onError(toErrorMessage(err));
    }
  }

  private connectControl(url: string): void {
    try {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onmessage = (event) => this.onControlMessage(event);
      // A failed control socket only costs click-to-source; the iframe still
      // renders, so it's non-fatal — swallow it.
      ws.onerror = () => {};
    } catch {
      /* ignore — non-fatal */
    }
  }

  private onControlMessage(event: MessageEvent): void {
    if (typeof event.data !== 'string') return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!msg || msg.event !== this.opts.jumpEvent) return;
    const start = msg.start;
    if (!Array.isArray(start) || start.length < 2) return;
    const line = Number(start[0]);
    const column = Number(start[1]);
    if (!Number.isFinite(line) || !Number.isFinite(column)) return;
    this.opts.onJump({
      filepath: typeof msg.filepath === 'string' ? msg.filepath : '',
      line,
      column
    });
  }

  /** Debounced push of the current body so the server recompiles. */
  updateBody(input: string): void {
    if (!this.started || this.disposed) return;
    this.pendingBody = input;
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      const body = this.pendingBody;
      this.pendingBody = null;
      if (body !== null && !this.disposed) {
        void pluginsPreviewUpdate(this.opts.sessionKey, body);
      }
    }, UPDATE_DEBOUNCE_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    if (this.started) void pluginsPreviewStop(this.opts.sessionKey);
  }
}
