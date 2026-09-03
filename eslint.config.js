import js from '@eslint/js';
import globals from 'globals';
import svelte from 'eslint-plugin-svelte';
import ts from 'typescript-eslint';
import svelteParser from 'svelte-eslint-parser';

/**
 * Flat ESLint config.
 *
 * Scope note: `svelte-check` already covers types and `prettier` covers
 * layout, so this config deliberately does not re-litigate either. What it
 * adds is the class of bug neither can see — a rejected promise nobody
 * awaits, a variable that stopped being used, a `catch` that swallows.
 *
 * `.ts` files get the type-aware ruleset (it needs the TypeScript program,
 * which is why it's scoped rather than global). `.svelte` files get the
 * syntactic rules only: type-aware linting through svelte-eslint-parser is
 * both slow and unreliable on `$state`/`$derived` runes, and the component
 * bodies are already type-checked by `pnpm check`.
 */
export default ts.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.svelte-kit/**',
      '**/build/**',
      '**/dist/**',
      '**/.output/**',
      'src-tauri/**',
      'static/**',
      'plugins/**'
    ]
  },

  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs['flat/recommended'],

  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node }
    },
    rules: {
      // Unused args are usually a signature the implementation outgrew.
      // The leading-underscore escape hatch keeps deliberate placeholders
      // (event handlers, interface conformance) quiet.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      // Already suppressed by hand in a dozen places for dynamic imports of
      // React/Excalidraw, so the rule matches intent that was already there.
      '@typescript-eslint/no-explicit-any': 'warn',

      // TypeScript resolves identifiers, including DOM lib types like
      // `ScrollBehavior` and `MutationObserverInit` that ESLint's browser
      // globals list doesn't carry. Leaving this on only produces false
      // positives on type positions. This is what typescript-eslint
      // recommends for TS sources.
      'no-undef': 'off',

      // Noisy, and both are style preferences rather than defects. Left as
      // warnings so the backlog stays visible without blocking the gate:
      // `prefer-svelte-reactivity` wants SvelteMap/SvelteSet in place of the
      // plain built-ins, and most of these are non-reactive local caches.
      'svelte/prefer-svelte-reactivity': 'warn',
      'svelte/no-unused-svelte-ignore': 'warn',
      'svelte/require-each-key': 'warn',

      // Redundant initialisers, not defects: `let tree: T[] | null = null`
      // ahead of a try/catch, `let current: number[] = []` ahead of a loop.
      // Removing them costs readability and, in the typed cases, forces a
      // definite-assignment assertion instead.
      'no-useless-assignment': 'warn',

      // SvelteKit's `resolve()` is for server-rendered routing. This app is
      // a static SPA inside a Tauri webview with a single route, so the rule
      // has nothing to protect here.
      'svelte/no-navigation-without-resolve': 'off',

      // Style preferences with real judgement behind each call site; kept
      // visible rather than blocking.
      'svelte/no-dom-manipulating': 'warn',
      'svelte/prefer-writable-derived': 'warn',
      'svelte/no-unnecessary-state-wrap': 'warn',
      'svelte/no-useless-mustaches': 'warn',

      // Every `{@html}` here renders markdown/HTML the app produced and
      // already ran through `notes-export/sanitize.ts`. Flagging them as
      // errors would only train people to disable the rule.
      'svelte/no-at-html-tags': 'warn',

      // e2e helpers rethrow with a message that names the step; the original
      // stack is already in the Playwright/WDIO report.
      'preserve-caught-error': 'warn'
    }
  },

  {
    // A sanitiser whose whole job is stripping C0 control characters, and a
    // CommonJS launcher that must stay CJS for the Playwright runner.
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' }
  },

  {
    files: ['**/*.d.ts'],
    rules: { '@typescript-eslint/triple-slash-reference': 'off' }
  },

  {
    // Svelte 5 tracks `$effect` dependencies by reading them, so a block of
    // bare identifiers is the documented way to declare what an effect
    // depends on. To this rule that's a statement with no effect.
    files: ['**/*.svelte'],
    rules: { '@typescript-eslint/no-unused-expressions': 'off' }
  },

  // Type-aware pass. This is the reason the config exists: the app fires
  // hundreds of promises with `void` and has no `unhandledrejection`
  // handler, so a rejection is a silent no-op.
  {
    // `.svelte.ts` rune modules are excluded: eslint-plugin-svelte routes
    // them through svelte-eslint-parser, which doesn't forward the
    // TypeScript program these rules need.
    files: ['src/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.svelte.ts'],
    languageOptions: {
      parser: ts.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error'
    }
  },

  // `.svelte.ts` / `.svelte.js` rune modules go through the same parser as
  // components. Without forwarding the TS parser, every type annotation in
  // them is a syntax error.
  {
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: { parser: ts.parser }
    }
  },

  {
    files: ['**/*.test.ts', 'e2e-tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // Tests deliberately pass constant falsy values to assert how a
      // helper filters them, e.g. `cn('text-sm', false && 'hidden')`.
      'no-constant-binary-expression': 'off'
    }
  }
);
