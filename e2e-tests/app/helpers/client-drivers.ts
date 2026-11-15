import type { ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnTauriDriver, stopTauriDriverTree } from './preflight.js';
import { webviewEnvironment } from './worker-isolation.js';

export interface ClientProc {
  port: number;
  nativePort: number;
  profileId: string;
  profileDir?: string;
  driver?: ChildProcess;
  startTimer?: ReturnType<typeof setTimeout>;
}

export function spawnClientDriver(
  client: ClientProc,
  outputDir: string
): ChildProcess {
  client.profileDir = mkdtempSync(
    join(tmpdir(), `mindstream-${client.profileId}-`)
  );
  const dictionaryDir = mkdtempSync(
    join(tmpdir(), `mindstream-${client.profileId}-dict-`)
  );
  return spawnTauriDriver(
    ['--port', String(client.port), '--native-port', String(client.nativePort)],
    {
      ...process.env,
      MINDSTREAM_PROFILE_DIR: client.profileDir,
      MINDSTREAM_ROOT_DIR: join(client.profileDir, '.app-root'),
      MINDSTREAM_PROFILE_ID: client.profileId,
      MINDSTREAM_DICTIONARY_DIR: dictionaryDir,
      ...webviewEnvironment(client.profileDir)
    },
    join(outputDir, `tauri-driver-${client.profileId}.log`)
  );
}

export function startClientDrivers(
  clients: Record<string, ClientProc>,
  outputDir: string,
  staggerMs = 20_000,
  spawnDriver = spawnClientDriver
): void {
  for (const [index, client] of Object.values(clients).entries()) {
    if (client.driver || client.startTimer) continue;
    if (index === 0) {
      client.driver = spawnDriver(client, outputDir);
    } else {
      client.startTimer = setTimeout(() => {
        client.driver = spawnDriver(client, outputDir);
        client.startTimer = undefined;
      }, index * staggerMs);
    }
  }
}

export async function stopClientDrivers(
  clients: Record<string, ClientProc>,
  stopDriver = stopTauriDriverTree
): Promise<void> {
  for (const client of Object.values(clients)) {
    if (client.startTimer) {
      clearTimeout(client.startTimer);
      client.startTimer = undefined;
    }
    try {
      await stopDriver(client.driver);
    } finally {
      client.driver = undefined;
      client.profileDir = undefined;
    }
  }
}
