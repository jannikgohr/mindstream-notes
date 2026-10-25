# Custom themes

The colours of the app come from a theme preset. **Settings → Appearance →
Theme** offers five: Apollo (the default), Slate & Indigo, Paper & Teal, Warm
and Forest. Each has a light and a dark version, and **Mode** picks which one
you see: Light, Dark or Match system.

The preset and the UI font size apply to every vault on this device. Editor
font size and line height belong to each vault.

## Making your own preset

1. Select the preset closest to what you want and choose **Show preset JSON**.
2. Copy the JSON, then give it a new `id` and `name`.
3. Paste it under **Import or edit a preset**, change the colours, and choose
   **Save preset**.

The new preset appears in the list. Saving again with the same `id` replaces it
on this device. **Remove preset** deletes a custom preset. If it was the one in
use, the app shows Apollo but remembers your choice, so saving a preset with
that `id` again brings it back.

Custom presets stay on the device, up to 64 of them. A backup carries them to
another device only when its restore has **Also import shared device
preferences, custom themes and plugin packages** ticked. See
[Backup and restore](backup-and-restore.md).

## The preset format

A preset has exactly five fields:

```jsonc
{
  "version": 1,
  "id": "my-theme",
  "name": "My theme",
  "light": {
    "surface-0": [0.955, 0.008, 195]
    // … the other tokens
  },
  "dark": {
    "surface-0": [0.175, 0.024, 266]
    // … the other tokens
  }
}
```

- `version` is `1`.
- `id` starts with a lowercase letter and holds only lowercase letters, digits
  and hyphens, up to 64 characters. `default`, `warm`, `forest` and anything
  starting with `builtin:` belong to the built-in presets.
- `name` is what the list shows, up to 160 bytes.
- The whole preset is at most 16 KiB.

### Colours

Every colour is an OKLCH triple `[L, C, H]`: lightness from 0 to 1, chroma from
0 to 0.4, and hue from 0 to 360. Both `light` and `dark` need these twelve:

| Tokens                                    | Used for                                                    |
| ----------------------------------------- | ----------------------------------------------------------- |
| `surface-0` to `surface-3`                | Backgrounds, from the window frame up to panels and dialogs |
| `border-subtle`, `border-strong`          | Dividers and outlines                                       |
| `foreground`, `muted-foreground`          | Normal and secondary text                                   |
| `primary`, `primary-foreground`           | Neutral buttons and their text                              |
| `accent-brand`, `accent-brand-foreground` | The accent colour, and text on it                           |

The accent marks links, note links, mentions, selected text and active items.

A palette can also set the named colours `named-red`, `named-orange`,
`named-amber`, `named-green`, `named-teal`, `named-blue`, `named-violet` and
`named-pink`, plus `named-foreground` for text on them. The vault tiles in the
vault switcher use them. Set all nine or none; without them the app uses
Apollo's. Pen and highlighter colours do not change with the preset.

Status colours, search and change highlights, shadows and corner radius are the
same in every preset.

### What the app checks

Saving refuses a preset that breaks any of these rules:

- The surfaces get lighter from `surface-0` to `surface-3`.
- Normal and secondary text, and text on `primary` and `accent-brand`, reach a
  contrast of at least 4.5.
- `accent-brand` reaches 3 against every surface.
- Each named colour reaches 4.5 with `named-foreground` and 3 against every
  surface.
- `border-subtle` reaches 1.1 and `border-strong` 1.25 against every surface.
- No unknown fields, CSS expressions, scripts or links to anything outside the
  preset.
