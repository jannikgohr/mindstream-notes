/**
 * Side-tables that wire schema entries to runtime state and behaviour:
 *
 *   bindings   — for settings that mirror existing app state (theme mode,
 *                sort strategy, ...). When a binding exists, the store
 *                reads/writes through it instead of the localStorage map.
 *   customs    — Svelte components rendered in place of a generic control
 *                (type='custom' with a customId).
 *   actions    — handlers for button-type settings (actionId).
 */

import type { Component } from 'svelte';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { setMode } from 'mode-watcher';
import {
  enable as enableAutostart,
  isEnabled as isEnabledAutostart,
  disable as disableAutostart
} from '@tauri-apps/plugin-autostart';
import { isTauri } from '$lib/api';
import { isMobile } from '$lib/platform';
import {
  setLeftSidebarWidth,
  setRightSidebarWidth,
  setSortStrategy,
  ui
} from '$lib/state.svelte';
import { setLanguage, tUi } from './i18n.svelte';
import type { SortStrategy } from '$lib/sort';
import SignInForm from './customs/SignInForm.svelte';
import { alert, confirm } from '$lib/components/confirm-dialog.svelte';
import {
  beginDownload,
  endProgress,
  finishDownload,
  recordChunk
} from './updater-progress.svelte';
// Vite resolves JSON imports at build time (tsconfig has resolveJsonModule),
// so the version values below get inlined into the bundle. No runtime cost,
// no risk of drift between the About panel and what's actually installed.
import pkg from '../../../package.json';

export interface Binding {
  get: () => Promise<unknown>;
  set: (value: unknown) => Promise<void>;
}

/**
 * Autostart is a desktop-only Tauri plugin (see Cargo.toml's cfg-gated
 * dep). Outside Tauri — `vite preview` in a plain browser, or the
 * Android build — the plugin's invoke() crashes because
 * window.__TAURI_INTERNALS__ doesn't exist (or doesn't carry the
 * autostart command). Report 'false' / no-op instead of throwing so
 * the settings dialog hydrates cleanly.
 */
const autostartAvailable = () => isTauri() && !isMobile();

