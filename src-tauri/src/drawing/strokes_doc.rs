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
//!
//! Why a flat points array (vs an array of {x, y} maps): tighter
//! storage, simpler encode/decode, and we don't need per-point
//! collab anyway — points within a single stroke are written by a
//! single device in a tight burst. Inter-stroke ordering and
//! tombstoning are the only collab-interesting bits, and those live
//! at the stroke-map level.
//!
//! What's NOT in the schema yet (deferred per the roadmap):
//!   - pressure / tilt per point (C3)
//!   - actual user-chosen color/width (D5)
//!   - a top-level schema-version map (revisit when the schema
//!     actually changes; for now a v1-encoded doc with our shape is
//!     unambiguous)

use yrs::any::Any;
use yrs::updates::decoder::Decode;
use yrs::{
    Array, ArrayPrelim, ArrayRef, Doc, Map, MapPrelim, Out, ReadTxn, StateVector, Transact, Update,
};

const STROKES_KEY: &str = "strokes";
const FIELD_TOMBSTONED: &str = "tombstoned";
const FIELD_POINTS: &str = "points";
const FIELD_ID: &str = "id";
const FIELD_COLOR: &str = "color";
const FIELD_WIDTH: &str = "width";

/// Default stroke colour: opaque black, packed as 0xAARRGGBB.
const DEFAULT_COLOR: i64 = 0xFF00_0000;
/// Default stroke width in page units (1 unit = 1/144 inch).
const DEFAULT_WIDTH: f64 = 1.0;

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
    /// If a stroke was already open (no matching end_stroke), it's
    /// silently committed — defensive against missed pen-up events.
    pub fn begin_stroke(&mut self) {
        let mut tx = self.doc.transact_mut();
        // Empty MapPrelim first; field inserts below avoid having
        // to thread Any-typed initial fields through MapPrelim's
        // generic. Slightly more transactions but much clearer.
        let len = self.strokes.len(&tx);
        let stroke_map = self.strokes.insert(&mut tx, len, MapPrelim::default());
        let stroke_id = format!("stroke_{}", uuid::Uuid::new_v4());
        stroke_map.insert(&mut tx, FIELD_ID, Any::from(stroke_id));
        stroke_map.insert(&mut tx, FIELD_COLOR, Any::BigInt(DEFAULT_COLOR));
        stroke_map.insert(&mut tx, FIELD_WIDTH, Any::Number(DEFAULT_WIDTH));
        stroke_map.insert(&mut tx, FIELD_TOMBSTONED, Any::Bool(false));
        let points = stroke_map.insert(&mut tx, FIELD_POINTS, ArrayPrelim::default());
        // Have to drop tx before storing the ArrayRef into self —
        // ArrayRef itself is fine to hold across transactions, but
        // we want the begin_stroke transaction to commit before we
        // start receiving samples.
        drop(tx);
        self.in_progress_points = Some(points);
    }

    /// Append a single point (in page coordinates) to the
    /// in-progress stroke. No-op outside `begin_stroke` /
    /// `end_stroke` — protects against stray MOVE samples between
    /// strokes.
    pub fn push_point(&mut self, x: f32, y: f32) {
        let Some(points) = self.in_progress_points.as_ref() else {
            return;
        };
        let mut tx = self.doc.transact_mut();
        points.push_back(&mut tx, Any::Number(x as f64));
        points.push_back(&mut tx, Any::Number(y as f64));
    }

    /// Close the in-progress stroke. Idempotent.
    pub fn end_stroke(&mut self) {
        self.in_progress_points = None;
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
        // Drop the in-progress pointer too — Clear during a stroke
        // should also end that stroke.
        drop(tx);
        self.in_progress_points = None;
    }

    /// Visit each non-tombstoned stroke's points as a flat slice
    /// `[x0, y0, x1, y1, …]` in page coordinates. Used after
    /// `from_bytes` to rebuild the render-side segment cache.
    pub fn for_each_stroke_points<F>(&self, mut visit: F)
    where
        F: FnMut(&[f32]),
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
            if !flat.is_empty() {
                visit(&flat);
            }
        }
    }
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
    fn collect_strokes(doc: &StrokesDoc) -> Vec<Vec<f32>> {
        let mut out = Vec::new();
        doc.for_each_stroke_points(|points| out.push(points.to_vec()));
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
        doc.begin_stroke();
        doc.push_point(10.0, 20.0);
        doc.push_point(30.0, 40.0);
        doc.push_point(50.0, 60.0);
        doc.end_stroke();

        let bytes = doc.encode();
        let restored = StrokesDoc::from_bytes(&bytes);
        assert_eq!(
            collect_strokes(&restored),
            vec![vec![10.0, 20.0, 30.0, 40.0, 50.0, 60.0]]
        );
    }

    #[test]
    fn multiple_strokes_keep_their_order() {
        let mut doc = StrokesDoc::new();
        doc.begin_stroke();
        doc.push_point(1.0, 1.0);
        doc.end_stroke();
        doc.begin_stroke();
        doc.push_point(2.0, 2.0);
        doc.push_point(3.0, 3.0);
        doc.end_stroke();

        assert_eq!(
            collect_strokes(&doc),
            vec![vec![1.0, 1.0], vec![2.0, 2.0, 3.0, 3.0]]
        );
    }

    #[test]
    fn push_point_without_begin_stroke_is_a_noop() {
        let mut doc = StrokesDoc::new();
        doc.push_point(7.0, 8.0);
        assert!(collect_strokes(&doc).is_empty());
    }

    #[test]
    fn tombstone_all_hides_existing_strokes() {
        let mut doc = StrokesDoc::new();
        doc.begin_stroke();
        doc.push_point(1.0, 1.0);
        doc.end_stroke();
        assert_eq!(collect_strokes(&doc).len(), 1);

        doc.tombstone_all();
        assert!(collect_strokes(&doc).is_empty());
        // But new strokes after a clear should still render.
        doc.begin_stroke();
        doc.push_point(5.0, 5.0);
        doc.end_stroke();
        assert_eq!(collect_strokes(&doc), vec![vec![5.0, 5.0]]);
    }

    #[test]
    fn concurrent_edits_converge() {
        // Two devices fork from the same base, each add a stroke,
        // then merge in either order. Both should end up with both
        // strokes (yrs CRDT property).
        let mut base = StrokesDoc::new();
        base.begin_stroke();
        base.push_point(0.0, 0.0);
        base.end_stroke();
        let base_bytes = base.encode();

        let mut a = StrokesDoc::from_bytes(&base_bytes);
        a.begin_stroke();
        a.push_point(1.0, 1.0);
        a.end_stroke();
        let a_bytes = a.encode();

        let mut b = StrokesDoc::from_bytes(&base_bytes);
        b.begin_stroke();
        b.push_point(2.0, 2.0);
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
