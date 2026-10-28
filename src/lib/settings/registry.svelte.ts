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
  getCloseToTray,
  getCustomWindowDecorations,
  getDesktopLanguage,
  getDesktopThemeMode,
  getStartInTray,
  getStartOnLogin,
  isDesktopThemeMode,
  setCloseToTray,
  setCustomWindowDecorations,
  setDesktopLanguage,
  setDesktopThemeMode,
  setStartInTray,
  setStartOnLogin
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
  document?: 'desktop';
  /** Apply only after the store has accepted a current read or local edit. */
  apply?: (value: unknown) => void;
}

function applyMode(value: unknown): void {
  if (!isDesktopThemeMode(value)) return;
  localStorage.setItem('mode-watcher-mode', value);
  setMode(value);
}

function applyLanguage(value: unknown): void {
  const code = String(value ?? 'en');
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('notes-app:language', code);
  }
  setLanguage(code);
}

/**
 * The coordinator owns OS startup registration. Browser/mobile settings report
 * false and skip writes; desktop vaults use the same typed backend bridge.
 */
const autostartAvailable = () => isTauri() && !isMobile();

export const SETTING_BINDINGS: Record<string, Binding> = {
  'general.startOnLogin': {
    hydrate: 'on-demand',
    get: async () => {
      if (!autostartAvailable()) return false;
      return await getStartOnLogin();
    },
    set: async (v) => {
      if (!autostartAvailable()) return;
      await setStartOnLogin(v === true);
    }
  },
  'general.closeToTray': {
    document: 'desktop',
    get: async () =>
      isTauri() && !isMobile() ? await getCloseToTray() : false,
    set: async (v) => {
      if (!isTauri() || isMobile()) return;
      await setCloseToTray(v === true);
    }
  },
  'general.startInTray': {
    document: 'desktop',
    get: async () =>
      isTauri() && !isMobile() ? await getStartInTray() : false,
    set: async (v) => {
      if (!isTauri() || isMobile()) return;
      await setStartInTray(v === true);
    }
  },
  'appearance.customWindowDecorations': {
    document: 'desktop',
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
    document: 'desktop',
    apply: applyMode,
    get: async () => {
      if (isTauri() && !isMobile()) {
        return await getDesktopThemeMode();
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
      if (isTauri() && !isMobile()) await setDesktopThemeMode(mode);
      else applyMode(mode);
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
    document: 'desktop',
    apply: applyLanguage,
    get: async () => {
      let code =
        typeof localStorage === 'undefined'
          ? 'en'
          : localStorage.getItem('notes-app:language');
      if (isTauri() && !isMobile()) {
        code = await getDesktopLanguage();
      }
      return code ?? 'en';
    },
    set: async (v) => {
      const code = String(v);
      if (isTauri() && !isMobile()) {
        await setDesktopLanguage(code);
      } else applyLanguage(code);
    }
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = Component<any>;
export type CustomComponentLoader = () => Promise<AnyComponent>;

/** Components rendered in place of a generic control. */
export const CUSTOM_COMPONENT_LOADERS: Record<string, CustomComponentLoader> = {
  'hotkey-preset': () =>
    import('./customs/HotkeyPreset.svelte').then(
      (mod) => mod.default as unknown as AnyComponent
    ),
  'theme-presets': () =>
    import('./customs/ThemePresets.svelte').then(
      (mod) => mod.default as unknown as AnyComponent
    ),
  'sign-in-form': () =>
    import('./customs/SignInForm.svelte').then(
      (mod) => mod.default as unknown as AnyComponent
    ),
  'account-security': () =>
    import('./customs/AccountSecurity.svelte').then(
      (mod) => mod.default as unknown as AnyComponent
    ),
  'hotkeys-panel': () =>
    import('./customs/HotkeysPanel.svelte').then(
      (mod) => mod.default as unknown as AnyComponent
    ),
  'spellcheck-dictionaries': () =>
    import('./customs/SpellcheckDictionaries.svelte').then(
      (mod) => mod.default as unknown as AnyComponent
    ),
  'spellcheck-custom-words': () =>
    import('./customs/SpellcheckCustomWords.svelte').then(
      (mod) => mod.default as unknown as AnyComponent
    ),
  'freeform-embed-hosts': () =>
    import('./customs/FreeformEmbedHosts.svelte').then(
      (mod) => mod.default as unknown as AnyComponent
    )
};

type DataActionId =
  | 'open-data-folder'
  | 'empty-trash'
  | 'backup-now'
  | 'restore-backup'
  | 'export-vault'
  | 'import-notes'
  | 'convert-legacy-links';

async function runDataAction(id: DataActionId) {
  const { DATA_ACTIONS } = await import('./actions/data');
  return await DATA_ACTIONS[id]?.();
}

/** Handlers for button-type settings. */
export const SETTING_ACTIONS: Record<string, () => void | Promise<void>> = {
  'run-onboarding': async () => {
    const { openOnboarding } = await import('$lib/onboarding/store.svelte');
    await openOnboarding();
  },
  'open-data-folder': () => runDataAction('open-data-folder'),
  'empty-trash': () => runDataAction('empty-trash'),
  'backup-now': () => runDataAction('backup-now'),
  'restore-backup': () => runDataAction('restore-backup'),
  'export-vault': () => runDataAction('export-vault'),
  'import-notes': () => runDataAction('import-notes'),
  'convert-legacy-links': () => runDataAction('convert-legacy-links'),
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
      `dockview ${depVersion('dockview')}`
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
