import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = import.meta.dirname;
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status})`);
}
run('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown']);
const out = join(root, 'dist');
mkdirSync(out, { recursive: true });
run('wasm-tools', [
  'component',
  'new',
  'target/wasm32-unknown-unknown/release/mindstream_hello_plugin.wasm',
  '-o',
  join(out, 'plugin.wasm')
]);
for (const file of ['manifest.json', 'hello.svg'])
  copyFileSync(join(root, file), join(out, file));
console.log(`Install ${out} from Settings → Plugins.`);
