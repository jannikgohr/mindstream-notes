import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChildProcess } from 'node:child_process';
import {
  startClientDrivers,
  stopClientDrivers,
  type ClientProc
} from './client-drivers.js';

test('driver cleanup cancels pending launches and resets client state', async () => {
  const clients: Record<string, ClientProc> = {
    browserA: { port: 4444, nativePort: 4445, profileId: 'a' },
    browserA2: { port: 4448, nativePort: 4449, profileId: 'a2' },
    browserB: { port: 4446, nativePort: 4447, profileId: 'b' }
  };
  const firstDriver = {} as ChildProcess;
  const stopped: Array<ChildProcess | undefined> = [];
  let launches = 0;

  startClientDrivers(clients, '/tmp/wdio', 20_000, () => {
    launches += 1;
    return firstDriver;
  });

  assert.equal(launches, 1);
  assert.ok(clients.browserA2.startTimer);
  assert.ok(clients.browserB.startTimer);
  clients.browserA.profileDir = '/tmp/profile-a';
  clients.browserA2.profileDir = '/tmp/profile-a2';
  clients.browserB.profileDir = '/tmp/profile-b';

  await stopClientDrivers(clients, async (driver) => {
    stopped.push(driver);
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(stopped, [firstDriver, undefined, undefined]);
  assert.equal(launches, 1);
  for (const client of Object.values(clients)) {
    assert.equal(client.driver, undefined);
    assert.equal(client.profileDir, undefined);
    assert.equal(client.startTimer, undefined);
  }
});
