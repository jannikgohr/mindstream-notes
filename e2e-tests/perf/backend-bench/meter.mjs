/**
 * HTTP metering for the Etebase JS SDK, plus the sample statistics the
 * benchmark reports.
 *
 * Wall time alone can't tell a slow server from slow client-side crypto, and
 * on localhost it hides the cost that dominates over a real network: the
 * number of round trips. So every scenario also records how many requests it
 * made, how long those spent on the wire, and how many bytes came back.
 *
 * In Node the SDK sends every request through `require('node-fetch')`, looked
 * up at call time, so swapping that module's cached export is enough to see
 * all of them without patching the SDK.
 */

import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** Resolves modules the way the SDK does, so we patch the copy it loads. */
const sdkRequire = createRequire(require.resolve('etebase'));

const totals = { requests: 0, httpMs: 0, txBytes: 0, rxBytes: 0 };

// node-fetch sends `Connection: close` unless it is handed an agent. The app's
// reqwest client keeps connections alive, so without these every request here
// would pay a TCP handshake the app doesn't.
const agents = {
  'http:': new http.Agent({ keepAlive: true }),
  'https:': new https.Agent({ keepAlive: true })
};

let realFetch = null;

async function meteredFetch(url, options = {}) {
  const started = performance.now();
  const response = await realFetch(url, {
    ...options,
    agent: agents[new URL(url).protocol]
  });
  // The request isn't over until the body is read, and the SDK always reads
  // it through arrayBuffer().
  const readBody = response.arrayBuffer.bind(response);
  response.arrayBuffer = async () => {
    const body = await readBody();
    totals.requests += 1;
    totals.httpMs += performance.now() - started;
    totals.txBytes += options.body?.byteLength ?? 0;
    totals.rxBytes += body.byteLength;
    return body;
  };
  return response;
}

/** Route the SDK's requests through the meter. Call once, before any request. */
export function installHttpMeter() {
  realFetch = sdkRequire('node-fetch');
  require.cache[sdkRequire.resolve('node-fetch')].exports = meteredFetch;
}

/** Drop the keep-alive sockets so the process can exit. */
export function closeHttpMeter() {
  for (const agent of Object.values(agents)) agent.destroy();
}

/** A metered GET for the requests the app makes outside the SDK. */
export async function meteredGet(url) {
  const response = await meteredFetch(url);
  await response.arrayBuffer();
  return response.status;
}

export function httpSnapshot() {
  return { ...totals };
}

export function httpSince(before) {
  return {
    requests: totals.requests - before.requests,
    httpMs: totals.httpMs - before.httpMs,
    txBytes: totals.txBytes - before.txBytes,
    rxBytes: totals.rxBytes - before.rxBytes
  };
}

export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

function spread(values) {
  return {
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    min: Math.min(...values),
    max: Math.max(...values)
  };
}

/**
 * Collapse per-repetition samples into one result row. Request and byte counts
 * are reported as medians: they are near-constant per scenario, and a median
 * keeps one odd repetition (a retried request, an extra page) from skewing it.
 */
export function summarise(samples) {
  const pick = (key) => samples.map((sample) => sample[key]);
  return {
    n: samples.length,
    wallMs: spread(pick('wallMs')),
    requests: percentile(pick('requests'), 50),
    httpMs: percentile(pick('httpMs'), 50),
    txBytes: percentile(pick('txBytes'), 50),
    rxBytes: percentile(pick('rxBytes'), 50)
  };
}

/** Result row for a scenario that never touches HTTP (WebSocket latencies). */
export function summariseLatencies(latenciesMs) {
  return {
    n: latenciesMs.length,
    wallMs: { ...spread(latenciesMs), p99: percentile(latenciesMs, 99) },
    requests: 0,
    httpMs: 0,
    txBytes: 0,
    rxBytes: 0
  };
}
