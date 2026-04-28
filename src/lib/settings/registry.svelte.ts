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
  setLeftSidebarWidth,
  setRightSidebarWidth,
  setSortStrategy,
  ui
} from '$lib/state.svelte';
import { setLanguage } from './i18n.svelte';
import type { SortStrategy } from '$lib/sort';
import SignInForm from './customs/SignInForm.svelte';

export interface Binding {
  get: () => unknown;
  set: (value: unknown) => void;
}

export const SETTING_BINDINGS: Record<string, Binding> = {
  'appearance.mode': {
    get: () => {
      // mode-watcher writes/reads from localStorage; mirror its key here so
      // the radio reflects whatever the user's last choice was.
      if (typeof localStorage === 'undefined') return 'system';
      return localStorage.getItem('mode-watcher-mode') ?? 'system';
    },
    set: (v) => setMode(v as 'light' | 'dark' | 'system')
  },
  'appearance.sortStrategy': {
    get: () => ui.sortStrategy,
    set: (v) => setSortStrategy(v as SortStrategy)
  },
  // The width sliders aren't in the schema yet, but the bindings are ready
  // when someone wants to surface them.
  'appearance.leftSidebarWidth': {
    get: () => ui.leftSidebarWidth,
    set: (v) => setLeftSidebarWidth(Number(v))
  },
  'appearance.rightSidebarWidth': {
    get: () => ui.rightSidebarWidth,
    set: (v) => setRightSidebarWidth(Number(v))
  },
  'language.code': {
    get: () => {
      if (typeof localStorage === 'undefined') return 'en';
      return localStorage.getItem('notes-app:language') ?? 'en';
    },
    set: (v) => {
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

/** Read-only display values for type='info' settings. */
export const INFO_VALUES: Record<string, () => string> = {
  'about.appVersion': () => '0.1.0',
  'about.tauriVersion': () =>
    'Tauri 2 · SvelteKit 2 · Svelte 5 · Milkdown Crepe · dockview 4'
};
