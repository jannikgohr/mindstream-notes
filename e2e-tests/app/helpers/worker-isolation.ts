import { join } from 'node:path';

export interface ClientEndpoint {
  port: number;
  nativePort: number;
  profileId: string;
}

/** Allocate four ports per WDIO worker, away from the single-client suite. */
export function workerEndpoints(cid: string, processId = process.pid) {
  if (!/^0-\d+$/.test(cid))
    throw new Error(`Unexpected multi worker id: ${cid}`);
  const worker = Number(cid.slice(2));
  const port = 4544 + worker * 4;
  if (!Number.isSafeInteger(port) || port + 3 > 65535) {
    throw new Error(`Multi worker id exceeds the port range: ${cid}`);
  }
  return {
    browserA: {
      port,
      nativePort: port + 1,
      profileId: `e2e-multi-${processId}-${cid}-a`
    },
    browserB: {
      port: port + 2,
      nativePort: port + 3,
      profileId: `e2e-multi-${processId}-${cid}-b`
    }
  };
}

/** Configure both the driver and the client before WDIO opens its sessions. */
export function configureWorker(
  clients: Record<'browserA' | 'browserB', ClientEndpoint>,
  capabilities: Record<string, { port?: number }>,
  cid: string
) {
  const endpoints = workerEndpoints(cid);
  for (const name of ['browserA', 'browserB'] as const) {
    if (!capabilities[name])
      throw new Error(`Missing multi capability: ${name}`);
    Object.assign(clients[name], endpoints[name]);
    capabilities[name].port = endpoints[name].port;
  }
}

/** SQLite isolation alone does not isolate WebKit localStorage and caches. */
export function webviewEnvironment(
  profileDir: string,
  platform = process.platform
) {
  if (platform === 'win32') {
    return { WEBVIEW2_USER_DATA_FOLDER: join(profileDir, 'webview') };
  }
  return platform === 'linux'
    ? {
        XDG_DATA_HOME: join(profileDir, 'xdg-data'),
        XDG_CACHE_HOME: join(profileDir, 'xdg-cache')
      }
    : {};
}

export function multiWorkers(
  raw = process.env.MINDSTREAM_E2E_MULTI_WORKERS,
  reuseAccounts = process.env.MINDSTREAM_E2E_REUSE_ACCOUNTS
) {
  const workers = Number(raw ?? '1');
  if (workers !== 1 && workers !== 2) {
    throw new Error('MINDSTREAM_E2E_MULTI_WORKERS must be 1 or 2');
  }
  if (workers > 1 && reuseAccounts === '1') {
    throw new Error(
      'Parallel multi workers require fresh accounts; disable MINDSTREAM_E2E_REUSE_ACCOUNTS'
    );
  }
  return workers;
}
