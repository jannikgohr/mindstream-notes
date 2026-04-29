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
  plugins: [svelte({ hot: false })],
  resolve: {
    alias: {
      $lib: path.resolve('./src/lib'),
      '$lib/*': path.resolve('./src/lib/*')
    }
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.{test,spec}.ts'],
    globals: false
  }
});
