//! Yrs-backed stroke storage façade.
//!
//! Same architectural shape as `crate::sync::yrs_doc` (the markdown
//! façade): keep all `yrs` API usage inside this file so the rest of
//! the drawing module never imports `yrs` directly. That gives us
//! one place to pin the version, one place to debug encoding
//! choices, and one place to revisit if we ever swap CRDT libs.
//!
//! Wire format: v1 updates (`encode_state_as_update_v1` /
//! `Update::decode_v1`). Mirrors what the JS editor uses for
//! markdown notes — same reasoning, no need to invent a separate
//! envelope for ink.
//!
//! Schema layout (lives at the Doc root):
//!
//!   strokes: Y.Array<Y.Map>
//!     each stroke map carries:
//!       id:         Any::String(uuid)          — stable id for collab merge
//!       color:      Any::BigInt(u32 rgba)      — packed colour; default opaque black
//!       width:      Any::Number(f64)           — stroke width in page units
//!       tombstoned: Any::Bool(false)           — eraser flips this to true
//!       points:     Y.Array<f64>               — flat [x0, y0, x1, y1, …]
//!                                                 in page coords
//!       pressures:  Y.Array<f64>               — parallel to points,
//!                                                 one entry per (x,y) pair.
//!                                                 Absent on pre-C3 strokes,
//!                                                 in which case readers
//!                                                 default each point to 1.0.
//!
//! Why a flat points array (vs an array of {x, y} maps): tighter
//! storage, simpler encode/decode, and we don't need per-point
//! collab anyway — points within a single stroke are written by a
//! single device in a tight burst. Inter-stroke ordering and
//! tombstoning are the only collab-interesting bits, and those live
//! at the stroke-map level. The parallel `pressures` array is the
//! same trade-off — kept beside `points` instead of widening each
//! entry to a `{x, y, p}` map.
//!
//! Backward compat: adding `pressures` to a stroke is purely
//! additive, so a doc written by an older app version (no
//! `pressures` field at all) deserialises without a migration —
//! readers fall back to 1.0 per point. That's why there's no schema
//! version bump for C3.
//!
//! What's NOT in the schema yet (deferred per the roadmap):
//!   - tilt per point (open; revisit if D1's stroke modeller wants it)
//!   - tool type per stroke (currently only reflected indirectly via
//!     `color` — the renderer picks blue for stylus/eraser strokes
//!     and black otherwise; D5 replaces that mapping with a real
//!     user-chosen palette)
//!   - actual user-chosen width (D5)
//!   - a top-level schema-version map (revisit when the schema
//!     actually changes in a non-additive way)

use yrs::any::Any;
use yrs::updates::decoder::Decode;
use yrs::{
    Array, ArrayPrelim, ArrayRef, Doc, Map, MapPrelim, Out, ReadTxn, StateVector, Transact, Update,
};

const STROKES_KEY: &str = "strokes";
const FIELD_TOMBSTONED: &str = "tombstoned";
const FIELD_POINTS: &str = "points";
const FIELD_PRESSURES: &str = "pressures";
const FIELD_ID: &str = "id";
const FIELD_COLOR: &str = "color";
const FIELD_WIDTH: &str = "width";

/// Default stroke colour: opaque black, packed as 0xAARRGGBB.
/// Substituted on read for strokes that have no `color` field
/// (legacy data or test fixtures). The renderer chooses the actual
/// color at `begin_stroke` time based on input-device tool type;
/// this constant is purely the "what colour was this stroke when
/// the writer didn't tell us" fallback.
pub const DEFAULT_COLOR: u32 = 0xFF00_0000;
/// Default stroke width in page units (1 unit = 1/144 inch).
const DEFAULT_WIDTH: f64 = 1.0;
/// Pressure value substituted on read for points written by an
/// older app version (no `pressures` array) or by an input device
/// that doesn't report pressure. Treated as "full pressure" so
/// future variable-width rendering (C4) doesn't render those points
/// hair-thin.
const FALLBACK_PRESSURE: f32 = 1.0;

