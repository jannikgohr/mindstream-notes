//! Visual theme for the drawing toolbar (B2). Bridges the app's
//! shadcn-style design tokens — see `src/app.css` — into an
//! [`egui::Visuals`] the egui context applies once on construction
//! and whenever the JS side pushes a fresh theme via the future
//! `drawing_set_theme` Tauri command.
//!
//! Token mapping (matches the `:root` / `.dark` blocks in
//! `src/app.css`, OKLCH → sRGB approximated to integer RGB):
//!
//!   panel background      `--background`           dark `~oklch(0.18)` ≈ rgb 32,32,36
//!   button background     `--secondary`/`--muted`  dark `~oklch(0.27)` ≈ rgb 58,58,60
//!   button hover          one shade above muted                       ≈ rgb 78,78,82
//!   button active / accent `--primary`             dark `~oklch(0.985)` ≈ rgb 250,250,250 (overridden by user accent if set)
//!   border                `--border`               dark `~oklch(0.27)` ≈ rgb 58,58,60
//!   foreground            `--foreground`           dark `~oklch(0.985)` ≈ rgb 250,250,250
//!
//! The toolbar reads the panel background through [`DrawingTheme::background`]
//! (and not via egui visuals) because `egui::Frame::fill` must be the
//! shadcn panel colour even when the surrounding widgets are
//! themed by `Visuals`. The widget colours all come from
//! [`DrawingTheme::to_visuals`] which the context applies on
//! [`crate::drawing::ui::CanvasUi::set_theme`].

use egui::{Color32, Visuals};

/// Visual tokens the toolbar reads. `dark = true` matches the
/// existing `Color32::from_rgb(32, 32, 36)` panel and the rest of
/// the app when `html.dark` is set; `accent` mirrors shadcn's
/// `--primary` (i.e. the colour the user can override via the
/// accent-picker setting).
#[derive(Copy, Clone, Debug)]
pub struct DrawingTheme {
    pub dark: bool,
    pub accent: Color32,
}

impl DrawingTheme {
    /// Default dark palette — matches the values that resolve from
    /// the `.dark` block in `src/app.css`. Accent is shadcn's
    /// default near-white `--primary` in dark mode.
    pub const fn dark() -> Self {
        Self {
            dark: true,
            accent: Color32::from_rgb(250, 250, 250),
        }
    }

    /// Light palette — matches the `:root` block in `src/app.css`.
    /// Accent is shadcn's near-black `--primary` in light mode.
    pub const fn light() -> Self {
        Self {
            dark: false,
            accent: Color32::from_rgb(38, 38, 38),
        }
    }

    pub fn background(&self) -> Color32 {
        if self.dark {
            Color32::from_rgb(32, 32, 36)
        } else {
            Color32::from_rgb(251, 251, 252)
        }
    }

    pub fn foreground(&self) -> Color32 {
        if self.dark {
            Color32::from_rgb(250, 250, 250)
        } else {
            Color32::from_rgb(37, 37, 37)
        }
    }

    pub fn muted(&self) -> Color32 {
        if self.dark {
            Color32::from_rgb(58, 58, 60)
        } else {
            Color32::from_rgb(244, 244, 245)
        }
    }

    pub fn border(&self) -> Color32 {
        if self.dark {
            Color32::from_rgb(58, 58, 60)
        } else {
            Color32::from_rgb(228, 228, 231)
        }
    }

    /// One shade brighter / darker than `muted` for hover state.
    /// Shadcn doesn't have a dedicated "hover" token — apps usually
    /// derive one with `bg-secondary/80` etc. We approximate by
    /// stepping muted ~7% toward foreground.
    pub fn hover(&self) -> Color32 {
        if self.dark {
            Color32::from_rgb(78, 78, 82)
        } else {
            Color32::from_rgb(232, 232, 234)
        }
    }

    /// Construct an `egui::Visuals` that paints buttons, hover, and
    /// selected states in the theme's palette. Applied on the egui
    /// context whenever the theme changes.
    pub fn to_visuals(&self) -> Visuals {
        let mut v = if self.dark {
            Visuals::dark()
        } else {
            Visuals::light()
        };

        let fg = self.foreground();
        let muted = self.muted();
        let border = self.border();
        let hover = self.hover();
        let accent_fg = contrast_for(self.accent);

        v.window_fill = self.background();
        v.panel_fill = self.background();
        v.faint_bg_color = muted;
        v.extreme_bg_color = self.background();

        v.override_text_color = Some(fg);

        // Buttons inherit from widgets.inactive (idle state) /
        // hovered / active. The egui `Button` widget reads these
        // directly; selectable_label reads `selection.bg_fill` for
        // the on-state.
        v.widgets.noninteractive.bg_fill = self.background();
        v.widgets.noninteractive.weak_bg_fill = self.background();
        v.widgets.noninteractive.bg_stroke = egui::Stroke::new(1.0, border);
        v.widgets.noninteractive.fg_stroke = egui::Stroke::new(1.0, fg);

        v.widgets.inactive.bg_fill = muted;
        v.widgets.inactive.weak_bg_fill = muted;
        v.widgets.inactive.bg_stroke = egui::Stroke::new(1.0, border);
        v.widgets.inactive.fg_stroke = egui::Stroke::new(1.0, fg);
        v.widgets.inactive.corner_radius = egui::CornerRadius::same(6);

        v.widgets.hovered.bg_fill = hover;
        v.widgets.hovered.weak_bg_fill = hover;
        v.widgets.hovered.bg_stroke = egui::Stroke::new(1.0, border);
        v.widgets.hovered.fg_stroke = egui::Stroke::new(1.0, fg);
        v.widgets.hovered.corner_radius = egui::CornerRadius::same(6);

        v.widgets.active.bg_fill = self.accent;
        v.widgets.active.weak_bg_fill = self.accent;
        v.widgets.active.bg_stroke = egui::Stroke::new(1.0, self.accent);
        v.widgets.active.fg_stroke = egui::Stroke::new(1.0, accent_fg);
        v.widgets.active.corner_radius = egui::CornerRadius::same(6);

        // `selectable_label` reads these for the on-state — what we
        // use for the Pen / Eraser toggle highlight.
        v.selection.bg_fill = self.accent;
        v.selection.stroke = egui::Stroke::new(1.0, accent_fg);

        v
    }
}

impl Default for DrawingTheme {
    fn default() -> Self {
        Self::dark()
    }
}

/// Pick a contrasting foreground (black or white) for a given
/// background. Simple luminance test — `Y = 0.299R + 0.587G + 0.114B`
/// against the standard mid-grey threshold. Used for accent fg so a
/// user-picked light accent gets dark icons + a dark accent gets
/// light icons without further tuning.
fn contrast_for(bg: Color32) -> Color32 {
    let r = bg.r() as f32;
    let g = bg.g() as f32;
    let b = bg.b() as f32;
    let luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    if luminance > 140.0 {
        Color32::from_rgb(20, 20, 20)
    } else {
        Color32::from_rgb(245, 245, 245)
    }
}