export const SETTING_BINDINGS: Record<string, Binding> = {
  'general.startOnLogin': {
    get: async () => (autostartAvailable() ? await isEnabledAutostart() : false),
    set: async (v) => {
      if (!autostartAvailable()) return;
      if (v) await enableAutostart();
      else await disableAutostart();
    }
  },
  'appearance.mode': {
    get: async () => {
      // mode-watcher writes/reads from localStorage; mirror its key here so
      // the radio reflects whatever the user's last choice was.
      if (typeof localStorage === 'undefined') return 'system';
      return localStorage.getItem('mode-watcher-mode') ?? 'system';
    },
    set: async (v) => setMode(v as 'light' | 'dark' | 'system')
  },
  'appearance.sortStrategy': {
    get: async () => ui.sortStrategy,
    set: async (v) => setSortStrategy(v as SortStrategy)
  },
  // The width sliders aren't in the schema yet, but the bindings are ready
  // when someone wants to surface them.
  'appearance.leftSidebarWidth': {
    get: async () => ui.leftSidebarWidth,
    set: async (v) => setLeftSidebarWidth(Number(v))
  },
  'appearance.rightSidebarWidth': {
    get: async () => ui.rightSidebarWidth,
    set: async (v) => setRightSidebarWidth(Number(v))
  },
  'language.code': {
    get: async () => {
      if (typeof localStorage === 'undefined') return 'en';
      return localStorage.getItem('notes-app:language') ?? 'en';
    },
    set: async (v) => {
      const code = String(v);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('notes-app:language', code);
      }
      setLanguage(code);
    }
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = Component<any>;

/** Components rendered in place of a generic control. */
export const CUSTOM_COMPONENTS: Record<string, AnyComponent> = {
  'sign-in-form': SignInForm as unknown as AnyComponent
};

/** Handlers for button-type settings. */
export const SETTING_ACTIONS: Record<string, () => void | Promise<void>> = {
  'open-data-folder': () => {
    console.info('[settings] action: open-data-folder (stub)');
  },
  'empty-trash': async () => {
    // `confirm` is imported statically from confirm-dialog.svelte.ts —
    // that .ts file doesn't touch bits-ui, so the original dynamic-import
    // workaround (keeping the bits-ui re-export chain out of this
    // module's static graph) is no longer needed.
    if (
      await confirm({
        title: 'Empty trash',
        message:
          'Every item currently in the trash will be removed permanently. This cannot be undone.',
        confirmLabel: 'Empty trash',
        destructive: true
      })
    ) {
      console.info('[settings] action: empty-trash (stub)');
    }
  },
  'backup-now': () => {
    console.info('[settings] action: backup-now (stub)');
  },
  'export-vault': () => {
    console.info('[settings] action: export-vault (stub)');
  },
  'import-notes': () => {
    console.info('[settings] action: import-notes (stub)');
  },
  'clear-cache': () => {
    console.info('[settings] action: clear-cache (stub)');
  },
  'check-updates': async () => {
    // The update flow is three confirm() gates so the user always knows
    // what's about to happen:
    //
    //   1. After check()       — "v0.1.5 available, install now?"
    //   2. After download      — "Update ready. Restart now?"
    //
    // Without #1, the NSIS installer dialog (even in `passive` mode)
    // appears with no JS-side warning and reads as a scary OS prompt
    // out of nowhere. Without #2, the app vanishes mid-session because
    // relaunch() takes effect immediately.
    //
    // The Windows installer's "do you want to uninstall this app"
    // wording (which was what surprised you on the first release) is
    // suppressed at the system level by `plugins.updater.windows.installMode
    // = "passive"` in tauri.conf.json. Passive mode shows a small
    // progress bar but no buttons — the install proceeds without user
    // interaction. The change here is purely about *our* messaging
    // around it.

    let update;
    try {
      update = await check();
    } catch (err) {
      console.error('[updater] check failed', err);
      await alert({
        title: tUi('updater.checkFailed.title'),
        message: tUi('updater.checkFailed.message'),
        confirmLabel: tUi('updater.dismiss')
      });
      return;
    }

    if (!update) {
      await alert({
        title: tUi('updater.upToDate.title'),
        message: tUi('updater.upToDate.message').replace(
          '{version}',
          pkg.version
        ),
        confirmLabel: tUi('updater.dismiss')
      });
      return;
    }

    console.info(
      `[updater] available: ${update.version} (current ${pkg.version})`
    );

    const installNow = await confirm({
      title: tUi('updater.available.title'),
      message: tUi('updater.available.message')
        .replace('{from}', pkg.version)
        .replace('{to}', update.version),
      confirmLabel: tUi('updater.install'),
      cancelLabel: tUi('updater.later')
    });
    if (!installNow) return;

    // Push events into the shared progress state (throttling lives in
    // recordChunk so callbacks here stay one-liners). `endProgress()`
    // runs in `finally` so the blocking progress dialog can't get
    // stuck open if downloadAndInstall throws mid-download.
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            beginDownload(event.data.contentLength ?? 0);
            console.info(
              `[updater] downloading ${event.data.contentLength ?? '?'} bytes`
            );
            break;
          case 'Progress':
            recordChunk(event.data.chunkLength);
            break;
          case 'Finished':
            finishDownload();
            console.info('[updater] download finished, installing');
            break;
        }
      });
    } catch (err) {
      console.error('[updater] install failed', err);
      await alert({
        title: tUi('updater.installFailed.title'),
        message: tUi('updater.installFailed.message'),
        confirmLabel: tUi('updater.dismiss')
      });
      return;
    } finally {
      endProgress();
    }

    const restartNow = await confirm({
      title: tUi('updater.ready.title'),
      message: tUi('updater.ready.message'),
      confirmLabel: tUi('updater.restart'),
      cancelLabel: tUi('updater.later')
    });
    if (restartNow) await relaunch();
    // If the user declined, the new bits are already on disk — the
    // next launch (manual quit + reopen) picks them up. No further
    // action needed here.
  }
};

/**
 * Strip the semver range marker from a `^x.y.z` / `~x.y.z` style spec so
 * we display a clean version string in the UI. Falls back to `'unknown'`
 * if the dependency isn't listed (e.g. a stripped-down build).
 */
function depVersion(name: string): string {
  const deps = (pkg as { dependencies?: Record<string, string> }).dependencies;
  const devDeps = (pkg as { devDependencies?: Record<string, string> })
    .devDependencies;
  const raw = deps?.[name] ?? devDeps?.[name];
  if (!raw) return 'unknown';
  return raw.replace(/^[\^~>=<\s]+/, '');
}

/** Read-only display values for type='info' settings. */
export const INFO_VALUES: Record<string, () => string> = {
  'about.appVersion': () => pkg.version,
  'about.tauriVersion': () =>
    [
      `Tauri ${depVersion('@tauri-apps/api')}`,
      `SvelteKit ${depVersion('@sveltejs/kit')}`,
      `Svelte ${depVersion('svelte')}`,
      `Milkdown Crepe ${depVersion('@milkdown/crepe')}`,
      `dockview ${depVersion('dockview-core')}`
    ].join(' · ')
};
