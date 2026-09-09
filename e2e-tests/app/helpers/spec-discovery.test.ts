import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConfigParser } from '@wdio/config/node';
import picomatch from 'picomatch';
import {
  filterPatterns,
  readWorkflow
} from '../../../src-tauri/scripts/lint-ci-filters.mjs';

const appRoot = fileURLToPath(new URL('../', import.meta.url));

function specFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? specFiles(path)
      : entry.name.endsWith('.e2e.ts')
        ? [pathToFileURL(path).href]
        : [];
  });
}

test('every app spec is discovered by exactly one WDIO suite', async () => {
  const all = specFiles(join(appRoot, 'specs'));
  const counts = new Map(all.map((file) => [file, 0]));
  for (const config of [
    'wdio.conf.ts',
    'wdio.multiremote.conf.ts',
    'wdio.multiremote.a2.conf.ts'
  ]) {
    const parser = new ConfigParser(join(appRoot, config));
    await parser.initialize();
    for (const file of parser.getSpecs().flat()) {
      if (counts.has(file)) counts.set(file, counts.get(file)! + 1);
    }
  }
  assert(all.length > 0);
  for (const [file, count] of counts) {
    assert.equal(
      count,
      1,
      `${file} must belong to exactly one suite; put it under specs/single, specs/multi or specs/multi-a2`
    );
  }
});

test('future collaboration specs and shared helpers select multi CI without new filters', () => {
  const selectsMulti = picomatch(filterPatterns(readWorkflow(), 'collab'), {
    dot: true
  });
  for (const path of [
    'e2e-tests/app/specs/multi/future-feature.e2e.ts',
    'e2e-tests/app/specs/multi/nested/future-feature.e2e.ts',
    'e2e-tests/app/specs/multi-a2/future-feature.e2e.ts',
    'e2e-tests/app/helpers/future-helper.ts'
  ])
    assert.equal(selectsMulti(path), true, path);
  assert.equal(
    selectsMulti('e2e-tests/app/specs/single/future-feature.e2e.ts'),
    false
  );
});
