import { afterEach, describe, expect, it } from 'vitest';
import { settings } from '$lib/settings/store.svelte';
import { HOTKEY_COMMANDS } from './catalogue';
import { HOTKEY_PRESETS, presetBinding } from './presets';
import {
  getBinding,
  resetBinding,
  hotkeys,
  setHotkeyPreset,
  HotkeyBindingConflictError
} from './store.svelte';

afterEach(() => {
  delete settings.values['hotkeys.preset'];
  for (const id of Object.keys(hotkeys.bindings)) delete hotkeys.bindings[id];
});

describe('shortcut presets', () => {
  it('resetting a custom binding restores inheritance from later presets', async () => {
    hotkeys.bindings['editor.markdown.h1'] = 'mod+j';
    settings.values['hotkey.editor.markdown.h1'] = 'mod+j';
    await resetBinding('editor.markdown.h1');
    expect('editor.markdown.h1' in hotkeys.bindings).toBe(false);
    expect('hotkey.editor.markdown.h1' in settings.values).toBe(false);
    await setHotkeyPreset('notion');
    expect(getBinding('editor.markdown.h1')).toBe(
      presetBinding('notion', 'editor.markdown.h1', null)
    );
  });
  it.each(HOTKEY_PRESETS)(
    '%s has no conflicting effective bindings',
    async (preset) => {
      await expect(setHotkeyPreset(preset)).resolves.toBeUndefined();
      expect(settings.values['hotkeys.preset']).toBe(preset);
    }
  );

  it('switches inherited shortcuts while preserving custom and explicitly unset bindings', async () => {
    hotkeys.bindings['editor.markdown.bold'] = 'mod+shift+b';
    hotkeys.bindings['editor.markdown.italic'] = null;
    await setHotkeyPreset('notion');
    expect(getBinding('editor.markdown.bold')).toBe('mod+shift+b');
    expect(getBinding('editor.markdown.italic')).toBeNull();
    expect(getBinding('editor.markdown.bulletList')).toBe(
      presetBinding('notion', 'editor.markdown.bulletList', null)
    );
    await setHotkeyPreset('google-docs');
    expect(getBinding('editor.markdown.bulletList')).toBe('mod+shift+8');
    expect(getBinding('editor.markdown.codeBlock')).toBeNull();
    expect(getBinding('editor.markdown.bold')).toBe('mod+shift+b');
  });

  it('rejects a conflicting custom binding without partially applying the preset', async () => {
    const target = presetBinding('notion', 'editor.markdown.bulletList', null)!;
    hotkeys.bindings['editor.markdown.bold'] = target;
    await expect(setHotkeyPreset('notion')).rejects.toBeInstanceOf(
      HotkeyBindingConflictError
    );
    expect(settings.values['hotkeys.preset']).toBeUndefined();
    expect(getBinding('editor.markdown.bold')).toBe(target);
  });

  it('keeps Mindstream defaults for commands not covered by a preset', () => {
    for (const command of HOTKEY_COMMANDS.filter(
      (command) => command.scope === 'global'
    ))
      expect(presetBinding('notion', command.id, command.defaultBinding)).toBe(
        command.defaultBinding
      );
  });
});
