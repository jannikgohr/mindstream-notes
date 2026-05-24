//! Platform-neutral input shapes for the drawing surface.
//!
//! The render thread consumes [`Sample`] without knowing which OS
//! produced it. Each platform's input layer (today: Android's JNI
//! `pushPoint` in `crate::drawing::jni`; future: winit `WindowEvent`
//! on desktop, `UITouch` on iOS) translates its native event shape
//! into a `Sample` and hands it to `render::push_sample`. This is
//! one half of the R4 abstraction in `docs/native-egui-layer/02-roadmap.md`
//! — the other half (a `trait InputSource` that the render thread
//! pulls from) lands when more than one platform exists.
//!
//! Notably absent (per the roadmap, deferred until they have a
//! consumer):
//!   - `StylusGesture` (discrete Apple-Pencil-style events) — D8.
//!   - `tilt`, `azimuth` — open; revisit once the smoothing / brush
//!     pipeline can use them.
//!
//! Stylus buttons (per C6) are present as `Sample.buttons: u32` — a
//! raw bitmask matching `android.view.MotionEvent.BUTTON_*` so the
//! JNI translation is a transparent forward. Promote to a typed
//! `bitflags` once a second consumer (D8's mapping layer) appears.
//!
//! Lives in a host-buildable file (no `cfg(target_os = "android")`)
//! so the conversion helpers + enum shape can be unit-tested
//! without an Android target.

/// Which input device produced a sample. Wire-compatible numeric
/// values with `android.view.MotionEvent.TOOL_TYPE_*` so the JNI
/// translation is a simple `from_raw` rather than a remap; the
/// renderer matches on the enum and never sees the raw int.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ToolKind {
    /// Unknown / unreported. Treated like Finger by the renderer
    /// (no pressure, debug-black colour) since that's the safest
    /// default for an unknown digitizer.
    Unknown,
    Finger,
    /// Pen-family — S Pen, Surface Pen, Apple Pencil, generic
    /// active stylus. Reports pressure on devices that support it.
    Stylus,
    Mouse,
    /// Pen-family, eraser end engaged (S Pen flipped over, Wacom
    /// eraser tip). Conceptually a pen for input purposes; the UX
    /// layer decides whether to switch to an eraser tool mode.
    Eraser,
}

impl ToolKind {
    /// Translate a raw `MotionEvent.TOOL_TYPE_*` int. Unknown
    /// values (including from a future Android version that adds a
    /// type we don't recognise) collapse to `Unknown` rather than
    /// panic — losing pen-detection on a new device is recoverable;
    /// crashing isn't.
    pub fn from_raw(value: i32) -> Self {
        match value {
            1 => Self::Finger,
            2 => Self::Stylus,
            3 => Self::Mouse,
            4 => Self::Eraser,
            _ => Self::Unknown,
        }
    }
}

/// Phase of a pointer gesture. Numeric values match
/// `android.view.MotionEvent.ACTION_*`:
/// `DOWN=0`, `UP=1`, `MOVE=2`, `CANCEL=3`.
///
/// Down: first contact (opens a new stroke).
/// Move: continuous motion (appends to the open stroke).
/// Up: clean lift (commits the stroke).
/// Cancel: gesture cancelled by the system (treated as Up — we'd
/// rather keep a partial stroke than throw away the user's work
/// because, say, a notification stole focus).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum SampleAction {
    Down,
    Up,
    Move,
    Cancel,
}

impl SampleAction {
    /// Translate a raw `MotionEvent.ACTION_*` int. Returns `None`
    /// for actions we don't model (HOVER_MOVE, OUTSIDE, pointer
    /// indices > 0, …) so the render thread can ignore them rather
    /// than treat them as a recognised phase.
    pub fn from_raw(value: i32) -> Option<Self> {
        match value {
            0 => Some(Self::Down),
            1 => Some(Self::Up),
            2 => Some(Self::Move),
            3 => Some(Self::Cancel),
            _ => None,
        }
    }
}

/// Bit values for `Sample.buttons` — mirror
/// `android.view.MotionEvent.BUTTON_*` constants verbatim so the
/// JNI side can forward `event.buttonState` without translation.
/// We only expose the bits we currently care about; the others sit
/// in the bitmask unread until someone wants them.
pub mod buttons {
    /// S Pen / Surface Pen / Wacom side barrel button — the most
    /// common "modifier key on a pen" surface. Held while drawing
    /// = the de-facto "switch to eraser" gesture on Samsung, the
    /// "right-click" surface on Surface Pen, etc.
    pub const STYLUS_PRIMARY: u32 = 0x20;
    /// Rare second barrel button (some Wacom pens). Wired through
    /// so a future toolbar can bind it, even though no shipping
    /// device under test exercises it today.
    pub const STYLUS_SECONDARY: u32 = 0x40;
}

