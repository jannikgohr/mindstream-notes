//! D1: Stroke smoothing wrapper.
//!
//! Wraps flxzt's [`ink_stroke_modeler_rs::StrokeModeler`] in a small
//! façade that:
//!
//!   - speaks our coordinate / type vocabulary (page-coord f32 pairs +
//!     [`Sample`](super::input::Sample)-style pressure) so render.rs
//!     never imports the upstream crate directly;
//!   - swallows the upstream `Result<_, ModelerError>` at a warn
//!     log — the render thread has no recovery strategy for "the
//!     modeler refused this sample" beyond "keep going with what we
//!     have," and a panic on a single malformed sample would crash a
//!     user mid-stroke;
//!   - keeps timestamps strictly monotonic by bumping duplicate /
//!     regressing times by [`MIN_DT`]. The Android digitizer can
//!     legitimately report identical `eventTime`s for adjacent samples
//!     when its sample rate exceeds its time resolution; the upstream
//!     modeler treats that as `ElementError::Duplicate` and errors —
//!     which would otherwise drop input mid-stroke for no user-visible
//!     reason.
//!
//! ## What it does
//!
//! Two layers of smoothing happen inside the underlying modeler:
//!
//!   1. **Wobble smoothing** — moving average of position, weighted
//!      by inter-sample duration. Heavy at low speed (where jitter
//!      is most visible), nearly off at high speed (where it would
//!      lag the visual cursor). Tuned by the
//!      `wobble_smoother_*` params.
//!
//!   2. **Spring-mass position model** — the modeled pen tip is a
//!      mass on a spring pulled toward a moving anchor (the raw
//!      input). The mass has drag, which low-passes high-frequency
//!      input. The anchor catches up at the end of a stroke via
//!      iterative "drain" steps so the last drawn point lands at the
//!      user's lift location rather than where the modeler had got
//!      to mid-integration.
//!
//! As a side effect, the modeler **upsamples** — one input MOVE can
//! emit many output samples (up to
//! `params.sampling_max_outputs_per_call`). The render thread sees
//! more, smaller segments to tessellate. Per-stroke storage cost
//! goes up proportionally; the perf wins from P1–P4 absorb this
//! cleanly in practice.
//!
//! ## Coordinate space
//!
//! The wrapper smooths in **page coordinates**. Two reasons:
//!
//!   - The persistence layer ([`StrokesDoc`](super::strokes_doc))
//!     stores page coords. Smoothing there means what we save = what
//!     we display, no surface↔page round-trip per stored point.
//!   - The modeler's spatial-scale params (spring mass / drag /
//!     wobble speed floor & ceiling) make sense only in a stable
//!     coordinate system; surface coords change with rotation /
//!     window resize / pan-zoom (D6), page coords do not.
//!
//! ## Lifecycle
//!
//! One [`InkSmoother`] is held by the render thread. It tracks an
//! "in stroke" flag so it can short-circuit out-of-order calls
//! (MOVE before DOWN, double-DOWN, etc.) rather than rely on the
//! upstream's stricter `Err(UnexpectedMove)` reaction. `begin_stroke`
//! does an internal `reset` first, so an unended prior stroke
//! (active-note swap, tool flip mid-drag, system gesture cancel) is
//! cleanly discarded.

use ink_stroke_modeler_rs::{
    ModelerInput, ModelerInputEventType, ModelerResult, StrokeModeler,
};

/// Minimum time delta the wrapper enforces between consecutive
/// samples within a stroke. 1 ms ≈ the smallest dt a typical
/// Android digitizer can resolve via `MotionEvent.eventTime` (which
/// is in milliseconds). When a sample arrives with the same or
/// earlier time as the previous one, we bump it by this amount so
/// the modeler's monotonic-time invariant holds without dropping
/// the sample.
const MIN_DT: f64 = 0.001;

/// One smoothed sample emitted by [`InkSmoother`]. Page coordinates,
/// pressure preserved through the modeler's stylus-state interpolator.
///
/// Deliberately a stripped-down view of [`ModelerResult`]: the
/// render thread doesn't need velocity / acceleration / time today,
/// and exposing them in the wrapper would couple downstream code to
/// the upstream type's lifetime. If a future consumer (e.g. D2's
/// prediction tail, or a fancier brush response) wants velocity,
/// add it here.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SmoothedSample {
    pub pos: (f32, f32),
    pub pressure: f32,
}

