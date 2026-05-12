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
import { setLanguage } from './i18n.svelte';
import type { SortStrategy } from '$lib/sort';
import SignInForm from './customs/SignInForm.svelte';
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
  'empty-trash': () => {
    if (window.confirm('Empty the trash permanently?')) {
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
  'check-updates': () => {
    console.info('[settings] action: check-updates (stub)');
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
