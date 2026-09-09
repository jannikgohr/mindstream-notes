/**
 * Guard for the path filters that decide which CI jobs run.
 *
 * These globs are load-bearing and quietly easy to get wrong: a mistake makes
 * CI skip jobs it should have run, and nothing fails — you just stop being
 * told about regressions. Two traps in particular were live during review:
 *
 *   - `dorny/paths-filter` OR-s the patterns in a filter, so `!**\/*.md` plus
 *     `!docs/**` matches every non-docs Markdown file and disables the gate.
 *     A negated filter has to be a single group.
 *   - `!(**\/*.md|*.md)` needs both spellings: `**\/` does not match an empty
 *     path segment, so `!(**\/*.md)` alone still selects a root-level
 *     `README.md`.
 *
 * So the assertions run against picomatch — the matcher paths-filter itself
 * uses — rather than against anyone's reading of the pattern.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..'
);
export const workflowPath = join(repoRoot, '.github', 'workflows', 'test.yml');

/**
 * Pull one filter's patterns out of the workflow's inline `filters:` block.
 *
 * Deliberately a text scrape rather than a YAML parse: it keeps the guard
 * dependency-free, and if the workflow's shape changes enough to break this,
 * that is worth a loud failure rather than a silently empty pattern list.
 */
export function filterPatterns(workflow, name) {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `${name}:`);
  if (start === -1) {
    throw new Error(
      `no \`${name}:\` filter in .github/workflows/test.yml — did the workflow change shape?`
    );
  }
  const patterns = [];
  for (const line of lines.slice(start + 1)) {
    const text = line.trim();
    if (text.startsWith('#') || text === '') continue;
    const match = /^-\s*'(.+)'$/.exec(text);
    if (!match) break;
    patterns.push(match[1]);
  }
  if (patterns.length === 0) {
    throw new Error(`the \`${name}:\` filter lists no patterns`);
  }
  return patterns;
}

/** Files that must never, on their own, be worth a full CI run. */
export const DOCS_ONLY = [
  'README.md',
  'CLAUDE.md',
  'docs/audit-2026-09.md',
  'docs/e2e/harness.md'
];

/** Files that must always select the code jobs. */
export const CODE_FILES = [
  'src/lib/components/FileExplorer.svelte',
  'src-tauri/src/tree.rs',
  'e2e-tests/app/specs/multi/collab.e2e.ts',
  '.github/workflows/test.yml',
  'package.json',
  'pnpm-lock.yaml',
  'LICENSE',
  '.config/prettier/.prettierrc.json'
];

export function readWorkflow() {
  return readFileSync(workflowPath, 'utf8');
}
