// Build the components the runtime, app and SDK tests load. None of them
// ship, so they are built from source when a test needs them rather than
// committed. The Rust tests get them through `src-tauri/plugin-fixtures`,
// whose build script runs this and embeds the bytes, so the same test binary
// still runs on an Android device.
//
//   node plugin-sdk/fixtures.mjs [--out <dir>] [name...]
//
// The TypeScript fixtures need only `pnpm install`. The Rust ones also need
// the wasm32-unknown-unknown target:
//
//   rustup target add wasm32-unknown-unknown
//
// Each Rust variant has its own target directory, so building one feature
// set does not throw away the others' incremental state.

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { componentNew } from '@bytecodealliance/jco-transpile/wasm-tools';
import { buildComponent } from './typescript/lib/build.js';

const sdk = import.meta.dirname;
const root = join(sdk, '..');

// A build script's environment describes the crate being built: its target,
// profile, rustc wrappers such as clippy or coverage instrumentation, and
// cargo's jobserver. None of that applies to a wasm32 guest.
function guestEnv() {
  const keep = /^CARGO_(HOME|NET_|HTTP_|REGISTRY_|REGISTRIES_)/;
  const drop =
    /^(CARGO|CARGO_.*|__CARGO.*|RUSTC.*|RUSTDOC.*|RUSTFLAGS|TARGET|HOST|OUT_DIR|OPT_LEVEL|PROFILE|DEBUG|NUM_JOBS|MAKEFLAGS|MFLAGS|LLVM_PROFILE_FILE)$/;
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => keep.test(key) || !drop.test(key)
    )
  );
}

function rust(crate, artifact, features = []) {
  const dir = join(sdk, crate);
  const targetDir = join(
    dir,
    'target',
    'fixtures',
    features.join('+') || 'default'
  );
  return {
    inputs: [
      join(dir, 'Cargo.toml'),
      join(dir, 'Cargo.lock'),
      join(dir, 'src')
    ],
    async build(out) {
      const args = [
        'build',
        '--locked',
        '--release',
        '--target',
        'wasm32-unknown-unknown',
        '--target-dir',
        targetDir
      ];
      if (features.length) args.push('--features', features.join(','));
      // Keep stdout free for the cargo directives the build script forwards.
      const result = spawnSync('cargo', args, {
        cwd: dir,
        env: guestEnv(),
        stdio: ['ignore', 2, 2]
      });
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error(`cargo build in ${crate} exited with ${result.status}`);
      const core = await readFile(
        join(targetDir, 'wasm32-unknown-unknown/release', `${artifact}.wasm`)
      );
      const bytes = await componentNew(core, []);
      await writeFile(out, bytes);
      return bytes;
    }
  };
}

function typescript(source, optSize = true) {
  return {
    inputs: [dirname(join(sdk, source))],
    build: (out) => buildComponent({ source: join(sdk, source), out, optSize })
  };
}

export const fixtures = {
  'conformance-rust': rust('conformance/rust', 'mindstream_conformance_plugin'),
  'conformance-ts': typescript('conformance/typescript/main.ts'),
  'templates-typescript': typescript(
    'examples/templates-typescript/main.ts',
    false
  ),
  'typst-typescript': typescript('examples/typst-typescript/main.ts'),
  'templates-rust': rust(
    'prototypes/templates-rust',
    'mindstream_templates_prototype'
  ),
  'templates-rust-batch': rust(
    'prototypes/templates-rust',
    'mindstream_templates_prototype',
    ['batch-host']
  ),
  'templates-rust-local-calendar': rust(
    'prototypes/templates-rust',
    'mindstream_templates_prototype',
    ['local-calendar']
  )
};

// Everything a fixture is built from, so cargo reruns the build script when
// any of it changes. Build output and dependencies are left out.
const shared = [
  join(sdk, 'fixtures.mjs'),
  join(sdk, 'wit'),
  join(sdk, 'typescript/lib'),
  join(sdk, 'typescript/src'),
  join(root, 'pnpm-lock.yaml')
];

async function* files(path) {
  if (!(await stat(path)).isDirectory()) {
    yield path;
    return;
  }
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (['target', 'node_modules'].includes(entry.name)) continue;
    if (entry.name.endsWith('.wasm')) continue;
    yield* files(join(path, entry.name));
  }
}

export async function buildFixtures(out, names = Object.keys(fixtures)) {
  await mkdir(out, { recursive: true });
  const built = {};
  for (const name of names) {
    const fixture = fixtures[name];
    if (!fixture) throw new Error(`unknown plugin test fixture: ${name}`);
    built[name] = join(out, `${name}.wasm`);
    await fixture.build(built[name]);
  }
  return built;
}

export async function fixtureInputs(names = Object.keys(fixtures)) {
  const inputs = new Set();
  for (const path of [...shared, ...names.flatMap((n) => fixtures[n].inputs)])
    for await (const file of files(path)) inputs.add(file);
  return [...inputs].sort();
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const cargo = args.includes('--cargo');
  const at = args.indexOf('--out');
  const out = resolve(
    at === -1 ? join(root, '.output/plugin-fixtures') : args[at + 1]
  );
  const names = args.filter(
    (arg, i) => !arg.startsWith('--') && (at === -1 || i !== at + 1)
  );
  const selected = names.length ? names : Object.keys(fixtures);
  const built = await buildFixtures(out, selected);
  if (cargo) {
    for (const file of await fixtureInputs(selected))
      console.log(`cargo:rerun-if-changed=${file}`);
  } else {
    for (const path of Object.values(built)) console.error(`wrote ${path}`);
  }
}
