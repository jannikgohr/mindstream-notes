import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Exercise the launcher without starting a WebView or the app's real profile.
function launch(args) {
  const root = mkdtempSync(join(tmpdir(), 'build-launcher-'));
  try {
    const scripts = join(root, 'src-tauri', 'scripts');
    const cli = join(root, 'node_modules', '@tauri-apps', 'cli');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(cli, { recursive: true });
    copyFileSync(
      new URL('./tauri.mjs', import.meta.url),
      join(scripts, 'tauri.mjs')
    );
    writeFileSync(
      join(cli, 'tauri.js'),
      'console.log(JSON.stringify(process.argv.slice(2)))'
    );
    const result = spawnSync(
      process.execPath,
      [join(scripts, 'tauri.mjs'), ...args],
      {
        encoding: 'utf8'
      }
    );
    assert.equal(result.status, 0, result.stderr);
    return { args: JSON.parse(result.stdout), root };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('development omits the default plugin precompiler and keeps the isolated app identity', () => {
  const { args, root } = launch(['dev', '--', '--verbose']);
  assert.equal(args[0], 'dev');
  assert.ok(args.includes('--no-default-features'));
  assert.equal(
    args[args.indexOf('--config') + 1],
    join(root, 'src-tauri', 'tauri.dev.conf.json')
  );
  assert.equal(args[args.indexOf('--features') + 1], 'dev-environment');
  assert.ok(args.indexOf('--no-default-features') > args.indexOf('--'));
  assert.deepEqual(args.slice(args.indexOf('--')), [
    '--',
    '--no-default-features',
    '--verbose'
  ]);
});

test('release builds keep default features and caller arguments', () => {
  const args = ['build', '--no-bundle', '--features', 'e2e-data-dir'];
  assert.deepEqual(launch(args).args, args);
});

test('development can explicitly enable the plugin precompiler', () => {
  const { args } = launch(['dev', '--features', 'bundled-aot']);
  assert.ok(args.includes('bundled-aot'));
  assert.ok(args.includes('dev-environment'));
});

test('development preserves arguments for the runner and the application', () => {
  const { args } = launch([
    'dev',
    '--',
    '--release',
    '--',
    '--some-app-option'
  ]);
  assert.deepEqual(args.slice(args.indexOf('--')), [
    '--',
    '--no-default-features',
    '--release',
    '--',
    '--some-app-option'
  ]);
});
