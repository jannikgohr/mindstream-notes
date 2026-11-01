import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const cli = spawnSync('wasm-bindgen', ['--version'], { encoding: 'utf8' });
if (cli.error || cli.stdout.trim() !== 'wasm-bindgen 0.2.126') {
  throw new Error(
    'Install wasm-bindgen-cli 0.2.126: cargo install wasm-bindgen-cli --version 0.2.126 --locked'
  );
}
run('cargo', [
  'build',
  '--locked',
  '--manifest-path',
  'src-tauri/Cargo.toml',
  '-p',
  'mindstream-browser-wasm',
  '--target',
  'wasm32-unknown-unknown',
  '--release'
]);
const metadata = spawnSync(
  'cargo',
  [
    'metadata',
    '--locked',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '--no-deps',
    '--format-version',
    '1'
  ],
  { cwd: root, encoding: 'utf8' }
);
if (metadata.error) throw metadata.error;
if (metadata.status !== 0) {
  process.stderr.write(metadata.stderr);
  process.exit(metadata.status ?? 1);
}
const target = JSON.parse(metadata.stdout).target_directory;
const output = resolve(root, 'static/browser-wasm');
mkdirSync(output, { recursive: true });
run('wasm-bindgen', [
  resolve(
    target,
    'wasm32-unknown-unknown/release/mindstream_browser_wasm.wasm'
  ),
  '--target',
  'web',
  '--out-dir',
  output,
  '--out-name',
  'storage'
]);