/// Wrapper around a `yrs::Doc` holding the stroke document for one
/// ink note. See module header for the schema.
///
/// Cheap to construct; cheap to clone-into-bytes via `encode`; the
/// expensive operation is `from_bytes` on a doc with many strokes
/// (proportional to total point count). For collab the same `Doc`
/// instance can plug into a yjs Provider — that's C5.
pub struct StrokesDoc {
    doc: Doc,
    strokes: ArrayRef,
    /// Points array of the in-progress stroke (set between
    /// `begin_stroke` and `end_stroke`). None outside a stroke.
    in_progress_points: Option<ArrayRef>,
    /// Parallel pressures array for the in-progress stroke. Same
    /// life-cycle as `in_progress_points`; kept as a separate handle
    /// so `push_point` doesn't have to re-resolve it from the stroke
    /// map on every sample.
    in_progress_pressures: Option<ArrayRef>,
}

impl StrokesDoc {
    /// Brand-new empty doc — no strokes, no metadata. Used for ink
    /// notes that have never been saved.
    pub fn new() -> Self {
        let doc = Doc::new();
        let strokes = doc.get_or_insert_array(STROKES_KEY);
        Self {
            doc,
            strokes,
            in_progress_points: None,
            in_progress_pressures: None,
        }
    }

    /// Re-hydrate from a previously `encode`d byte slice. An empty
    /// slice is treated the same as `new()` (no strokes), so
    /// fresh-note callers can pass `&[]` without branching.
    pub fn from_bytes(bytes: &[u8]) -> Self {
        let me = Self::new();
        if !bytes.is_empty() {
            let mut tx = me.doc.transact_mut();
            if let Ok(update) = Update::decode_v1(bytes) {
                let _ = tx.apply_update(update);
            }
        }
        me
    }

    /// Encode the current state as a v1 update — the wire format
    /// the rest of the app uses for note CRDTs. Suitable for
    /// stashing in `note.yrs_state`.
    pub fn encode(&self) -> Vec<u8> {
        let tx = self.doc.transact();
        tx.encode_state_as_update_v1(&StateVector::default())
    }

    /// Open a new stroke. Subsequent `push_point` calls append to
    /// this stroke's points array until `end_stroke` is called.
    /// `color` is the packed 0xAARRGGBB the renderer should use for
    /// this stroke (typically chosen at the call site based on
    /// input-device tool type or a future user-picked palette).
    /// If a stroke was already open (no matching end_stroke), it's
    /// silently committed — defensive against missed pen-up events.
    pub fn begin_stroke(&mut self, color: u32) {
        let mut tx = self.doc.transact_mut();
        // Empty MapPrelim first; field inserts below avoid having
        // to thread Any-typed initial fields through MapPrelim's
        // generic. Slightly more transactions but much clearer.
        let len = self.strokes.len(&tx);
        let stroke_map = self.strokes.insert(&mut tx, len, MapPrelim::default());
        let stroke_id = format!("stroke_{}", uuid::Uuid::new_v4());
        stroke_map.insert(&mut tx, FIELD_ID, Any::from(stroke_id));
        // u32 → i64 widen for yrs `Any::BigInt` (which is i64).
        // Cast is safe because u32 fits unambiguously; the visitor
        // on read clamps back to u32.
        stroke_map.insert(&mut tx, FIELD_COLOR, Any::BigInt(color as i64));
        stroke_map.insert(&mut tx, FIELD_WIDTH, Any::Number(DEFAULT_WIDTH));
        stroke_map.insert(&mut tx, FIELD_TOMBSTONED, Any::Bool(false));
        let points = stroke_map.insert(&mut tx, FIELD_POINTS, ArrayPrelim::default());
        let pressures = stroke_map.insert(&mut tx, FIELD_PRESSURES, ArrayPrelim::default());
        // Have to drop tx before storing the ArrayRefs into self —
        // ArrayRef itself is fine to hold across transactions, but
        // we want the begin_stroke transaction to commit before we
        // start receiving samples.
        drop(tx);
        self.in_progress_points = Some(points);
        self.in_progress_pressures = Some(pressures);
    }

