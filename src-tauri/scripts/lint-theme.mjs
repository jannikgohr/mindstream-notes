/**
 * Theme guardrail.
 *
 * The app's colour comes from the tokens in src/app.css (see docs/theming.md).
 * This check keeps ad-hoc colour from creeping back in, which is how the
 * sidebars, the Kanban board and the dockview chrome each ended up with their
 * own palette in the first place.
 *
 * Three rules:
 *
 *   palette   No raw Tailwind palette colour utilities (bg-emerald-500,
 *             text-amber-700, border-sky-500/30, …). Use a token: a surface
 *             step, the status ramp, or --accent-brand.
 *
 *   dark      No `dark:` colour variants. The tokens already carry both
 *             themes, so a dark: colour means a token is missing or the wrong
 *             one is in use.
 *
 *   literal   No hex/rgb/hsl literal as the value of a colour-bearing CSS
 *             property inside a <style> block or stylesheet.
 *
 * Deliberately NOT covered:
 *
 *   - src/app.css and src/app.html, which are the token layer itself and the
 *     pre-paint bootstrap that has to inline its values.
 *   - Shadows. --elevation-raised / --elevation-overlay cover the common
 *     cases, but a directional shadow (a bottom sheet lifting off the bottom
 *     edge) is geometry as much as colour and is spelled out locally.
 *   - Canvas 2D painting (ctx.fillStyle / strokeStyle) and colour-input
 *     values. A canvas takes a resolved colour string, not a var().
 *
 * Usage: node src-tauri/scripts/lint-theme.mjs [files…]
 * With no arguments it scans all of src/.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { relative, resolve } from 'node:path';

const EXEMPT = new Set(['src/app.css', 'src/app.html']);

/**
 * lint-staged hands us absolute paths while `git ls-files` gives repo-relative
 * ones, so normalise before comparing against EXEMPT — otherwise the token
 * layer itself gets linted, and app.css names palette utilities in its own
 * comments while explaining what not to use.
 */
function toRepoPath(file) {
  return relative(process.cwd(), resolve(file)).replace(/\\/g, '/');
}

/**
 * Blank out comments so a rule can't fire on prose. Both the token layer and
 * this project's CSS explain themselves by naming the things they replaced,
 * and a comment saying "not bg-emerald-500" must not read as a violation.
 *
 * Newlines inside a comment are kept so reported line numbers still match the
 * file on disk.
 */
function stripComments(text) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + blank(m.slice(p.length)));
}

const PALETTE_HUES = [
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose'
].join('|');

const COLOUR_UTILITIES =
  'bg|text|border|ring|from|via|to|fill|stroke|decoration|outline|caret|divide|placeholder|accent';

const RULES = [
  {
    id: 'palette',
    // e.g. bg-emerald-500, text-amber-700, border-sky-500/30
    re: new RegExp(
      `\\b(?:${COLOUR_UTILITIES})-(?:${PALETTE_HUES})-\\d{2,3}(?:\\/\\d{1,3})?\\b`,
      'g'
    ),
    hint: 'use a token (surface step, status ramp, or --accent-brand)'
  },
  {
    id: 'dark',
    // e.g. dark:text-emerald-400, dark:bg-card
    re: new RegExp(`\\bdark:(?:${COLOUR_UTILITIES})-`, 'g'),
    hint: 'tokens already swap per theme; drop the dark: variant'
  },
  {
    id: 'literal',
    // e.g. `background: #fff;`, `color: rgb(1 2 3);` — but not box-shadow,
    // and not a literal used as a var() fallback, which is the documented
    // pattern for anything painting before app.css has loaded.
    re: /(?:^|[;{\s])(background|background-color|color|border-color|fill|stroke|outline-color|text-decoration-color)\s*:\s*(?![^;{}]*\bvar\()[^;{}]*?(#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\()/g,
    hint: 'use a var(--token) instead of a colour literal'
  }
];

function targets() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (args.length) return args.map((f) => f.replace(/\\/g, '/'));
  return execSync(
    'git ls-files "src/**/*.svelte" "src/**/*.css" "src/**/*.ts"',
    {
      encoding: 'utf8'
    }
  )
    .split('\n')
    .filter(Boolean);
}

const problems = [];

for (const file of targets()) {
  const rel = toRepoPath(file);
  if (EXEMPT.has(rel)) continue;
  if (!/\.(svelte|css|ts)$/.test(rel)) continue;

  let raw;
  try {
    raw = readFileSync(rel, 'utf8');
  } catch {
    continue; // deleted in this commit
  }
  const text = stripComments(raw);

  // The `literal` rule only applies to actual stylesheet text, so on .svelte
  // files it is scoped to <style> blocks — otherwise every ctx.fillStyle and
  // colour-picker default in the file would trip it.
  const styleOnly = rel.endsWith('.css')
    ? text
    : [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
        .map((m) => m[1])
        .join('\n');

  for (const rule of RULES) {
    const haystack = rule.id === 'literal' ? styleOnly : text;
    if (!haystack) continue;
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(haystack))) {
      // Line numbers are only meaningful for whole-file rules; for the
      // style-scoped rule, point at the file and show the match.
      const line =
        rule.id === 'literal'
          ? null
          : haystack.slice(0, m.index).split('\n').length;
      problems.push({
        file: rel,
        line,
        rule: rule.id,
        match: m[0].trim().replace(/\s+/g, ' '),
        hint: rule.hint
      });
    }
  }
}

if (problems.length) {
  console.error(
    `\ntheme lint: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n`
  );
  for (const p of problems) {
    const where = p.line ? `${p.file}:${p.line}` : p.file;
    console.error(`  ${where}\n    [${p.rule}] ${p.match}\n    → ${p.hint}\n`);
  }
  console.error('See docs/theming.md for the token reference.\n');
  process.exit(1);
}

console.log('theme lint: no raw colour found');
