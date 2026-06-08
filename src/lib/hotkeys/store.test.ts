/**
 * Tests for the hotkey store — the reactive `hotkeys.bindings` map
 * and the get / set / reset helpers that mediate between the UI, the
 * manager, and the settings store on disk.
 *
 * Each test isolates state by clearing both the in-memory map and any
 * `hotkey.*` entries that landed in `settings.values` via `setBinding`.
 * Without that sweep tests would leak bindings into each other and
 * later asserts would fail on the residue.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  commandsCanCollide,
  findCommandByBinding,
  getBinding,
  hotkeys,
  HotkeyBindingConflictError,
  hydrateBindingsFromSettings,
  isCustomized,
  resetBinding,
  setBinding
} from './store.svelte';
import { settings } from '$lib/settings/store.svelte';
import { COMMAND_BY_ID } from './commands';

const BOLD = 'editor.markdown.bold';
const ITALIC = 'editor.markdown.italic';
const INK_PEN = 'editor.ink.pen';
const INK_ERASER = 'editor.ink.eraser';
const PDF_PEN = 'editor.pdf.pen';
const OPEN_SETTINGS = 'global.openSettings';
const NEW_MARKDOWN_NOTE = 'global.newMarkdownNote';
const SHOW_SHORTCUT_HELP = 'global.showShortcutHelp';

afterEach(() => {
  // In-memory map: wipe all overrides so the next test starts on
  // catalogue defaults.
  for (const key of Object.keys(hotkeys.bindings)) {
    delete hotkeys.bindings[key];
  }
  // Settings persistence: drop any hotkey.* rows. We don't touch
  // other settings — those belong to the parent test suite.
  for (const key of Object.keys(settings.values)) {
    if (key.startsWith('hotkey.')) delete settings.values[key];
  }
});

describe('store.getBinding', () => {
  it('returns the catalogue default when not customised', () => {
    expect(getBinding(BOLD)).toBe(COMMAND_BY_ID[BOLD].defaultBinding);
  });

  it('returns the in-map value when customised', () => {
    hotkeys.bindings[BOLD] = 'mod+j';
    expect(getBinding(BOLD)).toBe('mod+j');
  });

  it('returns null when the binding is explicitly unset', () => {
    // Distinct from "no entry in the map" — `null` means the user
    // touched this row and chose "no shortcut". The default must
    // NOT come back as a fallback.
    hotkeys.bindings[BOLD] = null;
    expect(getBinding(BOLD)).toBeNull();
  });

  it('returns null for an unknown command id', () => {
    expect(getBinding('totally.made.up')).toBeNull();
  });
});

describe('store.setBinding', () => {
  it('canonicalises the stored value', async () => {
    // The recorder doesn't have to hand us canonical input — the
    // store decides what's persisted. Casing and modifier order
    // both normalise.
    await setBinding(BOLD, 'Shift+Mod+B');
    expect(hotkeys.bindings[BOLD]).toBe('mod+shift+b');
  });

  it('null is the explicit-unset signal', async () => {
    await setBinding(BOLD, null);
    expect(hotkeys.bindings[BOLD]).toBeNull();
  });

  it('refuses to persist input that fails to parse', async () => {
    await expect(setBinding(BOLD, 'garbage')).rejects.toThrow();
  });

  it('rejects a custom-owner collision without changing either command', async () => {
    // User had bold on a custom chord; assigning that same chord to
    // italic must be reported to the caller so the UI can show the
    // rejection next to the row being edited.
    await setBinding(BOLD, 'mod+x');
    let err: unknown;
    try {
      await setBinding(ITALIC, 'mod+x');
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(HotkeyBindingConflictError);
    expect(err).toMatchObject({
      commandId: ITALIC,
      conflictingCommandId: BOLD,
      binding: 'mod+x'
    });
    expect(getBinding(BOLD)).toBe('mod+x');
    expect(getBinding(ITALIC)).toBe(COMMAND_BY_ID[ITALIC].defaultBinding);
  });

  it('allows the same chord across different editor note types', async () => {
    await setBinding(BOLD, 'mod+x');
    await setBinding(INK_PEN, 'mod+x');
    expect(getBinding(BOLD)).toBe('mod+x');
    expect(getBinding(INK_PEN)).toBe('mod+x');
  });

  it('rejects collisions within the same editor note type', async () => {
    await setBinding(INK_PEN, 'mod+x');
    await expect(setBinding(INK_ERASER, 'mod+x')).rejects.toMatchObject({
      commandId: INK_ERASER,
      conflictingCommandId: INK_PEN,
      binding: 'mod+x'
    });
    expect(getBinding(INK_PEN)).toBe('mod+x');
    expect(getBinding(INK_ERASER)).toBeNull();
  });

  it('rejects an editor binding that collides with an application-level default', async () => {
    const settingsDefault = COMMAND_BY_ID[OPEN_SETTINGS].defaultBinding;
    expect(settingsDefault).not.toBeNull();
    if (!settingsDefault) return;
    await expect(setBinding(INK_PEN, settingsDefault)).rejects.toMatchObject({
      commandId: INK_PEN,
      conflictingCommandId: OPEN_SETTINGS,
      binding: settingsDefault
    });
    expect(getBinding(INK_PEN)).toBeNull();
  });

  it('rejects an application-level binding that collides with an editor command', async () => {
    await setBinding(INK_PEN, 'mod+x');
    await expect(setBinding(OPEN_SETTINGS, 'mod+x')).rejects.toMatchObject({
      commandId: OPEN_SETTINGS,
      conflictingCommandId: INK_PEN,
      binding: 'mod+x'
    });
    expect(getBinding(OPEN_SETTINGS)).toBe(
      COMMAND_BY_ID[OPEN_SETTINGS].defaultBinding
    );
    expect(getBinding(INK_PEN)).toBe('mod+x');
  });

  it('rejects an application-level binding that collides with another application command', async () => {
    await setBinding(NEW_MARKDOWN_NOTE, 'mod+x');
    await expect(setBinding(OPEN_SETTINGS, 'mod+x')).rejects.toMatchObject({
      commandId: OPEN_SETTINGS,
      conflictingCommandId: NEW_MARKDOWN_NOTE,
      binding: 'mod+x'
    });
  });

  it('rejects a default-owner collision without changing either command', async () => {
    // A visible collision is still a collision: if italic takes
    // bold's default, the caller needs to know bold owns it even
    // though bold has no explicit override in the settings map.
    const boldDefault = COMMAND_BY_ID[BOLD].defaultBinding;
    expect(boldDefault).not.toBeNull();
    if (!boldDefault) return;
    await expect(setBinding(ITALIC, boldDefault)).rejects.toMatchObject({
      commandId: ITALIC,
      conflictingCommandId: BOLD,
      binding: boldDefault
    });
    expect(getBinding(BOLD)).toBe(boldDefault);
    expect(getBinding(ITALIC)).toBe(COMMAND_BY_ID[ITALIC].defaultBinding);
  });

  it('ignores writes to unknown command ids', async () => {
    await setBinding('not.a.real.command', 'mod+a');
    expect(getBinding('not.a.real.command')).toBeNull();
  });
});

describe('store.resetBinding', () => {
  it('restores the catalogue default', async () => {
    await setBinding(BOLD, 'mod+j');
    await resetBinding(BOLD);
    expect(getBinding(BOLD)).toBe(COMMAND_BY_ID[BOLD].defaultBinding);
  });
});

describe('store.isCustomized', () => {
  it('is false when the binding equals the default', () => {
    expect(isCustomized(BOLD)).toBe(false);
  });

  it('is true when a custom binding is set', () => {
    hotkeys.bindings[BOLD] = 'mod+j';
    expect(isCustomized(BOLD)).toBe(true);
  });

  it('is true when the binding is explicitly unset', () => {
    hotkeys.bindings[BOLD] = null;
    expect(isCustomized(BOLD)).toBe(true);
  });

  it('is false for an unknown command id', () => {
    expect(isCustomized('made.up')).toBe(false);
  });
});

describe('store.findCommandByBinding', () => {
  it('returns the command that owns a chord via override', () => {
    hotkeys.bindings[BOLD] = 'mod+j';
    expect(findCommandByBinding('mod+j')?.id).toBe(BOLD);
  });

  it('returns the command that owns a chord via default', () => {
    // No overrides — the default for bold is mod+b.
    const def = COMMAND_BY_ID[BOLD].defaultBinding;
    expect(def).not.toBeNull();
    if (!def) return;
    expect(findCommandByBinding(def)?.id).toBe(BOLD);
  });

  it('returns null when no command owns the chord', () => {
    expect(findCommandByBinding('mod+q')).toBeNull();
  });

  it('ignores owners from other editor note types for an editor target', () => {
    hotkeys.bindings[BOLD] = 'mod+j';
    expect(findCommandByBinding('mod+j', INK_PEN)).toBeNull();
  });

  it('returns owners from the same editor note type for an editor target', () => {
    hotkeys.bindings[INK_ERASER] = 'mod+j';
    expect(findCommandByBinding('mod+j', INK_PEN)?.id).toBe(INK_ERASER);
  });

  it('ignores multiple owners from other editor note types until a global owner exists', () => {
    hotkeys.bindings[BOLD] = 'mod+j';
    hotkeys.bindings[PDF_PEN] = 'mod+j';
    expect(findCommandByBinding('mod+j', INK_PEN)).toBeNull();

    hotkeys.bindings[OPEN_SETTINGS] = 'mod+j';
    expect(findCommandByBinding('mod+j', INK_PEN)?.id).toBe(OPEN_SETTINGS);
  });

  it('includes global owners for an editor target', () => {
    const settingsDefault = COMMAND_BY_ID[OPEN_SETTINGS].defaultBinding;
    expect(settingsDefault).not.toBeNull();
    if (!settingsDefault) return;
    expect(findCommandByBinding(settingsDefault, INK_PEN)?.id).toBe(
      OPEN_SETTINGS
    );
  });

  it('includes editor owners for an application-level target', () => {
    hotkeys.bindings[INK_PEN] = 'mod+j';
    expect(findCommandByBinding('mod+j', OPEN_SETTINGS)?.id).toBe(INK_PEN);
  });

  it('includes application owners for an application-level target', () => {
    hotkeys.bindings[NEW_MARKDOWN_NOTE] = 'mod+j';
    expect(findCommandByBinding('mod+j', OPEN_SETTINGS)?.id).toBe(
      NEW_MARKDOWN_NOTE
    );
  });
});

describe('store.commandsCanCollide', () => {
  it.each([
    {
      name: 'same command',
      commandId: BOLD,
      otherId: BOLD,
      expected: false
    },
    {
      name: 'two application-level commands',
      commandId: OPEN_SETTINGS,
      otherId: SHOW_SHORTCUT_HELP,
      expected: true
    },
    {
      name: 'application-level command against markdown editor command',
      commandId: OPEN_SETTINGS,
      otherId: BOLD,
      expected: true
    },
    {
      name: 'markdown editor command against application-level command',
      commandId: BOLD,
      otherId: OPEN_SETTINGS,
      expected: true
    },
    {
      name: 'two markdown editor commands',
      commandId: BOLD,
      otherId: ITALIC,
      expected: true
    },
    {
      name: 'two ink editor commands',
      commandId: INK_PEN,
      otherId: INK_ERASER,
      expected: true
    },
    {
      name: 'markdown command against ink command',
      commandId: BOLD,
      otherId: INK_PEN,
      expected: false
    },
    {
      name: 'ink command against markdown command',
      commandId: INK_PEN,
      otherId: BOLD,
      expected: false
    },
    {
      name: 'ink command against pdf command',
      commandId: INK_PEN,
      otherId: PDF_PEN,
      expected: false
    },
    {
      name: 'pdf command against markdown command',
      commandId: PDF_PEN,
      otherId: BOLD,
      expected: false
    }
  ])('$name', ({ commandId, otherId, expected }) => {
    expect(
      commandsCanCollide(COMMAND_BY_ID[commandId], COMMAND_BY_ID[otherId])
    ).toBe(expected);
  });
});

describe('store.hydrateBindingsFromSettings', () => {
  it('overlays user-saved values from settings.values', () => {
    settings.values[`hotkey.${BOLD}`] = 'mod+j';
    hydrateBindingsFromSettings();
    expect(getBinding(BOLD)).toBe('mod+j');
  });

  it('forgets overrides when the settings entry disappears', () => {
    // Mirrors a "reset to default" round-trip: the row gets the
    // default written back, then localStorage gets cleaned out, and
    // the next hydrate falls back to the catalogue.
    settings.values[`hotkey.${BOLD}`] = 'mod+j';
    hydrateBindingsFromSettings();
    delete settings.values[`hotkey.${BOLD}`];
    hydrateBindingsFromSettings();
    expect(getBinding(BOLD)).toBe(COMMAND_BY_ID[BOLD].defaultBinding);
  });

  it('preserves null (explicit unset) from settings', () => {
    settings.values[`hotkey.${BOLD}`] = null;
    hydrateBindingsFromSettings();
    expect(getBinding(BOLD)).toBeNull();
  });

  it('canonicalises non-canonical persisted strings', () => {
    settings.values[`hotkey.${BOLD}`] = 'Shift+Mod+B';
    hydrateBindingsFromSettings();
    expect(getBinding(BOLD)).toBe('mod+shift+b');
  });
});
