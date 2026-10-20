import { isMac } from './platform';

export const HOTKEY_PRESETS = ['mindstream', 'notion', 'google-docs'] as const;
export type HotkeyPreset = (typeof HOTKEY_PRESETS)[number];

// https://www.notion.com/help/keyboard-shortcuts documents different modifiers
// for macOS and Windows/Linux. Notion has only three heading levels.
function notionBindings(): Record<string, string | null> {
  const modifier = isMac() ? 'mod+alt' : 'mod+shift';
  return {
    'editor.markdown.paragraph': `${modifier}+0`,
    'editor.markdown.h1': `${modifier}+1`,
    'editor.markdown.h2': `${modifier}+2`,
    'editor.markdown.h3': `${modifier}+3`,
    'editor.markdown.h4': null,
    'editor.markdown.h5': null,
    'editor.markdown.h6': null,
    'editor.markdown.taskList': `${modifier}+4`,
    'editor.markdown.bulletList': `${modifier}+5`,
    'editor.markdown.orderedList': `${modifier}+6`,
    'editor.markdown.codeBlock': `${modifier}+8`
  };
}
const GOOGLE_DOCS: Record<string, string | null> = {
  'editor.markdown.codeBlock': null
};

export function hotkeyPreset(value: unknown): HotkeyPreset {
  return HOTKEY_PRESETS.includes(value as HotkeyPreset)
    ? (value as HotkeyPreset)
    : 'mindstream';
}
export function presetBinding(
  preset: HotkeyPreset,
  commandId: string,
  fallback: string | null
): string | null {
  const overrides =
    preset === 'notion'
      ? notionBindings()
      : preset === 'google-docs'
        ? GOOGLE_DOCS
        : {};
  return commandId in overrides ? overrides[commandId] : fallback;
}
