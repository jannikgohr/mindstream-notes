#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** @param {unknown} value @param {string} prefix @returns {Record<string, unknown>} */
function leaves(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { [prefix]: value };
  return Object.assign(
    {},
    ...Object.entries(value).map(([key, child]) =>
      leaves(child, prefix ? `${prefix}.${key}` : key)
    )
  );
}

/** @param {string} value */
function placeholders(value) {
  return [...value.matchAll(/\{([\w]+)\}/g)]
    .map((match) => match[1])
    .sort()
    .join(',');
}

/**
 * Compare keys, interpolation variables and explicitly reviewed identical text.
 * @param {unknown} reference
 * @param {unknown} translated
 * @param {Record<string, unknown>} allowedIdentical
 */
export function compareBundles(reference, translated, allowedIdentical = {}) {
  const source = leaves(reference);
  const target = leaves(translated);
  const errors = [];
  for (const [key, value] of Object.entries(source)) {
    if (!(key in target)) {
      errors.push(`${key}: missing translation`);
      continue;
    }
    const actual = target[key];
    if (typeof value !== 'string' || typeof actual !== 'string') {
      errors.push(`${key}: translation values must be strings`);
      continue;
    }
    if (placeholders(value) !== placeholders(actual))
      errors.push(`${key}: placeholder mismatch`);
    if (actual === value && allowedIdentical[key] !== value)
      errors.push(`${key}: identical text needs review`);
  }
  for (const key of Object.keys(target))
    if (!(key in source)) errors.push(`${key}: extra translation`);
  return errors;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const dir = resolve(here, '../../src/lib/settings/i18n');
  const load = (/** @type {string} */ code) =>
    JSON.parse(readFileSync(join(dir, `${code}.json`), 'utf8'));
  const reference = load('en');
  const allowed = JSON.parse(
    readFileSync(join(here, 'i18n-identical.json'), 'utf8')
  );
  let failed = false;
  for (const file of readdirSync(dir).filter(
    (file) => file.endsWith('.json') && file !== 'en.json'
  )) {
    const code = file.slice(0, -5);
    const errors = compareBundles(reference, load(code), allowed[code]);
    for (const error of errors) console.error(`[i18n] ${code}: ${error}`);
    if (errors.length) failed = true;
    else
      console.log(
        `[i18n] ${code}: keys, placeholders and reviewed identical values match`
      );
  }
  if (failed) process.exitCode = 1;
}
