//! Visual theme for the drawing toolbar (B2).
//!
//! Two-layer split:
//!
//!   1. [`DrawingTheme`] is the platform-neutral input shape — `dark`
//!      flag + optional `accent` colour, the same two knobs the JS
//!      side has (`appearance.mode` + `appearance.accent`). Stays
//!      stable so the `drawing_set_theme` Tauri command never has to
//!      learn shadcn internals.
//!
//!   2. We use [`egui_shadcn::Theme`] for the per-frame widget
//!      visuals — built from shadcn's `ColorPalette::shadcn_dark` /
//!      `shadcn_light` with the same Neutral base the rest of the
//!      app resolves to in `src/app.css`. The user accent overrides
//!      `palette.primary` + `palette.ring` exactly the way
//!      `src/lib/settings/accent.ts` does on the JS side.
//!
//! The toolbar reads the shadcn `Theme` directly; the panel
//! background still goes through [`DrawingTheme::background`]
//! because `egui::Frame::fill` needs an explicit value (egui doesn't
//! auto-apply `Visuals::panel_fill` to user-built frames).
//!
//! For [`crate::ui::CanvasUi`] callers nothing changes —
//! you still construct a `DrawingTheme` and hand it to `set_theme`.

use egui::Color32;
use egui_shadcn::tokens::{ColorPalette, ShadcnBaseColor};
use egui_shadcn::Theme as ShadcnTheme;

/// Visual tokens the toolbar reads. `dark = true` matches the
/// existing toolbar look and the rest of the app when `html.dark`
/// is set; `accent` mirrors shadcn's `--primary` (the colour the
/// user can override via the `appearance.accent` setting).
#[derive(Copy, Clone, Debug)]
pub struct DrawingTheme {
    pub dark: bool,
    pub accent: Color32,
}

impl DrawingTheme {
    /// Default dark palette. Accent is shadcn's default near-white
    /// `--primary` in dark mode; the JS bridge overrides this when
    /// the user has actually picked a custom accent.
    pub const fn dark() -> Self {
        Self {
            dark: true,
            accent: Color32::from_rgb(250, 250, 250),
        }
    }

    /// Light palette. Accent is shadcn's near-black `--primary` in
    /// light mode.
    pub const fn light() -> Self {
        Self {
            dark: false,
            accent: Color32::from_rgb(38, 38, 38),
        }
    }

    /// Panel background for the egui `Frame::fill`. Pulled from
    /// shadcn's resolved palette so it tracks dark/light without
    /// our needing to maintain a parallel constant.
    pub fn background(&self) -> Color32 {
        self.palette().background
    }

    /// Build the shadcn `ColorPalette` for the current mode + accent.
    /// We start from `shadcn_dark/light(Neutral)` (matches the
    /// `:root` / `.dark` tokens in `src/app.css`) and overlay the
    /// user accent onto `primary` + `ring`, identical to
    /// `src/lib/settings/accent.ts`. `primary_foreground` is forced
    /// to white so dark accents stay legible — same trade-off the
    /// JS helper makes.
    pub fn palette(&self) -> ColorPalette {
        let mut palette = if self.dark {
            ColorPalette::shadcn_dark(ShadcnBaseColor::Neutral)
        } else {
            ColorPalette::shadcn_light(ShadcnBaseColor::Neutral)
        };
        // Only override if the JS bridge actually picked a custom
        // accent. The shadcn defaults are sane on their own; rewriting
        // them with the *default* white/black we hard-coded above
        // would still work but creates needless noise in the dep
        // graph.
        if self.accent != Self::dark().accent && self.accent != Self::light().accent {
            palette.primary = self.accent;
            palette.ring = self.accent;
            palette.primary_foreground = Color32::WHITE;
        }
        palette
    }

    /// Construct the per-frame `egui_shadcn::Theme` the toolbar
    /// passes to `button()` / `toggle()`. Cheap to build —
    /// `Theme::new` just stashes the palette + default motion /
    /// radius / focus tokens.
    pub fn shadcn_theme(&self) -> ShadcnTheme {
        ShadcnTheme::new(self.palette())
    }
}

impl Default for DrawingTheme {
    fn default() -> Self {
        Self::dark()
    }
}
