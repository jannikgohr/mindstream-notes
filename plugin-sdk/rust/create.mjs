import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const target = process.argv[2];
if (!target)
  throw new Error(
    'usage: node plugin-sdk/rust/create.mjs <empty-project-directory>'
  );
const dir = resolve(target);
await mkdir(dir, { recursive: true });
if ((await readdir(dir)).length) throw new Error(`${dir} is not empty`);
await cp(join(import.meta.dirname, 'templates/starter'), dir, {
  recursive: true
});
await cp(join(import.meta.dirname, '../wit'), join(dir, 'wit'), {
  recursive: true
});
await writeFile(join(dir, '.gitignore'), '/target/\n/dist/\n');
console.log(`Created ${dir}. Run node build.mjs inside it.`);
