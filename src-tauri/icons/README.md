`icon-source.svg` is the source of every app icon. Regenerate them with:

```sh
pnpm tauri icon src-tauri/icons/icon-source.svg
```

With `src-tauri/gen/android` present, that writes the Android icons there and
leaves `android/` here untouched. Copy the `mipmap-*` PNGs across so both match.

The web build uses two copies the command does not write: `static/favicon.ico`
is `icon.ico`, and `static/app-logo.png` is `icon.png` scaled to 64 x 64.

The tray's monochrome icons live in `tray/`.
