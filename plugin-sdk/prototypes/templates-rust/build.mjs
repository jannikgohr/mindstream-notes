import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { componentNew } from '@bytecodealliance/jco-transpile/wasm-tools';

const here = dirname(fileURLToPath(import.meta.url));
const local = process.argv.includes('--local-calendar');
const batch = process.argv.includes('--batch-host');
if (local && batch) throw new Error('Select only one calendar candidate');
for (const [command, args] of [
  [
    'cargo',
    [
      'build',
      '--locked',
      '--release',
      '--target',
      'wasm32-unknown-unknown',
      ...(local
        ? ['--features', 'local-calendar']
        : batch
          ? ['--features', 'batch-host']
          : [])
    ]
  ]
]) {
  const result = spawnSync(command, args, { cwd: here, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited with ${result.status}`);
}
await writeFile(
  join(
    here,
    local
      ? 'plugin-local-calendar.wasm'
      : batch
        ? 'plugin-batch.wasm'
        : 'plugin.wasm'
  ),
  await componentNew(
    await readFile(
      join(
        here,
        'target/wasm32-unknown-unknown/release/mindstream_templates_prototype.wasm'
      )
    ),
    []
  )
);
