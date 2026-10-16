import {
  BUILTIN_PRESETS,
  parseThemePreset,
  THEME_CACHE_KEY,
  type ThemePreset
} from './theme-presets';
import { listThemePresets } from '$lib/api/theme-presets';
import { toErrorMessage } from '$lib/api/errors';
function initialPresets(): ThemePreset[] {
  try {
    const cached = parseThemePreset(
      JSON.parse(localStorage.getItem(THEME_CACHE_KEY) ?? 'null')?.preset
    );
    if (!BUILTIN_PRESETS.some((preset) => preset.id === cached.id))
      return [...BUILTIN_PRESETS, cached];
  } catch {
    /* validated built-in fallback */
  }
  return BUILTIN_PRESETS;
}
export const themeCatalog = $state<{ presets: ThemePreset[]; error: string }>({
  presets: initialPresets(),
  error: ''
});
let request = 0;
export async function refreshThemePresets(): Promise<void> {
  const generation = ++request;
  try {
    const presets = await listThemePresets();
    if (generation !== request) return;
    themeCatalog.presets = presets;
    themeCatalog.error = '';
  } catch (error) {
    if (generation !== request) return;
    themeCatalog.presets = BUILTIN_PRESETS;
    themeCatalog.error = toErrorMessage(error);
  }
}
