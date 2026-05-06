import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Vitest config kept separate from vite.config.ts because vitest pulls in
 * its own vite as a sub-dependency, and mixing the two surfaces type-class
 * conflicts (two different Vite Plugin types). Vitest reads vitest.config.ts
 * automatically when present.
 */
export default defineConfig({
  // @ts-ignore
  plugins: [svelte({ hot: false })],
  resolve: {
    alias: {
      $lib: path.resolve('./src/lib'),
      '$lib/*': path.resolve('./src/lib/*')
    },
    // Some Svelte ecosystem packages (e.g. `mode-watcher`) only declare a
    // `svelte` export condition — no `import`/`default` fallback. Vitest's
    // resolver doesn't include `svelte` in its defaults, so without this
    // it errors with "No known conditions for '.' specifier in
    // <package>". List the standard ones too because supplying this key
    // replaces vite's defaults rather than extending them.
    conditions: ['svelte', 'module', 'browser', 'development']
  },
  ssr: {
    // The same packages also need to resolve through the SSR pipeline that
    // vitest uses for module loading.
    resolve: {
      conditions: ['svelte', 'module', 'browser', 'development']
    }
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.{test,spec}.ts'],
    globals: false
  }
});
