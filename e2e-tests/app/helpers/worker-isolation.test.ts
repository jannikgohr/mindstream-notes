import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  configureWorker,
  multiWorkers,
  webviewEnvironment,
  workerEndpoints
} from './worker-isolation.js';

test('concurrent workers have disjoint driver ports and keyring IDs', () => {
  const endpoints = ['0-0', '0-1', '0-2', '0-10'].flatMap((cid) =>
    Object.values(workerEndpoints(cid, 123))
  );
  const ports = endpoints.flatMap(({ port, nativePort }) => [port, nativePort]);
  assert.equal(new Set(ports).size, ports.length);
  assert.equal(
    new Set(endpoints.map(({ profileId }) => profileId)).size,
    endpoints.length
  );
  assert.notEqual(
    workerEndpoints('0-0', 123).browserA.profileId,
    workerEndpoints('0-0', 456).browserA.profileId
  );
});

test('driver and WDIO connection ports are updated together', () => {
  const clients = workerEndpoints('0-0');
  const caps = { browserA: { port: 4444 }, browserB: { port: 4446 } };
  configureWorker(clients, caps, '0-4');
  assert.equal(caps.browserA.port, clients.browserA.port);
  assert.equal(caps.browserB.port, clients.browserB.port);
  assert.notEqual(caps.browserA.port, caps.browserB.port);
  assert.match(clients.browserA.profileId, /-0-4-a$/);
});

test('bad worker IDs fail before starting drivers', () => {
  for (const cid of ['unexpected', '1-0', '0--1', '0-99999999']) {
    assert.throws(() => workerEndpoints(cid));
  }
});

test('WebView storage follows the disposable profile on Linux and Windows', () => {
  const a = webviewEnvironment('/tmp/client-a', 'linux');
  const b = webviewEnvironment('/tmp/client-b', 'linux');
  assert.notEqual(a.XDG_DATA_HOME, b.XDG_DATA_HOME);
  assert.notEqual(a.XDG_CACHE_HOME, b.XDG_CACHE_HOME);
  assert.equal(a.XDG_DATA_HOME, join('/tmp/client-a', 'xdg-data'));
  assert.equal(
    webviewEnvironment('/tmp/client-a', 'win32').WEBVIEW2_USER_DATA_FOLDER,
    join('/tmp/client-a', 'webview')
  );
});

test('concurrency is bounded and cannot reuse server accounts', () => {
  assert.equal(multiWorkers('1', '1'), 1);
  assert.equal(multiWorkers('2', '0'), 2);
  for (const value of ['0', '3', '-1', 'NaN', '1.5']) {
    assert.throws(() => multiWorkers(value, '0'));
  }
  assert.throws(() => multiWorkers('2', '1'), /fresh accounts/);
});
