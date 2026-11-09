import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cachedComponent } from './fixture-cache.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'fixture-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputs = ['source.ts', 'world.wit', 'builder.js', 'lock.yaml'].map(
    (name) => join(root, name)
  );
  await Promise.all(inputs.map((path) => writeFile(path, path)));
  let builds = 0;
  const options = {
    name: 'example',
    root,
    inputs,
    cacheDir: join(root, 'cache'),
    out: join(root, 'one', 'example.wasm'),
    async build(out) {
      builds++;
      const bytes = Buffer.from(`component ${builds}`);
      await mkdir(join(out, '..'), { recursive: true });
      await writeFile(out, bytes);
      return bytes;
    }
  };
  return { root, options, builds: () => builds };
}

test('unchanged inputs reuse the component across Cargo output directories', async (t) => {
  const { root, options, builds } = await setup(t);
  const first = await cachedComponent(options);
  const second = await cachedComponent({
    ...options,
    out: join(root, 'two', 'example.wasm')
  });
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.deepEqual(second.bytes, first.bytes);
  assert.equal(builds(), 1);
  const timestamp = (await stat(options.out)).mtimeMs;
  await cachedComponent(options);
  assert.equal((await stat(options.out)).mtimeMs, timestamp);
});

test('source, WIT, builder and dependency lock changes invalidate cached components', async (t) => {
  const { options, builds } = await setup(t);
  await cachedComponent(options);
  for (const path of options.inputs) {
    await writeFile(path, 'changed');
    assert.equal((await cachedComponent(options)).cacheHit, false);
  }
  assert.equal(builds(), 5);
});

test('added inputs and corrupt cached output rebuild rather than returning stale bytes', async (t) => {
  const { root, options, builds } = await setup(t);
  await cachedComponent(options);
  const added = join(root, 'added.ts');
  await writeFile(added, 'new source');
  const changed = { ...options, inputs: [...options.inputs, added] };
  assert.equal((await cachedComponent(changed)).cacheHit, false);
  const path = join(options.cacheDir, 'example.json');
  const entry = JSON.parse(await readFile(path, 'utf8'));
  entry.component = Buffer.from('corrupt').toString('base64');
  await writeFile(path, JSON.stringify(entry));
  assert.equal((await cachedComponent(changed)).cacheHit, false);
  assert.equal(builds(), 3);
  await writeFile(path, 'not JSON');
  assert.equal((await cachedComponent(changed)).cacheHit, false);
});

test('cache opt-out and unavailable cache storage still build normally', async (t) => {
  const { root, options, builds } = await setup(t);
  await cachedComponent(options);
  assert.equal(
    (await cachedComponent({ ...options, enabled: false })).cacheHit,
    false
  );
  const file = join(root, 'not-a-directory');
  await writeFile(file, 'file');
  assert.equal(
    (await cachedComponent({ ...options, cacheDir: join(file, 'cache') }))
      .cacheHit,
    false
  );
  assert.equal(builds(), 3);
});

test('changed bundle output invalidates even when the declared source list is unchanged', async (t) => {
  const { options, builds } = await setup(t);
  await cachedComponent({ ...options, recipe: 'first bundle' });
  assert.equal(
    (await cachedComponent({ ...options, recipe: 'second bundle' })).cacheHit,
    false
  );
  assert.equal(
    (await cachedComponent({ ...options, recipe: 'second bundle' })).cacheHit,
    true
  );
  assert.equal(builds(), 2);
});
