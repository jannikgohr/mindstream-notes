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
 * Type-aware async rules cover TypeScript, rune modules and Svelte components.
 */
// Fixes to library internals belong in a versioned dependency patch.
const BITS_UI_INTERNALS = {
  group: ['bits-ui/*'],
  message:
    'Use the public bits-ui entry point; keep internal fixes in patches/.'
};

// Storage writes go through the vault access gate (src/lib/storage). A tab
// that does not own its vault must not write state other windows read.
const STORAGE_WRITE = 'Write app state through $lib/storage/app-storage.';
const DIRECT_STORAGE_WRITES = ['setItem', 'removeItem', 'clear'].map(
  (property) => ({ object: 'localStorage', property, message: STORAGE_WRITE })
);
const RAW_TAURI_INVOKE = {
  name: '@tauri-apps/api/core',
  importNames: ['invoke'],
  message:
    'Call invokeTauri or invokeOrFallback from $lib/api/core, which wait for the vault access gate.'
};

export default ts.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.svelte-kit/**',
      '**/build/**',
      '**/dist/**',
      '**/.output/**',
      'plugin-sdk/**/target/**',
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

      'no-restricted-imports': ['error', { patterns: [BITS_UI_INTERNALS] }],

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

  // Forward the same TypeScript project through both parsers.
  {
    files: ['src/**/*.ts', 'src/**/*.svelte'],
    ignores: ['**/*.test.ts'],
    languageOptions: {
      parser: ts.parser,
      parserOptions: {
        projectService: true,
        extraFileExtensions: ['.svelte'],
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
    files: ['src/**/*.ts', 'src/**/*.svelte'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-properties': ['error', ...DIRECT_STORAGE_WRITES],
      'no-restricted-imports': [
        'error',
        { paths: [RAW_TAURI_INVOKE], patterns: [BITS_UI_INTERNALS] }
      ]
    }
  },

  {
    // The gate's own modules, and the writers that must work without a vault:
    // draft recovery keeps typing safe when the vault connection is lost, the
    // vault picker window has no vault, the error reporter only reports, and
    // the e2e mock store stands in for the backend.
    files: [
      'src/lib/storage/app-storage.ts',
      'src/lib/api/core.ts',
      'src/lib/browser/recovery.ts',
      'src/routes/vault-picker/+page.svelte',
      'src/lib/runtime-errors.ts',
      'src/lib/api/mock-store.ts'
    ],
    rules: {
      'no-restricted-properties': 'off',
      'no-restricted-imports': ['error', { patterns: [BITS_UI_INTERNALS] }]
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
