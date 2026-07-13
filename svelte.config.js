import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * SvelteKit configured as a single-page app (SPA) for Tauri.
 * adapter-static with a fallback page makes the whole app client-rendered;
 * SSR is disabled so dockview / Milkdown / Tauri APIs (browser-only) just work.
 *
 * @type {import('@sveltejs/kit').Config}
 */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      pages: '.output/build',
      assets: '.output/build',
      fallback: 'index.html',
      precompress: false,
      strict: true
    }),
    outDir: '.output/svelte-kit',
    alias: {
      $lib: 'src/lib',
      '$lib/*': 'src/lib/*'
    },
    typescript: {
      /*
       * Pull our .tsx files (the React/Excalidraw island under
       * src/lib/freeform/) into SvelteKit's generated
       * .output/svelte-kit/tsconfig.json. The default include globs
       * only `*.js`, `*.ts`, and `*.svelte`, so without this hook
       * editors (WebStorm, VS Code) report
       *   "File is not included in any tsconfig.json"
       * and the `$lib` path alias fails to resolve inside the .tsx —
       * svelte-check still passes because it walks files directly,
       * but the IDE relies strictly on `include`.
       *
       * Mutating the passed-in config is the supported way to
       * augment SvelteKit's generated tsconfig — the change survives
       * regeneration. Mirror existing patterns so we don't drop
       * .svelte / .ts coverage.
       */
      config: (cfg) => {
        const tsxGlob = '../../src/**/*.tsx';
        if (Array.isArray(cfg.include) && !cfg.include.includes(tsxGlob)) {
          cfg.include.push(tsxGlob);
        }
        return cfg;
      }
    }
  }
};

export default config;
