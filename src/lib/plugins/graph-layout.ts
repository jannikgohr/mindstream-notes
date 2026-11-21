/** Messages between a `graph` view and its layout worker. */

export type LayoutRequest =
  | {
      type: 'layout';
      version: number;
      /** Per node, by index. A NaN position lets the layout place it. */
      radius: Float32Array;
      x: Float32Array;
      y: Float32Array;
      /** Index pairs. */
      links: Uint32Array;
      /** How hard the layout moves: 1 for a new one, less to adjust one. */
      alpha: number;
      /** Settle before sending the first positions. */
      warmup: boolean;
    }
  | { type: 'drag'; version: number; index: number; x: number; y: number }
  | { type: 'release'; version: number; index: number };

export interface LayoutPositions {
  version: number;
  x: Float32Array<ArrayBuffer>;
  y: Float32Array<ArrayBuffer>;
}

export interface LayoutWorker {
  send(request: LayoutRequest): void;
  stop(): void;
}

export function startLayoutWorker(
  onPositions: (positions: LayoutPositions) => void
): LayoutWorker {
  const worker = new Worker(
    new URL('./graph-layout.worker.ts', import.meta.url),
    { type: 'module' }
  );
  worker.onmessage = (event: MessageEvent<LayoutPositions>) =>
    onPositions(event.data);
  worker.onerror = (event) =>
    console.error('[graph] layout worker failed', event.message);
  return {
    send(request) {
      const transfer =
        request.type === 'layout'
          ? [
              request.radius.buffer,
              request.x.buffer,
              request.y.buffer,
              request.links.buffer
            ]
          : [];
      worker.postMessage(request, { transfer });
    },
    stop: () => worker.terminate()
  };
}