    /// Append a single point (in page coordinates) and its pressure
    /// to the in-progress stroke. `pressure` is the raw value from
    /// the input device (typically 0..1 for stylus, 1.0 for inputs
    /// that don't report pressure); stored as-is so future
    /// normalisation policies can live in the renderer rather than
    /// being baked into the wire format. No-op outside `begin_stroke`
    /// / `end_stroke` — protects against stray MOVE samples between
    /// strokes.
    pub fn push_point(&mut self, x: f32, y: f32, pressure: f32) {
        let (Some(points), Some(pressures)) = (
            self.in_progress_points.as_ref(),
            self.in_progress_pressures.as_ref(),
        ) else {
            return;
        };
        let mut tx = self.doc.transact_mut();
        points.push_back(&mut tx, Any::Number(x as f64));
        points.push_back(&mut tx, Any::Number(y as f64));
        pressures.push_back(&mut tx, Any::Number(pressure as f64));
    }

    /// Close the in-progress stroke. Idempotent.
    pub fn end_stroke(&mut self) {
        self.in_progress_points = None;
        self.in_progress_pressures = None;
    }

    /// Tombstone every stroke. Used by the Clear toolbar button —
    /// keeps the strokes in the doc (so concurrent edits from
    /// other devices that re-add to the same stroke merge cleanly)
    /// but hides them from the renderer via the `tombstoned` flag.
    pub fn tombstone_all(&mut self) {
        let mut tx = self.doc.transact_mut();
        let len = self.strokes.len(&tx);
        for i in 0..len {
            let Some(Out::YMap(stroke)) = self.strokes.get(&tx, i) else {
                continue;
            };
            stroke.insert(&mut tx, FIELD_TOMBSTONED, Any::Bool(true));
        }
        // Drop the in-progress pointers too — Clear during a stroke
        // should also end that stroke.
        drop(tx);
        self.in_progress_points = None;
        self.in_progress_pressures = None;
    }

    /// Visit each non-tombstoned stroke.
    ///
    /// Backward compat:
    ///   - Strokes saved before C3 don't carry a `pressures` field —
    ///     the slice handed to the visitor is filled with
    ///     [`FALLBACK_PRESSURE`] (1.0) per point so the consumer can
    ///     treat all strokes uniformly. Pressure arrays present but
    ///     shorter than `points.len() / 2` (e.g. a remote-merge race
    ///     that committed `points` but not `pressures`) have
    ///     trailing positions filled the same way; longer arrays are
    ///     truncated.
    ///   - Strokes without a `color` field (legacy data or hand-
    ///     constructed test fixtures) get [`DEFAULT_COLOR`] (opaque
    ///     black).
    pub fn for_each_stroke<F>(&self, mut visit: F)
    where
        F: FnMut(StrokeView),
    {
        let tx = self.doc.transact();
        let len = self.strokes.len(&tx);
        for i in 0..len {
            let Some(Out::YMap(stroke)) = self.strokes.get(&tx, i) else {
                continue;
            };
            let tombstoned = matches!(
                stroke.get(&tx, FIELD_TOMBSTONED),
                Some(Out::Any(Any::Bool(true)))
            );
            if tombstoned {
                continue;
            }
            let Some(Out::YArray(points)) = stroke.get(&tx, FIELD_POINTS) else {
                continue;
            };
            let n = points.len(&tx);
            let mut flat: Vec<f32> = Vec::with_capacity(n as usize);
            for j in 0..n {
                if let Some(Out::Any(Any::Number(v))) = points.get(&tx, j) {
                    flat.push(v as f32);
                }
            }
            if flat.is_empty() {
                continue;
            }
            let expected_pressures = flat.len() / 2;
            let mut pressures: Vec<f32> = Vec::with_capacity(expected_pressures);
            if let Some(Out::YArray(stored)) = stroke.get(&tx, FIELD_PRESSURES) {
                let m = stored.len(&tx);
                for j in 0..m {
                    if let Some(Out::Any(Any::Number(v))) = stored.get(&tx, j) {
                        pressures.push(v as f32);
                    }
                }
            }
            // Pad missing / trailing positions with the fallback so
            // the visitor always sees pressures.len() == points/2.
            // Truncate extras the same way (a writer that pushed an
            // odd point doesn't get to grow the pressure array past
            // the matching point count).
            pressures.resize(expected_pressures, FALLBACK_PRESSURE);
            // Colour is stored as an i64 BigInt to fit yrs's Any
            // variants; cast back to u32. A doc without the field
            // (or with a malformed entry) falls back to the
            // module-level default so the consumer never has to
            // branch on missing colour.
            let color = match stroke.get(&tx, FIELD_COLOR) {
                Some(Out::Any(Any::BigInt(v))) => v as u32,
                _ => DEFAULT_COLOR,
            };
            visit(StrokeView {
                points: &flat,
                pressures: &pressures,
                color,
            });
        }
    }
}