/// One pointer sample in surface-pixel coordinates.
///
/// "Surface-pixel" rather than page coordinates because the render
/// thread is the one that owns the view transform and applies
/// `surface_to_page` — keeping that decision on the render side
/// means a future pan/zoom (D6) doesn't have to plumb anything
/// extra through the input layer.
#[derive(Copy, Clone, Debug)]
pub struct Sample {
    pub x: f32,
    pub y: f32,
    /// 0..1 normalised pressure. 1.0 substituted at the platform
    /// boundary for devices that don't report pressure (the
    /// Android Kotlin side does this for finger touches).
    pub pressure: f32,
    pub tool: ToolKind,
    /// Held-button bitmask, raw from the platform (Android's
    /// `MotionEvent.buttonState`). Bit values are in
    /// [`buttons`]; helpers like
    /// [`Sample::has_stylus_primary_button`] do the bit test.
    /// Always 0 on platforms / events that don't carry button
    /// state (most finger touches).
    pub buttons: u32,
    pub action: SampleAction,
}

impl Sample {
    /// True when the stylus's primary barrel button is being held
    /// during this sample. Used by the renderer at ACTION_DOWN to
    /// pick a debug colour; D8 will wire this into a real
    /// UX-policy mapping (e.g. "button held = eraser mode").
    pub fn has_stylus_primary_button(&self) -> bool {
        self.buttons & buttons::STYLUS_PRIMARY != 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_kind_from_raw_maps_known_values() {
        assert_eq!(ToolKind::from_raw(0), ToolKind::Unknown);
        assert_eq!(ToolKind::from_raw(1), ToolKind::Finger);
        assert_eq!(ToolKind::from_raw(2), ToolKind::Stylus);
        assert_eq!(ToolKind::from_raw(3), ToolKind::Mouse);
        assert_eq!(ToolKind::from_raw(4), ToolKind::Eraser);
    }

    #[test]
    fn tool_kind_from_raw_unknown_value_is_unknown() {
        // Hypothetical future TOOL_TYPE_* the JNI side hasn't seen
        // shouldn't poison the renderer.
        assert_eq!(ToolKind::from_raw(99), ToolKind::Unknown);
        assert_eq!(ToolKind::from_raw(-1), ToolKind::Unknown);
    }

    #[test]
    fn sample_action_from_raw_maps_known_phases() {
        assert_eq!(SampleAction::from_raw(0), Some(SampleAction::Down));
        assert_eq!(SampleAction::from_raw(1), Some(SampleAction::Up));
        assert_eq!(SampleAction::from_raw(2), Some(SampleAction::Move));
        assert_eq!(SampleAction::from_raw(3), Some(SampleAction::Cancel));
    }

    #[test]
    fn sample_action_from_raw_unknown_is_none() {
        // ACTION_HOVER_MOVE = 7, ACTION_OUTSIDE = 4, pointer events
        // with index in the high bits — none of these are recognised
        // stroke phases; ignored.
        assert_eq!(SampleAction::from_raw(4), None);
        assert_eq!(SampleAction::from_raw(7), None);
        assert_eq!(SampleAction::from_raw(-1), None);
    }

    fn sample_with_buttons(buttons: u32) -> Sample {
        Sample {
            x: 0.0,
            y: 0.0,
            pressure: 1.0,
            tool: ToolKind::Stylus,
            buttons,
            action: SampleAction::Down,
        }
    }

    #[test]
    fn stylus_primary_button_detected_when_bit_set() {
        assert!(sample_with_buttons(buttons::STYLUS_PRIMARY).has_stylus_primary_button());
        // Mixed with other bits (e.g. the system also reporting
        // BUTTON_PRIMARY = 0x1 for the pen tip touch on some devices)
        // — still detected.
        assert!(sample_with_buttons(buttons::STYLUS_PRIMARY | 0x1).has_stylus_primary_button());
    }

    #[test]
    fn stylus_primary_button_absent_when_bit_clear() {
        // No buttons.
        assert!(!sample_with_buttons(0).has_stylus_primary_button());
        // Other buttons held but not stylus-primary.
        assert!(!sample_with_buttons(buttons::STYLUS_SECONDARY).has_stylus_primary_button());
        assert!(!sample_with_buttons(0x1 /* BUTTON_PRIMARY */).has_stylus_primary_button());
    }
}
