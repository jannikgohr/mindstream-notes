/**
 * Public contract for the JSON-driven settings system.
 *
 * The schema is data-only (loaded from schema.json). Labels and descriptions
 * live in per-language i18n bundles (i18n/<lang>.json) keyed by the same
 * setting id, so adding a translation is one new JSON file.
 *
 * Custom UI is opt-in: a setting with `type: 'custom'` references a
 * registered component by `customId`; same for action buttons via `actionId`.
 */

import type { PlatformFilter } from '$lib/platform';

/** Where the setting is persisted. V = per-vault, D = per-device. */
export type SettingScope = 'V' | 'D';

export type SettingType =
  | 'toggle'
  | 'text'
  | 'number'
  | 'slider'
  | 'select'
  | 'radio'
  | 'multi-select'
  | 'color'
  | 'path'
  | 'keybinding'
  | 'button'
  | 'info'
  | 'custom';

/** Conditional visibility based on another setting's value. */
export interface ShowIf {
  id: string;
  equals?: unknown;
  notEquals?: unknown;
  in?: unknown[];
}

interface SettingBase {
  id: string;
  scope: SettingScope;
  type: SettingType;
  default?: unknown;
  showIf?: ShowIf;
  /**
   * Restrict the setting to the listed platforms. Accepts specific OS
   * names (`"android"`, `"windows"`, …) and coarse groups (`"desktop"`,
   * `"mobile"`); mixing both is fine. Omitted/empty ⇒ all platforms.
   */
  platforms?: PlatformFilter[];
  /**
   * Platform-specific defaults. Exact platform entries win over broad
   * groups, and `default` remains the fallback.
   */
  defaultByPlatform?: Partial<Record<PlatformFilter, unknown>>;
  /** Lookup key into the custom-component registry (only when type='custom'). */
  customId?: string;
  /** Lookup key into the action registry (only when type='button'). */
  actionId?: string;
}

export interface ToggleSetting extends SettingBase {
  type: 'toggle';
  default?: boolean;
}
export interface TextSetting extends SettingBase {
  type: 'text';
  default?: string;
  placeholder?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  multiline?: boolean;
}
export interface NumericSetting extends SettingBase {
  type: 'number' | 'slider';
  default?: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}
export interface SelectSetting extends SettingBase {
  type: 'select' | 'radio';
  default?: string;
  options: string[];
}
export interface MultiSelectSetting extends SettingBase {
  type: 'multi-select';
  default?: string[];
  options: string[];
}
export interface ColorSetting extends SettingBase {
  type: 'color';
  default?: string;
}
export interface PathSetting extends SettingBase {
  type: 'path';
  default?: string;
  /** What kind of OS picker to open. */
  mode: 'file' | 'directory';
}
export interface KeybindingSetting extends SettingBase {
  type: 'keybinding';
  default?: string;
}
export interface ButtonSetting extends SettingBase {
  type: 'button';
  variant?: 'default' | 'destructive' | 'outline' | 'ghost' | 'secondary';
}
export interface InfoSetting extends SettingBase {
  type: 'info';
}
export interface CustomSetting extends SettingBase {
  type: 'custom';
  customId: string;
}

export type Setting =
  | ToggleSetting
  | TextSetting
  | NumericSetting
  | SelectSetting
  | MultiSelectSetting
  | ColorSetting
  | PathSetting
  | KeybindingSetting
  | ButtonSetting
  | InfoSetting
  | CustomSetting;

export interface Section {
  id: string;
  /** Same semantics as Setting.platforms — hides the entire section. */
  platforms?: PlatformFilter[];
  /**
   * Render the section collapsed behind a disclosure (for advanced/rarely-
   * touched tuning knobs). Auto-expands while a search query is active so
   * matches stay visible.
   */
  advanced?: boolean;
  settings: Setting[];
}

export interface Category {
  id: string;
  /** Lucide icon name (kebab-case), resolved through icons.ts. */
  icon?: string;
  /** Same semantics as Setting.platforms — hides the entire category. */
  platforms?: PlatformFilter[];
  sections: Section[];
}

export interface SettingsSchema {
  /** Bump when making breaking changes; the loader will migrate. */
  version: number;
  categories: Category[];
}

/**
 * Translation bundle. Same shape for every language; keys are stable so a
 * new bundle just translates the strings.
 */
export interface I18nBundle {
  language: string;
  /**
   * Flat dictionary of UI strings. Keys are namespaced with dots
   * (e.g. `'sort.ascending'`, `'menu.rename'`) — `tUi()` does a plain
   * map lookup, no nesting walked. Adding a new string is "drop a
   * key/value pair into every bundle", and the rule is that every new
   * user-facing string goes through this rather than hardcoded text in
   * components.
   */
  ui: Record<string, string>;
  categories: Record<string, { label: string; description?: string }>;
  sections: Record<string, { label: string; description?: string }>;
  settings: Record<string, { label: string; description?: string }>;
  values: Record<string, string>;
}
