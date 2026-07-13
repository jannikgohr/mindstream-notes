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
      '$lib/*': path.resolve('./src/lib/*'),
      // SvelteKit's `$app/*` virtual modules don't exist under the plain
      // Svelte plugin vitest uses, so any source importing them fails to
      // resolve at transform time. Point them at test stubs; tests that
      // care about the calls override with `vi.mock`.
      '$app/navigation': path.resolve('./test/stubs/app-navigation.ts')
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
    globals: false,
    coverage: {
      provider: 'v8',
      // text for the local terminal summary, json-summary + lcov for CI
      // (lcov feeds coverage services; json-summary drives the PR comment).
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: './.output/coverage/frontend',
      include: ['src/**/*.ts'],
      // The unit-coverage metric measures the *logic* layer. Three classes
      // of code are deliberately out of scope here because they're proven by
      // end-to-end tests instead of unit tests (see e2e/ and docs/e2e-flows.md):
      //
      //   1. UI components (*.svelte) — rendered and driven by Playwright.
      //   2. Tauri IPC wrappers (api/* thin `invoke` shells, window/system/
      //      asset bridges) — the IPC round-trip is an integration concern;
      //      their browser-fallback behaviour is already exercised through
      //      the mock store + e2e.
      //   3. Editor / canvas / collab framework glue (Milkdown & ProseMirror
      //      plugins, Excalidraw, Yjs collab providers, Dockview actions) —
      //      these only have meaning attached to a live editor/document and
      //      are covered by e2e.
      //
      // Everything with standalone, branching logic stays in scope and is
      // unit-tested.
      exclude: [
        'src/**/*.{test,spec}.ts',
        'src/**/*.d.ts',
        'src/**/index.ts',
        'src/app.d.ts',
        'src/routes/**',
        'src/**/*.stories.*',

        // 1. UI components are e2e-covered.
        'src/**/*.svelte',

        // 2. Tauri IPC wrappers + native bridges.
        'src/lib/api/window.ts',
        'src/lib/api/drawing.ts',
        'src/lib/api/data.ts',
        'src/lib/api/events.ts',
        'src/lib/api/signatures.ts',
        'src/lib/api/layout.ts',
        'src/lib/api/pdf-export.ts',
        'src/lib/api/desktop-settings.ts',
        'src/lib/api/hotkeys.ts',
        'src/lib/api/assets.ts',
        'src/lib/api/sync.ts',
        'src/lib/api/system.ts',
        'src/lib/api/notes-export.ts',
        'src/lib/api/auth.svelte.ts',
        'src/lib/api/collections.ts',
        'src/lib/assets/bridge.ts',
        'src/lib/native-menu.svelte.ts',
        'src/lib/window/decorations.svelte.ts',
        'src/lib/window/fullscreen.ts',
        'src/lib/tauri.ts',
        'src/hooks.client.ts',
        'src/lib/mocks.ts',

        // 3. Editor / canvas / collab framework glue.
        'src/lib/editor/plugins/**',
        'src/lib/editor/crepe-setup.ts',
        'src/lib/freeform/**',
        'src/lib/sync/collab-provider.ts',
        'src/lib/sync/ink-web-collab-provider.ts',
        'src/lib/ink/editor-helpers.ts',
        'src/lib/desktop/**',
        'src/lib/actions/tooltip.ts',
        'src/lib/components/note-editor/lazy-components.ts',

        // pdf-lib / pdf.js rendering pipelines — heavy binary I/O, e2e-only.
        'src/lib/notes-export/ink-pdf.ts',
        'src/lib/note-exporters/pdf.ts',
        'src/lib/pdf/extract-text.ts',

        // Camera/canvas plumbing for the signature photo import: every
        // function is a thin wrapper over getUserMedia, createImageBitmap,
        // or 2D-canvas APIs that don't rasterise under happy-dom. All
        // decisions live in the pure, unit-tested modules it delegates to
        // (signature-trace, signature-image-render, paper-detect).
        'src/lib/pdf/signature-import-image.ts',

        // Pure presentation data (icon maps, tailwind-variants, type tables).
        'src/lib/settings/icons.ts',
        'src/lib/components/ui/**',

        // Type-only modules (interfaces / unions, no runtime code — v8
        // miscounts their declaration bodies as uncovered statements).
        'src/lib/settings/types.ts',
        'src/lib/hotkeys/types.ts',
        'src/lib/notifications/types.ts',
        'src/lib/note-exporters/types.ts',
        'src/lib/components/context-menu-types.ts',

        // Data-section action orchestration: every handler is a sequence of
        // Tauri IPC calls + picker/confirm/toast choreography (backup,
        // restore, export, import). That whole chain is an e2e concern
        // (IPC-heavy critical journeys), not a unit one.
        'src/lib/settings/actions/data.ts'
      ],
      thresholds: {
        statements: 80,
        functions: 80,
        lines: 80,
        // Branch coverage is held a notch lower: a lot of the remaining
        // branches are defensive `?? fallback` guards on optional fields
        // that aren't worth synthesising every permutation for.
        branches: 75
      }
    }
  }
});