/// One non-tombstoned stroke surfaced by [`StrokesDoc::for_each_stroke`].
///
/// Fields:
///   - `points`: flat `[x0, y0, x1, y1, …]` in page coordinates.
///   - `pressures`: parallel to `points`, one entry per (x, y) pair
///     (`pressures.len() == points.len() / 2`).
///   - `color`: packed 0xAARRGGBB the renderer chose at `begin_stroke`
///     time — opaque black for legacy strokes that pre-date the field.
///
/// Borrowed view; valid only for the duration of the visitor
/// callback. Copy out anything the caller wants to keep.
pub struct StrokeView<'a> {
    pub points: &'a [f32],
    pub pressures: &'a [f32],
    pub color: u32,
}

impl Default for StrokesDoc {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pull all visible stroke point lists into a Vec for assertion.
    /// Pressures + color are discarded here — tests that care about
    /// those use the dedicated collectors below.
    fn collect_strokes(doc: &StrokesDoc) -> Vec<Vec<f32>> {
        let mut out = Vec::new();
        doc.for_each_stroke(|view| out.push(view.points.to_vec()));
        out
    }

    /// Pair-wise (points, pressures) per stroke for assertions that
    /// exercise the C3 path.
    fn collect_strokes_with_pressure(doc: &StrokesDoc) -> Vec<(Vec<f32>, Vec<f32>)> {
        let mut out = Vec::new();
        doc.for_each_stroke(|view| {
            out.push((view.points.to_vec(), view.pressures.to_vec()));
        });
        out
    }

    /// Triple (points, pressures, color) per stroke for assertions
    /// that exercise the C4-color path.
    fn collect_strokes_with_color(doc: &StrokesDoc) -> Vec<(Vec<f32>, Vec<f32>, u32)> {
        let mut out = Vec::new();
        doc.for_each_stroke(|view| {
            out.push((view.points.to_vec(), view.pressures.to_vec(), view.color));
        });
        out
    }

    #[test]
    fn empty_doc_round_trips() {
        let doc = StrokesDoc::new();
        let bytes = doc.encode();
        let restored = StrokesDoc::from_bytes(&bytes);
        assert_eq!(collect_strokes(&restored), Vec::<Vec<f32>>::new());
    }

    #[test]
    fn from_empty_bytes_is_a_fresh_doc() {
        // Convenience case: callers can pass &[] for never-saved
        // notes without special-casing.
        let doc = StrokesDoc::from_bytes(&[]);
        assert!(collect_strokes(&doc).is_empty());
    }

    #[test]
    fn one_stroke_round_trips() {
        let mut doc = StrokesDoc::new();
        doc.begin_stroke(DEFAULT_COLOR);
        doc.push_point(10.0, 20.0, 1.0);
        doc.push_point(30.0, 40.0, 1.0);
        doc.push_point(50.0, 60.0, 1.0);
        doc.end_stroke();

        let bytes = doc.encode();
        let restored = StrokesDoc::from_bytes(&bytes);
        assert_eq!(
            collect_strokes(&restored),
            vec![vec![10.0, 20.0, 30.0, 40.0, 50.0, 60.0]]
        );
    }

    #[test]
    fn pressure_round_trips() {
        let mut doc = StrokesDoc::new();
        doc.begin_stroke(DEFAULT_COLOR);
        doc.push_point(0.0, 0.0, 0.25);
        doc.push_point(1.0, 1.0, 0.50);
        doc.push_point(2.0, 2.0, 0.75);
        doc.end_stroke();

        let bytes = doc.encode();
        let restored = StrokesDoc::from_bytes(&bytes);
        assert_eq!(
            collect_strokes_with_pressure(&restored),
            vec![(
                vec![0.0, 0.0, 1.0, 1.0, 2.0, 2.0],
                vec![0.25, 0.50, 0.75],
            )]
        );
    }

