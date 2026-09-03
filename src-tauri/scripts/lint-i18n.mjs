#!/usr/bin/env node
/**
 * Bundle-parity check for the settings translations.
 *
 * The convention is that every user-facing string is added to *both*
 * bundles in the same change. Nothing enforced it, so `de.json` had
 * drifted 19 keys behind `en.json` — four category descriptions, the
 * sync-interval and trash-retention value lists, and the whole
 * `serverType` group. A German user saw raw key ids in those places.
 *
 * `en.json` is the reference: it defines both the key set and the shape.
 * Any other bundle must carry exactly the same leaf keys.
 *
 * What this deliberately does NOT flag is a translation identical to its
 * English source. That is often correct — "Sync", "Labels", "Version" and
 * "WYSIWYG" are the same word in German, and entries like `"{error}"` or
 * `"{count}/{total}"` are pure placeholders with nothing to translate.
 * Flagging those would train people to ignore the check.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = join(ROOT, 'src', 'lib', 'settings', 'i18n');
const REFERENCE = 'en';

/** Every leaf key as a dotted path, e.g. `settings.editor.autoPair.label`. */
function leafKeys(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return [prefix];
  return Object.entries(value).flatMap(([k, v]) =>
    leafKeys(v, prefix ? `${prefix}.${k}` : k)
  );
}

function load(code) {
  return JSON.parse(readFileSync(join(DIR, `${code}.json`), 'utf8'));
}

const codes = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''));

if (!codes.includes(REFERENCE)) {
  console.error(`[i18n] no ${REFERENCE}.json in ${DIR}`);
  process.exit(1);
}

const reference = new Set(leafKeys(load(REFERENCE)));
let failed = false;

for (const code of codes.filter((c) => c !== REFERENCE)) {
  const keys = new Set(leafKeys(load(code)));
  const missing = [...reference].filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !reference.has(k));

  if (missing.length === 0 && extra.length === 0) {
    console.log(
      `[i18n] ${code}.json matches ${REFERENCE}.json (${keys.size} keys)`
    );
    continue;
  }

  failed = true;
  if (missing.length > 0) {
    console.error(`\n[i18n] ${code}.json is missing ${missing.length} key(s):`);
    for (const k of missing) console.error(`  - ${k}`);
  }
  if (extra.length > 0) {
    console.error(
      `\n[i18n] ${code}.json has ${extra.length} key(s) not in ${REFERENCE}.json:`
    );
    for (const k of extra) console.error(`  + ${k}`);
  }
}

if (failed) {
  console.error(
    `\nAdd the missing entries to the bundle, or remove them from ${REFERENCE}.json.` +
      '\nEvery user-facing string belongs in every bundle in the same change.'
  );
  process.exit(1);
}
