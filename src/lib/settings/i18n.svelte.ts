import type { I18nBundle } from './types';

// Statically import every JSON bundle in i18n/. Adding a translation is
// "drop a new JSON file in this folder", no other wiring needed.
const bundles = import.meta.glob<{ default: I18nBundle }>('./i18n/*.json', {
  eager: true
});

const byLang: Record<string, I18nBundle> = {};
for (const [path, mod] of Object.entries(bundles)) {
  const m = path.match(/\.\/i18n\/(.+)\.json$/);
  if (!m) continue;
  byLang[m[1]] = (mod as { default: I18nBundle }).default;
}

export const AVAILABLE_LANGUAGES = Object.keys(byLang).sort();
const FALLBACK = byLang['en'] ?? Object.values(byLang)[0];

interface I18nState {
  language: string;
  bundle: I18nBundle;
}

export const i18n = $state<I18nState>({
  language: 'en',
  bundle: FALLBACK
});

/**
 * Fallback string resolver for ids that aren't in the static i18n bundles —
 * currently plugin-contributed settings/sections/values. The plugins layer
 * registers one at startup; core stays ignorant of plugins (and there is no
 * import cycle, since this module never imports the plugins layer). Consulted
 * only after the active + English bundles miss.
 */
export interface SettingsLabelResolver {
  label(
    scope: 'categories' | 'sections' | 'settings',
    id: string
  ): string | undefined;
  description(
    scope: 'categories' | 'sections' | 'settings',
    id: string
  ): string | undefined;
  value(settingId: string, value: string): string | undefined;
}

let labelResolver: SettingsLabelResolver | null = null;

/** Install (or clear with `null`) the dynamic label fallback. */
export function registerSettingsLabelResolver(
  resolver: SettingsLabelResolver | null
): void {
  labelResolver = resolver;
}

export function setLanguage(code: string) {
  if (!byLang[code]) {
    console.warn('[i18n] unknown language', code, '— falling back to en');
    i18n.language = 'en';
    i18n.bundle = FALLBACK;
    return;
  }
  i18n.language = code;
  i18n.bundle = byLang[code];
}

/** Look up a label by id from the active bundle, with English fallback. */
export function tLabel(
  scope: 'categories' | 'sections' | 'settings',
  id: string
): string {
  const active = i18n.bundle[scope]?.[id];
  if (active?.label) return active.label;
  const fb = FALLBACK[scope]?.[id];
  if (fb?.label) return fb.label;
  return labelResolver?.label(scope, id) ?? id;
}

export function tDescription(
  scope: 'categories' | 'sections' | 'settings',
  id: string
): string | undefined {
  return (
    i18n.bundle[scope]?.[id]?.description ??
    FALLBACK[scope]?.[id]?.description ??
    labelResolver?.description(scope, id)
  );
}

/** Look up a value label, e.g. tValue('account.serverType', 'managed'). */
export function tValue(settingId: string, value: string): string {
  const key = `${settingId}.${value}`;
  return (
    i18n.bundle.values?.[key] ??
    FALLBACK.values?.[key] ??
    labelResolver?.value(settingId, value) ??
    value
  );
}

export function tUi(key: keyof I18nBundle['ui']): string {
  return i18n.bundle.ui?.[key] ?? FALLBACK.ui?.[key] ?? key;
}

// Initialize language from localStorage on first load (browser-only).
if (typeof localStorage !== 'undefined') {
  const stored = localStorage.getItem('notes-app:language');
  if (stored && byLang[stored]) {
    i18n.language = stored;
    i18n.bundle = byLang[stored];
  }
}
