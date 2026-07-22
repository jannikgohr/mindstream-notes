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
import type * as autostartPlugin from '@tauri-apps/plugin-autostart';
import {
  getCloseToTray,
  getCustomWindowDecorations,
  getDesktopLanguage,
  getDesktopThemeMode,
  getStartInTray,
  isDesktopThemeMode,
  setCloseToTray,
  setCustomWindowDecorations,
  setDesktopLanguage,
  setDesktopThemeMode,
  setStartInTray
} from '$lib/api/desktop-settings';
import { isTauri } from '$lib/api/core';
import { splitAvailable } from '$lib/editor/source/split-available.svelte';
import { getPlatform, isMobile } from '$lib/platform';
import {
  setLeftSidebarWidth,
  setRightSidebarWidth,
  setSortStrategy,
  ui
} from '$lib/state.svelte';
import { setLanguage, tUi } from './i18n.svelte';
import type { SortStrategy } from '$lib/sort';
// Vite resolves JSON imports at build time (tsconfig has resolveJsonModule),
// so the version values below get inlined into the bundle. No runtime cost,
// no risk of drift between the About panel and what's actually installed.
import pkg from '../../../package.json';

export interface Binding {
  get: () => Promise<unknown>;
  set: (value: unknown) => Promise<void>;
  hydrate?: 'startup' | 'on-demand';
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

function loadAutostart(): Promise<typeof autostartPlugin> {
  return import('@tauri-apps/plugin-autostart');
}

export const SETTING_BINDINGS: Record<string, Binding> = {
  'general.startOnLogin': {
    hydrate: 'on-demand',
    get: async () => {
      if (!autostartAvailable()) return false;
      const { isEnabled } = await loadAutostart();
      return await isEnabled();
    },
    set: async (v) => {
      if (!autostartAvailable()) return;
      const { enable, disable } = await loadAutostart();
      if (v) await enable();
      else await disable();
    }
  },
  'general.closeToTray': {
    get: async () =>
      isTauri() && !isMobile() ? await getCloseToTray() : false,
    set: async (v) => {
      if (!isTauri() || isMobile()) return;
      await setCloseToTray(v === true);
    }
  },
  'general.startInTray': {
    get: async () =>
      isTauri() && !isMobile() ? await getStartInTray() : false,
    set: async (v) => {
      if (!isTauri() || isMobile()) return;
      await setStartInTray(v === true);
      const { isEnabled, enable, disable } = await loadAutostart();
      if (await isEnabled()) {
        await disable();
        await enable();
      }
    }
  },
  'appearance.customWindowDecorations': {
    get: async () =>
      isTauri() && !isMobile()
        ? await getCustomWindowDecorations()
        : getPlatform() !== 'macos',
    set: async (v) => {
      if (!isTauri() || isMobile()) return;
      await setCustomWindowDecorations(v === true);
    }
  },
  'appearance.mode': {
    get: async () => {
      if (isTauri() && !isMobile()) {
        const mode = await getDesktopThemeMode();
        localStorage.setItem('mode-watcher-mode', mode);
        setMode(mode);
        return mode;
      }
      // mode-watcher writes/reads from localStorage; mirror its key here so
      // the radio reflects whatever the user's last choice was.
      if (typeof localStorage === 'undefined') return 'system';
      return localStorage.getItem('mode-watcher-mode') ?? 'system';
    },
    set: async (v) => {
      if (!isDesktopThemeMode(v)) {
        throw new Error('appearance.mode must be light, dark, or system');
      }
      const mode = v;
      setMode(mode);
      if (isTauri() && !isMobile()) await setDesktopThemeMode(mode);
    }
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
      let code =
        typeof localStorage === 'undefined'
          ? 'en'
          : localStorage.getItem('notes-app:language');
      if (!code && isTauri() && !isMobile()) {
        code = await getDesktopLanguage();
      }
      code = code ?? 'en';
      if (isTauri() && !isMobile()) {
        await setDesktopLanguage(code);
      }
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('notes-app:language', code);
      }
      setLanguage(code);
      return code;
    },
    set: async (v) => {
      const code = String(v);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('notes-app:language', code);
      }
      setLanguage(code);
      if (isTauri() && !isMobile()) {
        await setDesktopLanguage(code);
      }
    }
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = Component<any>;
export type CustomComponentLoader = () => Promise<AnyComponent>;

/** Components rendered in place of a generic control. */
export const CUSTOM_COMPONENT_LOADERS: Record<string, CustomComponentLoader> = {
  'sign-in-form': () =>
    import('./customs/SignInForm.svelte').then(
      (mod) => mod.default as unknown as AnyComponent
    ),
  'hotkeys-panel': () =>
    import('./customs/HotkeysPanel.svelte').then(
      (mod) => mod.default as unknown as AnyComponent
    )
};

type DataActionId =
  | 'open-data-folder'
  | 'empty-trash'
  | 'backup-now'
  | 'restore-backup'
  | 'export-vault'
  | 'import-notes';

async function runDataAction(id: DataActionId) {
  const { DATA_ACTIONS } = await import('./actions/data');
  return await DATA_ACTIONS[id]?.();
}

/** Handlers for button-type settings. */
export const SETTING_ACTIONS: Record<string, () => void | Promise<void>> = {
  'open-data-folder': () => runDataAction('open-data-folder'),
  'empty-trash': () => runDataAction('empty-trash'),
  'backup-now': () => runDataAction('backup-now'),
  'restore-backup': () => runDataAction('restore-backup'),
  'export-vault': () => runDataAction('export-vault'),
  'import-notes': () => runDataAction('import-notes'),
  'check-updates': async () => {
    const { checkForUpdatesInteractively } = await import('$lib/updater');
    await checkForUpdatesInteractively();
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
    ].join(' · '),
  // Body of the "Managed mode" notice in the account section. Lives
  // here (rather than as a hardcoded string in the schema) so the
  // text routes through tUi and stays translatable.
  'account.managedUnavailable': () => tUi('account.managedUnavailable')
};

/**
 * Per-option availability for select/radio settings whose choices depend on
 * runtime state the schema can't express.
 *
 * The schema's `platforms` filter is per-SETTING — it hides the whole control —
 * and these predicates are the per-OPTION equivalent. Kept as a side-table for
 * the same reason the bindings are: the rule belongs to the feature, not to the
 * settings dialog, and `SettingControl` stays generic instead of accumulating
 * `if (setting.id === …)` branches.
 *
 * Predicates are evaluated during render, so any reactive state they read is
 * tracked — an option can appear and disappear live.
 */
export const SETTING_OPTION_FILTERS: Record<
  string,
  (option: string) => boolean
> = {
  // Split needs the width for two side-by-side panes; below the threshold it
  // isn't offered at all. Deliberately hides the option WITHOUT rewriting a
  // stored `split` — the setting is vault-scoped, so a value chosen on a
  // desktop rides along to the phone and must survive the trip. NoteEditor
  // coerces at the point of use instead.
  'editor.defaultMode': (option) => option !== 'split' || splitAvailable()
};
