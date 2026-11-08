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
function launch(args, overrides = {}) {
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
      'console.log(JSON.stringify({ args: process.argv.slice(2), splitDebugInfo: process.env.CARGO_PROFILE_DEV_SPLIT_DEBUGINFO ?? null }))'
    );
    const env = { ...process.env };
    delete env.CARGO_PROFILE_DEV_SPLIT_DEBUGINFO;
    delete env.CARGO_BUILD_TARGET;
    Object.assign(env, overrides);
    const result = spawnSync(
      process.execPath,
      [join(scripts, 'tauri.mjs'), ...args],
      {
        encoding: 'utf8',
        env
      }
    );
    assert.equal(result.status, 0, result.stderr);
    return { ...JSON.parse(result.stdout), root };
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

test('development preserves an existing Cargo defaults flag without duplicating it', () => {
  const { args } = launch([
    'dev',
    '--',
    '--no-default-features',
    '--',
    '--app-option'
  ]);
  const runnerStart = args.indexOf('--');
  assert.deepEqual(args.slice(runnerStart), [
    '--',
    '--no-default-features',
    '--',
    '--app-option'
  ]);
});

test('native Linux development uses split debug info without changing release builds', () => {
  assert.equal(
    launch(['dev']).splitDebugInfo,
    process.platform === 'linux' ? 'unpacked' : null
  );
  assert.equal(launch(['build']).splitDebugInfo, null);
});

test('development respects explicit debug info settings and cross targets', () => {
  assert.equal(
    launch(['dev'], { CARGO_PROFILE_DEV_SPLIT_DEBUGINFO: 'packed' })
      .splitDebugInfo,
    'packed'
  );
  for (const args of [
    ['dev', '--target', 'x86_64-pc-windows-gnu'],
    ['dev', '--target=x86_64-pc-windows-gnu'],
    ['dev', '--', '--target', 'x86_64-pc-windows-gnu']
  ])
    assert.equal(launch(args).splitDebugInfo, null);
  assert.equal(
    launch(['dev'], { CARGO_BUILD_TARGET: 'x86_64-pc-windows-gnu' })
      .splitDebugInfo,
    null
  );
  assert.equal(
    launch(['dev', '--', '--config', 'profile.dev.split-debuginfo="packed"'])
      .splitDebugInfo,
    null
  );
});
