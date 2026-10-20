import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { waitForShell } from '../../helpers/harness.js';
import { repoRoot } from '../../helpers/preflight.js';

const id = 'com.example.wasm-lifecycle';

async function invoke<T>(
  command: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  return browser.execute(
    async (command, args) => {
      const api = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke(
              command: string,
              args: Record<string, unknown>
            ): Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__;
      return api.invoke(command, args);
    },
    command,
    args
  ) as Promise<T>;
}

interface ProbeState {
  beats: number;
  result: string | null;
}

async function startRunaway(): Promise<void> {
  await browser.execute((id) => {
    const target = window as unknown as {
      __wasmLifecycle: ProbeState;
      __TAURI_INTERNALS__: {
        invoke(
          command: string,
          args: Record<string, unknown>
        ): Promise<unknown>;
      };
    };
    const state: ProbeState = { beats: 0, result: null };
    target.__wasmLifecycle = state;
    const frame = () => {
      state.beats += 1;
      if (state.result === null) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    void target.__TAURI_INTERNALS__
      .invoke('plugins_run_script', {
        id,
        export: 'spin',
        input: {}
      })
      .then(
        () => {
          state.result = 'unexpected success';
        },
        (error: unknown) => {
          state.result = JSON.stringify(error);
        }
      );
  }, id);
  await browser.waitUntil(async () => (await probeState()).beats >= 2, {
    timeout: 1000,
    interval: 10,
    timeoutMsg: 'WebView frames stopped during a runaway plugin'
  });
}

async function probeState(): Promise<ProbeState> {
  return browser.execute(
    () =>
      (
        window as unknown as {
          __wasmLifecycle: ProbeState;
        }
      ).__wasmLifecycle
  );
}

async function expectCancellation(): Promise<void> {
  await browser.waitUntil(async () => (await probeState()).result !== null, {
    timeout: 2000,
    interval: 10,
    timeoutMsg: 'plugin cancellation did not settle'
  });
  assert.match((await probeState()).result ?? '', /cancel/i);
}

describe('signed Wasm plugin lifecycle in the packaged app', function () {
  let work: string;

  before(async () => {
    await waitForShell();
    work = mkdtempSync(join(tmpdir(), 'mindstream-wasm-lifecycle-'));
    const folder = join(work, 'package');
    mkdirSync(folder);
    const sharedFixture = process.env.MINDSTREAM_E2E_PLUGIN_FIXTURE;
    if (sharedFixture) {
      // Reuse an already signed package for the desktop/Android comparison.
      for (const file of ['manifest.json', 'plugin.wasm', 'signature.json']) {
        copyFileSync(join(sharedFixture, file), join(folder, file));
      }
    } else {
      copyFileSync(
        join(repoRoot, 'plugin-sdk/conformance/dist/conformance-rust.wasm'),
        join(folder, 'plugin.wasm')
      );
      writeFileSync(
        join(folder, 'manifest.json'),
        JSON.stringify({
          manifestVersion: 2,
          id,
          name: 'Wasm lifecycle probe',
          version: '1.0.0',
          runtime: 'wasm',
          entry: 'plugin.wasm',
          permissions: [
            'notes.read',
            'pluginStorage.read',
            'pluginStorage.write'
          ],
          contributes: {}
        })
      );
      execFileSync(process.execPath, [
        join(repoRoot, 'src-tauri/scripts/sign-plugin.mjs'),
        folder,
        '--generate',
        join(work, 'test-key.pem')
      ]);
    }
    assert.equal(await invoke('plugins_install', { sourcePath: folder }), id);
    await invoke('plugins_discover');
  });

  after(async () => {
    await invoke('plugins_remove', { id }).catch(() => {});
    if (work) {
      assert.ok(resolve(work).startsWith(resolve(tmpdir()) + sep));
      assert.ok(work.includes('mindstream-wasm-lifecycle-'));
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('gates approval, reaches storage, and cancels disable/remove without blocking frames or another plugin', async () => {
    await assert.rejects(
      invoke('plugins_run_script', { id, export: 'echo', input: {} })
    );
    await invoke('plugins_approve', { id });
    await invoke('plugins_enable', { id });
    const report = await invoke<{ storage: Record<string, unknown> }>(
      'plugins_run_script',
      {
        id,
        export: 'report',
        input: {}
      }
    );
    assert.deepEqual(report.storage.write, { ok: null });
    assert.deepEqual(report.storage.readAfter, { ok: '{"n":1}' });
    assert.deepEqual(report.storage.readDeleted, { ok: null });

    // Compile the unrelated plugin before starting the one-second runaway.
    await invoke('plugins_run_script', {
      id: 'com.mindstream.templates.core',
      export: 'renderTemplate',
      input: { title: 'Warmup', body: '' }
    });
    await startRunaway();
    assert.deepEqual(
      await invoke('plugins_run_script', {
        id: 'com.mindstream.templates.core',
        export: 'renderTemplate',
        input: { title: 'Still responsive', body: 'Other plugin completed' }
      }),
      { title: 'Still responsive', body: 'Other plugin completed' }
    );
    assert.equal(
      (await probeState()).result,
      null,
      'runaway must still be active before disable'
    );
    await invoke('plugins_disable', { id });
    await expectCancellation();
    await invoke('plugins_enable', { id });
    const recovered = await invoke<{ recovered: boolean }>(
      'plugins_run_script',
      {
        id,
        export: 'echo',
        input: { recovered: true }
      }
    );
    assert.equal(recovered.recovered, true);

    await startRunaway();
    await invoke('plugins_remove', { id });
    await expectCancellation();
    // Removal deletes the device package but keeps the vault's approval
    // record, disabled, so a reinstall cannot silently inherit it.
    const removed = await invoke<{ enabled: boolean } | null>('plugins_get', {
      id
    });
    assert.equal(removed?.enabled, false);
    await assert.rejects(
      invoke('plugins_run_script', { id, export: 'echo', input: {} })
    );
  });
});