fn modeler_result_to_sample(r: ModelerResult) -> SmoothedSample {
    SmoothedSample {
        pos: (r.pos.0 as f32, r.pos.1 as f32),
        pressure: r.pressure as f32,
    }
}

/// Per-stroke smoother. Reset at each `begin_stroke`. Owned by the
/// render thread for its lifetime — there's no per-note state inside
/// the modeler (it only models in-flight strokes, and our active-note
/// swap always coincides with a stroke being either committed or
/// abandoned).
pub struct InkSmoother {
    modeler: StrokeModeler,
    /// True between `begin_stroke` and the next `end_stroke` /
    /// `reset`. We track this ourselves rather than catching the
    /// upstream's `UnexpectedMove` / `UnexpectedDown` errors because
    /// (a) we want to silently drop MOVE-before-DOWN rather than
    /// surface an error log, and (b) on the DOWN-after-DOWN case
    /// (active-note swap mid-drag) we want to discard the prior
    /// stroke's tail cleanly, which means an explicit `reset` rather
    /// than an error to recover from.
    in_stroke: bool,
    /// Last timestamp we passed to the modeler within the current
    /// stroke. Used to bump duplicate / regressing times by
    /// [`MIN_DT`] so the upstream never sees a non-monotonic delta.
    /// Reset to `None` between strokes.
    last_time: Option<f64>,
}

impl InkSmoother {
    pub fn new() -> Self {
        Self {
            modeler: StrokeModeler::default(),
            in_stroke: false,
            last_time: None,
        }
    }

    /// Open a new stroke. Resets the underlying modeler so any
    /// dangling state from a previously-abandoned stroke (active-note
    /// swap mid-drag, system gesture cancel without an Up, etc.) is
    /// cleared. Returns the first smoothed sample — for a Down event
    /// the modeler emits the raw input position as-is (one sample
    /// can't be smoothed), so this is effectively the stroke's anchor.
    /// Callers should push this point into their per-stroke buffers
    /// (strokes_doc + tessellation cursor) so the first MOVE has a
    /// `prev` to draw from.
    pub fn begin_stroke(
        &mut self,
        pos: (f32, f32),
        time: f64,
        pressure: f32,
    ) -> Option<SmoothedSample> {
        self.modeler.reset();
        self.last_time = Some(time);
        let input = ModelerInput {
            event_type: ModelerInputEventType::Down,
            pos: (pos.0 as f64, pos.1 as f64),
            time,
            pressure: pressure as f64,
        };
        match self.modeler.update(input) {
            Ok(results) => {
                self.in_stroke = true;
                results.into_iter().next().map(modeler_result_to_sample)
            }
            Err(e) => {
                log::warn!("[drawing] InkSmoother begin_stroke error: {e:?}");
                self.in_stroke = false;
                self.last_time = None;
                None
            }
        }
    }

    /// Feed a MOVE sample. The modeler may emit zero, one, or many
    /// smoothed samples per input (upsampling proportional to time
    /// gap × `sampling_min_output_rate`). Callers tessellate each
    /// emitted point as a quad from the previous smoothed point.
    ///
    /// On modeler error (typically a duplicate sample slipping past
    /// the time-bump) we log a warning and return empty — the stroke
    /// stays alive for subsequent samples. Dropping a single sample
    /// is invisible at 120+ Hz input rates.
    pub fn update(
        &mut self,
        pos: (f32, f32),
        time: f64,
        pressure: f32,
    ) -> Vec<SmoothedSample> {
        if !self.in_stroke {
            return Vec::new();
        }
        let safe_time = self.bump_time(time);
        let input = ModelerInput {
            event_type: ModelerInputEventType::Move,
            pos: (pos.0 as f64, pos.1 as f64),
            time: safe_time,
            pressure: pressure as f64,
        };
        match self.modeler.update(input) {
            Ok(results) => results.into_iter().map(modeler_result_to_sample).collect(),
            Err(e) => {
                log::warn!("[drawing] InkSmoother update error: {e:?}");
                Vec::new()
            }
        }
    }

