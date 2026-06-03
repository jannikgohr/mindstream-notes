import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * Drop warnings we've decided are noise. We can't use
 * `build.rollupOptions.onwarn` here because @sveltejs/kit overwrites it
 * with its own handler — but plugin-level `onLog` runs before that and
 * Rollup respects a falsy return as "suppress this log entirely".
 *
 *   INVALID_ANNOTATION in node_modules: bits-ui's nested `runed` ships
 *   `/* #__PURE__ *\/` annotations Rollup can't parse from those
 *   positions; not our bug, can't fix at the source.
 *
 *   UNUSED_EXTERNAL_IMPORT for listenerCtx: false positive — the symbol
 *   IS used at runtime inside an $effect body in EditorToolbar.svelte,
 *   but Svelte 5's compiler output hides it from Rollup's tree-shake
 *   analysis.
 */
function silenceUpstreamWarnings(): Plugin {
  return {
    name: 'silence-upstream-warnings',
    enforce: 'pre',
    onLog(level, log) {
      if (level !== 'warn') return;
      const filePath = log.id ?? log.loc?.file ?? '';
      if (
        log.code === 'INVALID_ANNOTATION' &&
        filePath.includes('node_modules')
      ) {
        return false;
      }
      if (
        log.code === 'UNUSED_EXTERNAL_IMPORT' &&
        typeof log.message === 'string' &&
        log.message.includes('listenerCtx')
      ) {
        return false;
      }
    }
  };
}

// Tauri expects a fixed port and ignores hidden Vite cache changes.
const host = process.env.TAURI_DEV_HOST;
const packageJsonPath = fileURLToPath(new URL('package.json', import.meta.url));

export default defineConfig({
  plugins: [
    silenceUpstreamWarnings(),
    tailwindcss(),
    sveltekit(),
    // React JSX transform — scoped to .tsx files so it doesn't touch
    // .ts / .svelte (which are owned by SvelteKit's pipeline). The only
    // React in the app today is the tldraw island under src/lib/freeform/
    // (lazy-loaded when a drawing note is opened); leaving the include
    // narrow keeps the markdown editor and the rest of the SPA on the
    // Svelte-only path.
    react({ include: /\.tsx$/ })
  ],

  // Vite options tailored for Tauri development.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421
        }
      : undefined,
    // Don't watch src-tauri to avoid full-reload loops.
    watch: {
      ignored: ['**/src-tauri/**']
    },
    fs: {
      allow: [packageJsonPath]
    }
  },

  // Make Tauri's env vars visible to the frontend.
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target:
      process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // Editor (Crepe/ProseMirror), tldraw, pdfjs and pdf-lib chunks are
    // legitimately heavy. We're a desktop app loading from local disk,
    // so further splitting wouldn't change UX. Bumped from the default
    // 500 kB so the warning still fires for genuinely surprising bloat.
    chunkSizeWarningLimit: 2000
  }
});
