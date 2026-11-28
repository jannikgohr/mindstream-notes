Tray menu icons come from `lucide-static` 1.20.0, matching the app's Lucide version.
Their SVGs use `#808080` so they remain visible on light and dark system menus.
Their PNGs are 32 x 32 RGBA images, embedded by the Rust tray menu.

`app-light.svg` and `app-dark.svg` are the monochrome tray icons. Light and dark
name the icon's colour: the light one is for dark panels. Their PNGs are
128 x 128, because KDE scales a large image down cleanly and macOS sizes the
template image to the menu bar. macOS only uses the dark PNG's alpha.

The tray shows the PNG as it is on Linux, so the automatic choice there guesses
the panel colour from the desktop portal's colour scheme. GNOME reports no
preference for its light style while its top bar stays dark, so only an explicit
light preference picks the dark icon.

To regenerate a PNG with librsvg:

```sh
rsvg-convert -w 32 -h 32 file-text.svg -o file-text.png
rsvg-convert -w 128 -h 128 app-light.svg -o app-light.png
```
