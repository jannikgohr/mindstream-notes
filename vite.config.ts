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
    // React in the app today is the Excalidraw island under src/lib/freeform/
    // (lazy-loaded when a drawing note is opened); leaving the include
    // narrow keeps the markdown editor and the rest of the SPA on the
    // Svelte-only path.
    react({ include: /\.tsx$/ })
  ],

  resolve: {
    // `@milkdown/plugin-diff` pins its `@milkdown/*` deps to 7.21.x, which pnpm
    // installs nested alongside the editor's 7.20.x. Two copies of @milkdown/ctx
    // / core mean two ProseMirror-plugin/context identities, so the diff plugin
    // wouldn't share the editor's context. Force a single instance of each so
    // the plugin runs against the same context the editor uses.
    dedupe: [
      '@milkdown/ctx',
      '@milkdown/core',
      '@milkdown/utils',
      '@milkdown/transformer',
      '@milkdown/prose'
    ]
  },

  // Pre-bundle deps Vite would otherwise discover mid-session. It doesn't
  // follow every `import()` (lazy note editors, PDF viewer, Excalidraw,
  // dockview) or the Tauri-only API modules, so it finds them as features
  // activate and reloads the page to re-optimise. On the Android WebView
  // that reload aborts in-flight dynamic imports and white-screens; listing
  // them here folds everything into the first pass. Keep in sync as new
  // heavy / `import()`ed deps are added.
  optimizeDeps: {
    include: [
      // Markdown editor — lazy via components/note-editor/lazy-components.ts
      '@milkdown/crepe',
      '@milkdown/plugin-collab',
      '@milkdown/plugin-diff',
      '@milkdown/kit/core',
      '@milkdown/kit/utils',
      '@milkdown/kit/plugin/listener',
      '@milkdown/kit/plugin/history',
      '@milkdown/kit/preset/commonmark',
      '@milkdown/kit/preset/gfm',
      '@milkdown/kit/component/image-block',
      '@milkdown/kit/prose/commands',
      '@milkdown/kit/prose/history',
      '@milkdown/kit/prose/model',
      '@milkdown/kit/prose/state',
      '@milkdown/kit/prose/view',
      '@codemirror/language',
      'mermaid',
      // Raw-markdown Source editor (CodeMirror 6) — reached through the lazy
      // note editor via editor/source/SourceEditor.svelte, so Vite only
      // discovers these once a note is opened in Source/Split.
      '@codemirror/state',
      '@codemirror/view',
      '@codemirror/commands',
      '@codemirror/lang-markdown',
      '@lezer/highlight',
      // Collab sync — Yjs doc + awareness + transport
      'yjs',
      'y-protocols/awareness',
      // y-prosemirror: the sync binding's position mapping is read directly by
      // editor/source/source-presence.ts to place peer markers.
      'y-prosemirror',
      'socket.io-client',
      // PDF viewing + export — lazy via pdf/*.ts and notes-export/*
      'pdfjs-dist',
      'pdfjs-dist/web/pdf_viewer.mjs',
      'pdf-lib',
      // Excalidraw freeform island + ink/drawing — lazy via *NoteEditor.svelte
      'react',
      'react-dom',
      'react-dom/client',
      '@excalidraw/excalidraw',
      'perfect-freehand',
      'image-js',
      // Desktop dockview shell — lazy via DesktopLayout.svelte
      'dockview-core',
      // Tauri API + plugins — dynamically imported, so only loaded under Tauri
      '@tauri-apps/api/core',
      '@tauri-apps/api/event',
      '@tauri-apps/api/window',
      '@tauri-apps/api/webviewWindow',
      '@tauri-apps/plugin-autostart',
      '@tauri-apps/plugin-process',
      '@tauri-apps/plugin-updater',
      '@tauri-apps/plugin-shell',
      // Core UI libs — pulled in across the shell; list them so they land in
      // the first pass instead of trickling in over the first few reloads.
      '@lucide/svelte',
      '@jis3r/icons',
      'bits-ui',
      '@floating-ui/dom',
      'mode-watcher',
      'tailwind-merge',
      'tailwind-variants'
    ]
  },

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
    // Editor (Crepe/ProseMirror), Excalidraw, pdfjs and pdf-lib chunks are
    // legitimately heavy. We're a desktop app loading from local disk,
    // so further splitting wouldn't change UX. Bumped from the default
    // 500 kB so the warning still fires for genuinely surprising bloat.
    chunkSizeWarningLimit: 2000
  }
});
