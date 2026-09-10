import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import picomatch from 'picomatch';
import {
  CODE_FILES,
  DOCS_ONLY,
  filterPatterns,
  readWorkflow,
  repoRoot
} from './lint-ci-filters.mjs';

const workflow = readWorkflow();
const code = filterPatterns(workflow, 'code');
// paths-filter matches with picomatch and dotfiles enabled.
const selectsCodeJobs = picomatch(code, { dot: true });

test('a negated filter is a single pattern', () => {
  // paths-filter OR-s a filter's patterns, so two negations can never both
  // hold: `!**/*.md` plus `!docs/**` matches every non-docs Markdown file.
  const negated = code.filter((pattern) => pattern.startsWith('!'));
  assert.ok(
    negated.length === 0 || code.length === 1,
    `the \`code\` filter mixes a negation with other patterns (${code.join(', ')}); ` +
      'OR-ed negations disable the gate — use one negated group'
  );
});

test('markdown-only changes do not select the code jobs', () => {
  for (const file of DOCS_ONLY) {
    assert.equal(
      selectsCodeJobs(file),
      false,
      `${file} would run the whole matrix`
    );
  }
});

test('a root-level markdown file counts as markdown', () => {
  // `**/` does not match an empty path segment, so `!(**/*.md)` on its own
  // still selects README.md. This is the assertion that caught it.
  assert.equal(selectsCodeJobs('README.md'), false);
  assert.equal(selectsCodeJobs('docs/nested/deep/note.md'), false);
});

test('everything else selects the code jobs', () => {
  for (const file of CODE_FILES) {
    assert.equal(selectsCodeJobs(file), true, `${file} would be skipped`);
  }
});

test('every collaboration pattern matches something in the tree', () => {
  // An entry pointing at a moved, renamed or deleted path stops selecting the
  // two-client suites, and nothing says so. Checked against the real file list
  // rather than a prefix, so a renamed spec is caught too.
  const tracked = execFileSync('git', ['ls-files'], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
    .split(/\r?\n/)
    .filter(Boolean);

  for (const pattern of filterPatterns(workflow, 'collab')) {
    const matches = picomatch(pattern, { dot: true });
    assert.ok(
      tracked.some((file) => matches(file)),
      `the \`collab\` filter's \`${pattern}\` matches no tracked file`
    );
  }
});