    #[test]
    fn color_round_trips() {
        // Pen-blue at 0xFF0066FF should come back bit-identical after
        // an encode/decode cycle.
        const PEN_BLUE: u32 = 0xFF00_66FF;
        let mut doc = StrokesDoc::new();
        doc.begin_stroke(PEN_BLUE);
        doc.push_point(0.0, 0.0, 1.0);
        doc.push_point(1.0, 1.0, 1.0);
        doc.end_stroke();

        let bytes = doc.encode();
        let restored = StrokesDoc::from_bytes(&bytes);
        let collected = collect_strokes_with_color(&restored);
        assert_eq!(collected.len(), 1);
        assert_eq!(collected[0].2, PEN_BLUE);
    }

    #[test]
    fn legacy_stroke_without_color_defaults_to_black() {
        // Hand-build a stroke that mimics a pre-color-aware writer:
        // points + pressures present, no FIELD_COLOR. Reader should
        // substitute the module DEFAULT_COLOR (opaque black).
        let doc = StrokesDoc::new();
        {
            let mut tx = doc.doc.transact_mut();
            let len = doc.strokes.len(&tx);
            let stroke_map = doc
                .strokes
                .insert(&mut tx, len, MapPrelim::default());
            stroke_map.insert(
                &mut tx,
                FIELD_ID,
                Any::from("legacy_no_color".to_string()),
            );
            stroke_map.insert(&mut tx, FIELD_TOMBSTONED, Any::Bool(false));
            let points = stroke_map.insert(&mut tx, FIELD_POINTS, ArrayPrelim::default());
            for v in [0.0_f64, 0.0, 1.0, 1.0] {
                points.push_back(&mut tx, Any::Number(v));
            }
            // Deliberately no FIELD_COLOR insert.
        }
        let collected = collect_strokes_with_color(&doc);
        assert_eq!(collected.len(), 1);
        assert_eq!(collected[0].2, DEFAULT_COLOR);
    }

    #[test]
    fn legacy_stroke_without_pressures_defaults_to_one() {
        // Build a doc that mimics what a pre-C3 app version would
        // have written: a stroke with a `points` array but no
        // `pressures` field at all. We can't call begin_stroke /
        // push_point (those always create the pressures field now),
        // so we poke the doc directly at the yrs level.
        let doc = StrokesDoc::new();
        {
            let mut tx = doc.doc.transact_mut();
            let len = doc.strokes.len(&tx);
            let stroke_map = doc
                .strokes
                .insert(&mut tx, len, MapPrelim::default());
            stroke_map.insert(
                &mut tx,
                FIELD_ID,
                Any::from("legacy_stroke".to_string()),
            );
            stroke_map.insert(&mut tx, FIELD_TOMBSTONED, Any::Bool(false));
            let points = stroke_map.insert(&mut tx, FIELD_POINTS, ArrayPrelim::default());
            for v in [10.0_f64, 20.0, 30.0, 40.0] {
                points.push_back(&mut tx, Any::Number(v));
            }
            // Deliberately no FIELD_PRESSURES insert.
        }

        let collected = collect_strokes_with_pressure(&doc);
        assert_eq!(collected.len(), 1);
        let (points, pressures) = &collected[0];
        assert_eq!(points, &vec![10.0, 20.0, 30.0, 40.0]);
        // Two (x, y) pairs → two fallback pressure entries.
        assert_eq!(pressures, &vec![1.0, 1.0]);
    }

