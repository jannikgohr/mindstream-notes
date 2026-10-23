Tray icons come from `lucide-static` 1.20.0, matching the app's Lucide version.
The SVGs use `#808080` so they remain visible on light and dark system menus.
The PNGs are 32 x 32 RGBA images, embedded by the Rust tray menu.

To regenerate a PNG with librsvg:

```sh
rsvg-convert -w 32 -h 32 file-text.svg -o file-text.png
```