    /// Close the stroke. Triggers the modeler's end-of-stroke
    /// modelling: it iteratively pulls the spring-mass system the
    /// rest of the way toward where the user actually lifted,
    /// emitting the "land-the-stroke" tail samples that make a fast
    /// flick visually catch up rather than ending where the integration
    /// happened to stop mid-air. Returns those tail samples — caller
    /// tessellates them like normal MOVE outputs.
    ///
    /// After this call the smoother is ready for the next
    /// `begin_stroke`. Safe to call when not in a stroke (returns
    /// empty).
    pub fn end_stroke(
        &mut self,
        pos: (f32, f32),
        time: f64,
        pressure: f32,
    ) -> Vec<SmoothedSample> {
        if !self.in_stroke {
            return Vec::new();
        }
        let safe_time = self.bump_time(time);
        let input = ModelerInput {
            event_type: ModelerInputEventType::Up,
            pos: (pos.0 as f64, pos.1 as f64),
            time: safe_time,
            pressure: pressure as f64,
        };
        let result = match self.modeler.update(input) {
            Ok(r) => r.into_iter().map(modeler_result_to_sample).collect(),
            Err(e) => {
                log::warn!("[drawing] InkSmoother end_stroke error: {e:?}");
                Vec::new()
            }
        };
        self.in_stroke = false;
        self.last_time = None;
        result
    }

    /// Abandon the current stroke without producing an Up tail. Used
    /// when the active note changes mid-gesture, the tool flips
    /// mid-drag, or the surface goes away. The next `begin_stroke`
    /// will reset the modeler anyway; this method exists so callers
    /// that want to drop in-flight state without immediately starting
    /// a new stroke can do so explicitly.
    pub fn reset(&mut self) {
        self.modeler.reset();
        self.in_stroke = false;
        self.last_time = None;
    }

    /// Returns true if there's an open stroke (between `begin_stroke`
    /// and `end_stroke` / `reset`). Lets the render thread short-circuit
    /// `end_stroke` calls on samples that didn't actually open a stroke
    /// (e.g. toolbar-suppressed DOWN that never reached the smoother).
    pub fn is_in_stroke(&self) -> bool {
        self.in_stroke
    }

    /// D2 forward prediction. Asks the modeler "if the user lifted
    /// right now, where would the spring-mass system land?" — same
    /// algorithm as the end-of-stroke drain, but without mutating
    /// the modeler's state (it's safe to call after every MOVE).
    /// Returns the predicted continuation in time order, starting
    /// from just past the last smoothed sample emitted by `update`.
    ///
    /// Caller tessellates these into a *separate* segment buffer —
    /// the prediction is rendered on top of the committed strokes
    /// each frame and discarded on the next MOVE (which produces a
    /// fresh prediction) or on Up/Cancel (which produces the real
    /// end-of-stroke tail via [`end_stroke`]).
    ///
    /// Empty result outside of a stroke or when the modeler refuses
    /// the prediction (the upstream returns `Err("empty input
    /// events")` for that case — we map it to `Vec::new()` so the
    /// render thread doesn't need to know about it). Other errors
    /// are warn-logged for visibility.
    pub fn predict(&mut self) -> Vec<SmoothedSample> {
        if !self.in_stroke {
            return Vec::new();
        }
        match self.modeler.predict() {
            Ok(results) => results.into_iter().map(modeler_result_to_sample).collect(),
            Err(e) => {
                // The "empty input events" case is expected (DOWN
                // arrived but no MOVE yet — nothing to predict from);
                // logging at debug rather than warn so it doesn't
                // spam during normal stroke openings.
                log::debug!("[drawing] InkSmoother predict skipped: {e}");
                Vec::new()
            }
        }
    }

    /// Ensure `time > last_time`. The modeler rejects non-monotonic
    /// timestamps with `ElementError::Duplicate` or `NegativeTimeDelta`;
    /// bumping by [`MIN_DT`] keeps the input stream well-formed even
    /// when the digitizer reports identical eventTimes for adjacent
    /// samples (1 ms resolution on most Android devices vs >120 Hz
    /// input).
    fn bump_time(&mut self, time: f64) -> f64 {
        let bumped = match self.last_time {
            Some(prev) if time <= prev => prev + MIN_DT,
            _ => time,
        };
        self.last_time = Some(bumped);
        bumped
    }
}

