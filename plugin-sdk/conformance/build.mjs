// Rebuild the conformance components in ./dist from source.
//
//   node plugin-sdk/conformance/build.mjs
//
// The TypeScript component needs only `pnpm install`. The Rust one needs the
// wasm32-unknown-unknown target and wasm-tools:
//
//   rustup target add wasm32-unknown-unknown
//   cargo install wasm-tools --locked
//
// `--ts` or `--rust` builds just one of them.
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

const only = process.argv.slice(2);
const want = (name) => only.length === 0 || only.includes(`--${name}`);

if (want('ts')) {
  const { buildComponent } = await import('../typescript/lib/build.js');
  const out = join(dist, 'conformance-ts.wasm');
  const bytes = await buildComponent({
    source: join(here, 'typescript', 'main.ts'),
    out
  });
  console.log(`wrote dist/conformance-ts.wasm (${bytes.length} bytes)`);
}

if (want('rust')) {
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
}
