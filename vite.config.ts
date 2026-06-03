import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Tauri expects a fixed port and ignores hidden Vite cache changes.
const host = process.env.TAURI_DEV_HOST;
const packageJsonPath = fileURLToPath(new URL('package.json', import.meta.url));

export default defineConfig({
  plugins: [
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
    sourcemap: !!process.env.TAURI_ENV_DEBUG
  }
});
