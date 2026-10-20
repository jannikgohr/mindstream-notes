import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { componentNew } from '@bytecodealliance/jco-transpile/wasm-tools';

const here = dirname(fileURLToPath(import.meta.url));
for (const [command, args] of [
  [
    'cargo',
    ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown']
  ]
]) {
  const result = spawnSync(command, args, { cwd: here, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited with ${result.status}`);
}
await writeFile(
  join(here, 'plugin.wasm'),
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