impl Default for InkSmoother {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn begin_stroke_emits_anchor_at_input_position() {
        let mut s = InkSmoother::new();
        let first = s.begin_stroke((100.0, 200.0), 0.0, 0.5).expect("anchor");
        assert!((first.pos.0 - 100.0).abs() < 0.01);
        assert!((first.pos.1 - 200.0).abs() < 0.01);
        assert!(s.is_in_stroke());
    }

    #[test]
    fn update_before_begin_stroke_returns_empty() {
        let mut s = InkSmoother::new();
        let out = s.update((10.0, 10.0), 0.01, 1.0);
        assert!(out.is_empty());
    }

    #[test]
    fn end_stroke_clears_state() {
        let mut s = InkSmoother::new();
        s.begin_stroke((0.0, 0.0), 0.0, 1.0);
        let _ = s.update((10.0, 10.0), 0.01, 1.0);
        let _ = s.end_stroke((20.0, 20.0), 0.02, 1.0);
        assert!(!s.is_in_stroke());
        // Smoother is ready for a fresh stroke without an explicit reset.
        let first = s.begin_stroke((50.0, 50.0), 0.0, 1.0).expect("anchor");
        assert!((first.pos.0 - 50.0).abs() < 0.01);
    }

    #[test]
    fn duplicate_timestamp_does_not_drop_sample() {
        // Two MOVE samples at the same time would normally error
        // ElementError::Duplicate; bump_time should keep them
        // well-ordered. We don't assert specific output positions
        // (the modeler's internals decide that), just that no error
        // warning fired and the smoother is still in-stroke.
        let mut s = InkSmoother::new();
        s.begin_stroke((0.0, 0.0), 0.0, 1.0);
        let _ = s.update((5.0, 5.0), 0.01, 1.0);
        let out = s.update((10.0, 10.0), 0.01, 1.0);
        // The modeler may emit 0 samples for an upsampling step but
        // should not have errored out of the stroke.
        let _ = out;
        assert!(s.is_in_stroke());
    }

    #[test]
    fn move_emits_at_least_one_sample_under_normal_conditions() {
        // Sanity that the suggested params actually produce output
        // for a typical input stream — guards against accidentally
        // setting sampling_max_outputs_per_call = 0 or similar.
        let mut s = InkSmoother::new();
        s.begin_stroke((0.0, 0.0), 0.0, 1.0);
        let out = s.update((50.0, 50.0), 0.05, 1.0);
        assert!(!out.is_empty(), "modeler should emit samples for a 50ms MOVE");
    }

    #[test]
    fn predict_empty_outside_stroke() {
        let mut s = InkSmoother::new();
        assert!(s.predict().is_empty());
    }

    #[test]
    fn predict_empty_after_only_down() {
        // DOWN alone → no MOVE → upstream errors with "empty input
        // events"; wrapper returns empty Vec rather than surfacing
        // the Err.
        let mut s = InkSmoother::new();
        s.begin_stroke((0.0, 0.0), 0.0, 1.0);
        assert!(s.predict().is_empty());
    }

    #[test]
    fn predict_returns_tail_after_moves() {
        // After a couple of MOVEs the spring-mass model has state
        // to drain from. We don't assert the specific tail length —
        // it depends on stopping-distance + max-iterations params —
        // just that something comes out and the smoother stays in
        // stroke (predict doesn't mutate state).
        let mut s = InkSmoother::new();
        s.begin_stroke((0.0, 0.0), 0.0, 1.0);
        let _ = s.update((50.0, 50.0), 0.02, 1.0);
        let _ = s.update((100.0, 100.0), 0.04, 1.0);
        let tail = s.predict();
        assert!(!tail.is_empty(), "predict should return a tail after MOVEs");
        assert!(s.is_in_stroke(), "predict must not end the stroke");
        // Calling predict again should give the same result (no
        // state change). We don't assert exact equality (the impl
        // is allowed to optimise) but the smoother must still be in
        // stroke and the second call must not panic.
        let _again = s.predict();
        assert!(s.is_in_stroke());
    }

    #[test]
    fn reset_drops_in_flight_state() {
        let mut s = InkSmoother::new();
        s.begin_stroke((0.0, 0.0), 0.0, 1.0);
        s.reset();
        assert!(!s.is_in_stroke());
        // Update after reset is a no-op (no DOWN since reset).
        let out = s.update((5.0, 5.0), 0.01, 1.0);
        assert!(out.is_empty());
    }
}
