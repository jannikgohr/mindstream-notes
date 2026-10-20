// Rebuild the conformance components in ./dist from source.
//
//   node plugin-sdk/conformance/build.mjs
//
// The Rust component needs the wasm32-unknown-unknown target and wasm-tools:
//
//   rustup target add wasm32-unknown-unknown
//   cargo install wasm-tools --locked
//
// The output is committed. Rebuild it after changing the WIT or a
// conformance plugin, and commit the result together with the change.

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
mkdirSync(dist, { recursive: true });

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited with ${result.status}`
    );
  }
}

const rust = join(here, 'rust');
run(
  'cargo',
  ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown'],
  rust
);
run(
  'wasm-tools',
  [
    'component',
    'new',
    join(
      rust,
      'target/wasm32-unknown-unknown/release/mindstream_conformance_plugin.wasm'
    ),
    '-o',
    join(dist, 'conformance-rust.wasm')
  ],
  rust
);
console.log('wrote dist/conformance-rust.wasm');