    #[test]
    fn short_pressures_array_pads_with_fallback() {
        // A stroke whose pressures array is shorter than the point
        // count (e.g. a crashed write or a malformed remote update)
        // should still surface every point, with missing tail
        // pressures padded to the fallback.
        let doc = StrokesDoc::new();
        {
            let mut tx = doc.doc.transact_mut();
            let len = doc.strokes.len(&tx);
            let stroke_map = doc
                .strokes
                .insert(&mut tx, len, MapPrelim::default());
            stroke_map.insert(
                &mut tx,
                FIELD_ID,
                Any::from("short_pressures".to_string()),
            );
            stroke_map.insert(&mut tx, FIELD_TOMBSTONED, Any::Bool(false));
            let points = stroke_map.insert(&mut tx, FIELD_POINTS, ArrayPrelim::default());
            for v in [0.0_f64, 0.0, 1.0, 1.0, 2.0, 2.0] {
                points.push_back(&mut tx, Any::Number(v));
            }
            let pressures = stroke_map
                .insert(&mut tx, FIELD_PRESSURES, ArrayPrelim::default());
            // Only the first sample has a pressure entry.
            pressures.push_back(&mut tx, Any::Number(0.4_f64));
        }

        let collected = collect_strokes_with_pressure(&doc);
        assert_eq!(collected.len(), 1);
        let (_, pressures) = &collected[0];
        assert_eq!(pressures, &vec![0.4, 1.0, 1.0]);
    }

    #[test]
    fn multiple_strokes_keep_their_order() {
        let mut doc = StrokesDoc::new();
        doc.begin_stroke(DEFAULT_COLOR);
        doc.push_point(1.0, 1.0, 1.0);
        doc.end_stroke();
        doc.begin_stroke(DEFAULT_COLOR);
        doc.push_point(2.0, 2.0, 1.0);
        doc.push_point(3.0, 3.0, 1.0);
        doc.end_stroke();

        assert_eq!(
            collect_strokes(&doc),
            vec![vec![1.0, 1.0], vec![2.0, 2.0, 3.0, 3.0]]
        );
    }

    #[test]
    fn push_point_without_begin_stroke_is_a_noop() {
        let mut doc = StrokesDoc::new();
        doc.push_point(7.0, 8.0, 1.0);
        assert!(collect_strokes(&doc).is_empty());
    }

    #[test]
    fn tombstone_all_hides_existing_strokes() {
        let mut doc = StrokesDoc::new();
        doc.begin_stroke(DEFAULT_COLOR);
        doc.push_point(1.0, 1.0, 1.0);
        doc.end_stroke();
        assert_eq!(collect_strokes(&doc).len(), 1);

        doc.tombstone_all();
        assert!(collect_strokes(&doc).is_empty());
        // But new strokes after a clear should still render.
        doc.begin_stroke(DEFAULT_COLOR);
        doc.push_point(5.0, 5.0, 1.0);
        doc.end_stroke();
        assert_eq!(collect_strokes(&doc), vec![vec![5.0, 5.0]]);
    }

    #[test]
    fn concurrent_edits_converge() {
        // Two devices fork from the same base, each add a stroke,
        // then merge in either order. Both should end up with both
        // strokes (yrs CRDT property).
        let mut base = StrokesDoc::new();
        base.begin_stroke(DEFAULT_COLOR);
        base.push_point(0.0, 0.0, 1.0);
        base.end_stroke();
        let base_bytes = base.encode();

        let mut a = StrokesDoc::from_bytes(&base_bytes);
        a.begin_stroke(DEFAULT_COLOR);
        a.push_point(1.0, 1.0, 1.0);
        a.end_stroke();
        let a_bytes = a.encode();

        let mut b = StrokesDoc::from_bytes(&base_bytes);
        b.begin_stroke(DEFAULT_COLOR);
        b.push_point(2.0, 2.0, 1.0);
        b.end_stroke();
        let b_bytes = b.encode();

        // Merge a into b's local doc, and vice versa.
        let merged_ab = StrokesDoc::from_bytes(&a_bytes);
        {
            let mut tx = merged_ab.doc.transact_mut();
            let update = Update::decode_v1(&b_bytes).unwrap();
            let _ = tx.apply_update(update);
        }
        let merged_ba = StrokesDoc::from_bytes(&b_bytes);
        {
            let mut tx = merged_ba.doc.transact_mut();
            let update = Update::decode_v1(&a_bytes).unwrap();
            let _ = tx.apply_update(update);
        }

        // Both converge to the same point set, regardless of merge
        // order. (Stroke ordering between a's and b's adds is
        // determined by yrs item IDs, which are stable across
        // devices, so the order matches too.)
        assert_eq!(collect_strokes(&merged_ab), collect_strokes(&merged_ba));
        // And both strokes survive.
        assert_eq!(collect_strokes(&merged_ab).len(), 3);
    }
}
