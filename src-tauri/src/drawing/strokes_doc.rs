//! Yrs-backed stroke storage façade.
//!
//! Same architectural shape as `crate::sync::yrs_doc` (the markdown
//! façade): keep all `yrs` API usage inside this file so the rest of
//! the drawing module never imports `yrs` directly. That gives us
//! one place to pin the version, one place to debug encoding
//! choices, and one place to revisit if we ever swap CRDT libs.
//!
//! Wire format: v1 yrs updates (`encode_state_as_update_v1` /
//! `Update::decode_v1`). Mirrors what the JS editor uses for
//! markdown notes — same reasoning, no need to invent a separate
//! envelope for ink.
//!
//! ## Schema
//!
//! ```text
//! strokes: Y.Array<Y.Map>           ← outer array gives stroke
//!   each stroke map carries:           ordering + tombstoning at
//!                                      CRDT-merge granularity, which
//!                                      is what live collab (C5) cares
//!                                      about. Per-point CRDT identity
//!                                      is deliberately given up.
//!     id:         Any::String(uuid)
//!     tombstoned: Any::Bool          ← eraser flips this to true
//!     payload:    Any::Buffer        ← raw binary bytes; see below
//! ```
//!
//! ### Why strokes are opaque payloads (and not per-point yrs arrays)
//!
//! The previous schema stored every (x, y) coordinate as its own
//! `Any::Number` insert into a `Y.Array<f64>`. For a real-world
//! note with ~30k points that meant ~100k yrs operations to replay
//! on every cold open — measured at 312 ms `apply_update` on a Tab
//! S7 FE. The per-point CRDT granularity bought us nothing in
//! practice: strokes are written atomically by a single device in a
//! tight burst, and no peer would ever sensibly want to insert a
//! coordinate into the middle of someone else's in-flight stroke.
//!
//! Wrapping each stroke's geometry in a single `Any::Buffer` payload
//! drops the op count to one yrs insert per stroke (~71 ops for the
//! same note). What's preserved at the CRDT layer is exactly the
//! thing live collab needs: stroke *ordering* and *tombstone* state
//! converge cleanly across devices via the outer `Y.Array<Y.Map>`.
//! What's lost is "see the remote pen drawing progressively, sample
//! by sample" — remote strokes appear atomically on pen-up instead.
//! Matches Apple Notes / OneNote / most production ink editors.
//!
//! ### Payload binary format (v1)
//!
//! ```text
//! offset  size            field
//!     0    1 byte         version (= PAYLOAD_VERSION_V1)
//!     1    4 bytes (LE)   color: u32   — packed 0xAARRGGBB
//!     5    4 bytes (LE)   n_points: u32
//!     9    8 * n_points   points: f32 pairs (x0, y0, x1, y1, …) in
//!                                          page coords
//!  9+8n    4 * n_points   pressures: f32, one per (x, y) pair
//! ```
//!
//! Little-endian throughout. All modern target devices are LE; we
//! don't need a portable codec.
//!
//! ### Backward compat
//!
//! There is none — this is the first shipped schema for ink notes,
//! so we don't carry a legacy reader. If a future migration becomes
//! necessary we'd add a top-level `schema_version` field and bump
//! `PAYLOAD_VERSION_V1` accordingly.
//!
//! ## What's NOT yet in the schema (deferred per the roadmap)
//!
//! - Tilt / azimuth per point. Open; revisit if D1's stroke modeller
//!   wants them. Would slot into the payload as additional f32 arrays.
//! - User-chosen per-stroke width (D5). Currently the renderer
//!   modulates a hardcoded BASE_WIDTH by pressure; D5 would add a
//!   `width: f32` to the payload header.
//! - Tool type (currently reflected indirectly via the chosen
//!   `color` — pen/eraser → blue, finger → black; D5's palette
//!   replaces that mapping).

use yrs::any::Any;
use yrs::updates::decoder::Decode;
use yrs::{
    Array, ArrayRef, Doc, Map, MapPrelim, MapRef, Out, ReadTxn, StateVector, Transact, Update,
};

const STROKES_KEY: &str = "strokes";
const FIELD_TOMBSTONED: &str = "tombstoned";
const FIELD_ID: &str = "id";
const FIELD_PAYLOAD: &str = "payload";

/// Default stroke colour: opaque black, packed as 0xAARRGGBB.
/// The renderer chooses the actual stored colour at `begin_stroke`
/// time based on input-device tool type; this constant is what the
/// renderer falls back to for "no special pen colour" (finger,
/// mouse, unknown tool).
pub const DEFAULT_COLOR: u32 = 0xFF00_0000;

/// Current payload binary-format version. See module header for the
/// layout. Bump if the layout ever changes in a non-additive way;
/// readers refuse to decode unknown versions (the stroke is skipped
/// rather than rendered with garbage).
const PAYLOAD_VERSION_V1: u8 = 1;

/// Pure encoder for the v1 stroke payload binary format. Kept as a
/// free function (separate from `StrokesDoc`) so it can be
/// unit-tested without spinning up a yrs Doc.
fn encode_payload_v1(color: u32, points: &[f32], pressures: &[f32]) -> Vec<u8> {
    debug_assert_eq!(points.len() % 2, 0, "points must be interleaved (x, y) pairs");
    debug_assert_eq!(
        points.len() / 2,
        pressures.len(),
        "one pressure per (x, y) pair"
    );
    let n_points = pressures.len() as u32;
    // 1 (version) + 4 (color) + 4 (n_points) + 4 * 2n (points) + 4 * n (pressures)
    let mut out = Vec::with_capacity(9 + points.len() * 4 + pressures.len() * 4);
    out.push(PAYLOAD_VERSION_V1);
    out.extend_from_slice(&color.to_le_bytes());
    out.extend_from_slice(&n_points.to_le_bytes());
    for &v in points {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for &v in pressures {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// Decoded view of a v1 stroke payload. Owns its data — the
/// visitor passes references into a [`StrokeView`] borrowing from
/// this struct's `points` / `pressures` Vecs.
struct DecodedPayload {
    color: u32,
    points: Vec<f32>,
    pressures: Vec<f32>,
}

/// Pure decoder. `None` on truncated / wrong-version / size-mismatch
/// input — caller skips the stroke rather than rendering garbage.
fn decode_payload_v1(bytes: &[u8]) -> Option<DecodedPayload> {
    // Header: 1 (version) + 4 (color) + 4 (n_points) = 9 bytes.
    if bytes.len() < 9 {
        return None;
    }
    if bytes[0] != PAYLOAD_VERSION_V1 {
        return None;
    }
    let color = u32::from_le_bytes(bytes[1..5].try_into().ok()?);
    let n_points = u32::from_le_bytes(bytes[5..9].try_into().ok()?) as usize;
    let expected_len = 9 + n_points * 2 * 4 + n_points * 4;
    if bytes.len() != expected_len {
        return None;
    }
    let mut points = Vec::with_capacity(n_points * 2);
    let mut pressures = Vec::with_capacity(n_points);
    let mut offset = 9;
    for _ in 0..(n_points * 2) {
        points.push(f32::from_le_bytes(bytes[offset..offset + 4].try_into().ok()?));
        offset += 4;
    }
    for _ in 0..n_points {
        pressures.push(f32::from_le_bytes(bytes[offset..offset + 4].try_into().ok()?));
        offset += 4;
    }
    Some(DecodedPayload {
        color,
        points,
        pressures,
    })
}

/// Wrapper around a `yrs::Doc` holding the stroke document for one
/// ink note. See module header for the schema.
///
/// Cheap to construct; cheap to encode (the per-stroke payloads are
/// already pre-serialised at end_stroke time, so encode is just yrs
/// state encoding of ~one op per stroke + a few outer-map fields).
/// `from_bytes` is proportional to stroke count, not point count —
/// the inner geometry is one opaque buffer per stroke.
///
/// In-progress writes (`begin_stroke` → many `push_point` → `end_stroke`)
/// accumulate in Rust-side buffers; only `end_stroke` touches yrs.
/// Means the per-sample hot path doesn't pay any CRDT cost at all,
/// and an app crash mid-stroke loses the (un-committed) partial
/// stroke — which is fine because the auto-save debounce only flushes
/// on stroke-end anyway.
pub struct StrokesDoc {
    doc: Doc,
    strokes: ArrayRef,
    /// Colour chosen at `begin_stroke`. `Some` means a stroke is
    /// currently open; doubles as the "is there a stroke in flight"
    /// guard for `push_point`.
    in_progress_color: Option<u32>,
    /// Accumulated point coordinates for the in-progress stroke,
    /// interleaved (x0, y0, x1, y1, …). Lives on the Rust side
    /// until `end_stroke` serialises it into the stroke payload.
    in_progress_points: Vec<f32>,
    /// Accumulated pressures, one per (x, y) pair.
    in_progress_pressures: Vec<f32>,
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
            in_progress_color: None,
            in_progress_points: Vec::new(),
            in_progress_pressures: Vec::new(),
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

    /// Encode the current state as a v1 yrs update — the wire format
    /// the rest of the app uses for note CRDTs. Suitable for
    /// stashing in `note.yrs_state`.
    pub fn encode(&self) -> Vec<u8> {
        let tx = self.doc.transact();
        tx.encode_state_as_update_v1(&StateVector::default())
    }

    /// Open a new stroke. Subsequent `push_point` calls accumulate
    /// into Rust-side buffers; nothing hits yrs until `end_stroke`
    /// commits the whole stroke as a single payload insert.
    ///
    /// `color` is the packed 0xAARRGGBB the renderer should use
    /// (typically chosen at the call site based on input-device
    /// tool type or a future user-picked palette).
    ///
    /// If a stroke was already open (no matching end_stroke), its
    /// in-progress points are silently dropped — defensive against
    /// missed pen-up events. Since nothing was committed to yrs for
    /// the previous stroke, dropping has no on-disk effect.
    pub fn begin_stroke(&mut self, color: u32) {
        self.in_progress_color = Some(color);
        self.in_progress_points.clear();
        self.in_progress_pressures.clear();
    }

    /// Append a single point (in page coordinates) and its pressure
    /// to the in-progress stroke's Rust-side buffer. No-op outside
    /// `begin_stroke` / `end_stroke` — protects against stray MOVE
    /// samples between strokes.
    pub fn push_point(&mut self, x: f32, y: f32, pressure: f32) {
        if self.in_progress_color.is_none() {
            return;
        }
        self.in_progress_points.push(x);
        self.in_progress_points.push(y);
        self.in_progress_pressures.push(pressure);
    }

    /// Close the in-progress stroke and commit it to the yrs doc as
    /// a single payload insert. Idempotent — calling without an open
    /// stroke (or with a stroke that recorded zero points) is a no-op
    /// and returns `None`.
    ///
    /// Returns the committed stroke's id so callers (specifically the
    /// render-thread undo stack) can refer back to this specific
    /// stroke for later "undo the add" / "remove" operations.
    pub fn end_stroke(&mut self) -> Option<String> {
        let color = self.in_progress_color.take()?;
        // Empty strokes — pen-down without any subsequent move sample —
        // would tessellate to zero segments anyway; skip them so the
        // doc doesn't accumulate inert stroke entries.
        if self.in_progress_pressures.is_empty() {
            self.in_progress_points.clear();
            return None;
        }
        let payload = encode_payload_v1(
            color,
            &self.in_progress_points,
            &self.in_progress_pressures,
        );
        self.in_progress_points.clear();
        self.in_progress_pressures.clear();

        let stroke_id = format!("stroke_{}", uuid::Uuid::new_v4());
        let mut tx = self.doc.transact_mut();
        let len = self.strokes.len(&tx);
        let stroke_map = self.strokes.insert(&mut tx, len, MapPrelim::default());
        stroke_map.insert(&mut tx, FIELD_ID, Any::from(stroke_id.clone()));
        stroke_map.insert(&mut tx, FIELD_TOMBSTONED, Any::Bool(false));
        stroke_map.insert(
            &mut tx,
            FIELD_PAYLOAD,
            // yrs 0.26 stores `Any::Buffer` as `Arc<[u8]>` — the
            // boxed-slice → Arc conversion is one allocation hop.
            // For typical payloads (a few hundred KB) it doesn't
            // show up in the profile.
            Any::Buffer(payload.into_boxed_slice().into()),
        );
        Some(stroke_id)
    }

    /// Toggle a specific stroke's tombstoned flag by id. Returns
    /// `true` if a stroke with that id existed and was updated; `false`
    /// if no matching stroke was found (caller's id is stale, e.g.
    /// after a remote merge dropped that stroke). Used by the eraser
    /// (set to `true`) and by the undo stack (toggle either way to
    /// reverse a previous action).
    ///
    /// Walks the outer `Y.Array<Y.Map>` linearly. For docs with
    /// thousands of strokes this is O(n) per call, which matters
    /// during an eraser drag (one call per dirtied stroke per frame);
    /// at the workload sizes we're seeing today it doesn't register.
    /// If it ever does, the obvious fix is a render-thread side
    /// `HashMap<stroke_id, array_index>` cache invalidated on the
    /// strokes-array observer.
    /// Tombstone every stroke whose id appears in `ids`. Returns the
    /// number of strokes actually flipped. Used by the eraser hot
    /// path to batch a whole render-frame's worth of erased strokes
    /// into one yrs write — N × set_stroke_tombstoned would be
    /// O(N × strokes) yrs walks, which dominated the per-sample
    /// cost on dense drags. This is O(strokes) regardless of how
    /// many ids are pending.
    ///
    /// Two-pass to keep the borrow checker happy:
    ///   1. Read-only iter to collect the matching `MapRef`s
    ///      (`iter(&tx)` holds the read borrow for the whole loop,
    ///      blocking any mid-iter mutation).
    ///   2. Single mutable transaction that walks the collected
    ///      refs and flips their tombstone flag.
    /// `MapRef` is a logical handle into the doc (no borrow), so
    /// passing them across the transaction boundary is sound.
    pub fn tombstone_strokes(&mut self, ids: &std::collections::HashSet<String>) -> usize {
        if ids.is_empty() {
            return 0;
        }
        // Pass 1: collect matching stroke handles.
        let to_tombstone: Vec<MapRef> = {
            let tx = self.doc.transact();
            self.strokes
                .iter(&tx)
                .filter_map(|v| {
                    let Out::YMap(stroke) = v else {
                        return None;
                    };
                    let id_matches = matches!(
                        stroke.get(&tx, FIELD_ID),
                        Some(Out::Any(Any::String(s))) if ids.contains(&*s)
                    );
                    id_matches.then_some(stroke)
                })
                .collect()
        };
        let count = to_tombstone.len();
        // Pass 2: flip every matching stroke's tombstone flag in
        // one transaction. yrs commits the whole batch atomically
        // on transact_mut drop.
        let mut tx = self.doc.transact_mut();
        for stroke in to_tombstone {
            stroke.insert(&mut tx, FIELD_TOMBSTONED, Any::Bool(true));
        }
        count
    }

    pub fn set_stroke_tombstoned(&mut self, id: &str, tombstoned: bool) -> bool {
        // Perf instrumentation: this is O(n) over the outer strokes
        // array. During an eraser drag with N hits, the caller runs
        // this N times → O(N × strokes). Logged at trace so we can
        // turn it on cheaply when investigating slowdowns, plus a
        // warn! escape hatch for individually-pathological cases.
        let t0 = std::time::Instant::now();
        let mut scanned: usize = 0;
        let mut tx = self.doc.transact_mut();
        for stroke_value in self.strokes.iter(&tx) {
            scanned += 1;
            let Out::YMap(stroke) = stroke_value else {
                continue;
            };
            let matches = matches!(
                stroke.get(&tx, FIELD_ID),
                Some(Out::Any(Any::String(s))) if &*s == id
            );
            if matches {
                stroke.insert(&mut tx, FIELD_TOMBSTONED, Any::Bool(tombstoned));
                let elapsed = t0.elapsed();
                log::trace!(
                    "[drawing.perf.eraser] set_stroke_tombstoned id={id} scanned={scanned} took={elapsed:?}"
                );
                if elapsed.as_millis() > 5 {
                    log::warn!(
                        "[drawing.perf.eraser] slow set_stroke_tombstoned id={id} scanned={scanned} took={elapsed:?}"
                    );
                }
                return true;
            }
        }
        let elapsed = t0.elapsed();
        log::trace!(
            "[drawing.perf.eraser] set_stroke_tombstoned id={id} MISS scanned={scanned} took={elapsed:?}"
        );
        false
    }

    /// Tombstone every stroke. Used by the Clear toolbar button —
    /// keeps the stroke entries in the doc (so concurrent edits from
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
        // Drop the in-progress state too — Clear during a stroke
        // should also end that stroke.
        drop(tx);
        self.in_progress_color = None;
        self.in_progress_points.clear();
        self.in_progress_pressures.clear();
    }

    /// Visit each non-tombstoned stroke. The visitor receives a
    /// [`StrokeView`] with borrowed slices into a transient
    /// per-stroke decoded buffer — copy out anything that needs to
    /// outlive the callback.
    ///
    /// Skipped on malformed entries: missing id, missing/non-buffer
    /// payload, unknown payload version, truncated bytes. We choose
    /// to drop the stroke rather than render garbage; a logged
    /// warning would be noise here because the in-process writer
    /// can't produce malformed payloads — only a future schema
    /// change or a hostile / corrupted blob could.
    pub fn for_each_stroke<F>(&self, mut visit: F)
    where
        F: FnMut(StrokeView),
    {
        let tx = self.doc.transact();
        // iter() walks yrs's internal tree once, O(n); the previous
        // schema's indexed get(i) was O(log n) per call which dominated
        // for docs with many strokes. Same iter() invariant here.
        for stroke_value in self.strokes.iter(&tx) {
            let Out::YMap(stroke) = stroke_value else {
                continue;
            };
            let tombstoned = matches!(
                stroke.get(&tx, FIELD_TOMBSTONED),
                Some(Out::Any(Any::Bool(true)))
            );
            if tombstoned {
                continue;
            }
            let id = match stroke.get(&tx, FIELD_ID) {
                Some(Out::Any(Any::String(s))) => s.to_string(),
                _ => continue,
            };
            let Some(Out::Any(Any::Buffer(bytes))) = stroke.get(&tx, FIELD_PAYLOAD) else {
                continue;
            };
            let Some(decoded) = decode_payload_v1(&bytes) else {
                continue;
            };
            visit(StrokeView {
                id: &id,
                points: &decoded.points,
                pressures: &decoded.pressures,
                color: decoded.color,
            });
        }
    }

    /// Walk every stroke (visible *and* tombstoned) yielding just
    /// its id + tombstone state. Used by undo's "Clear All" capture
    /// so we can restore the exact pre-clear visibility on undo
    /// (rather than blindly untombstoning everything, which would
    /// resurrect strokes the user had already erased before the
    /// clear).
    pub fn for_each_stroke_id<F>(&self, mut visit: F)
    where
        F: FnMut(&str, bool),
    {
        let tx = self.doc.transact();
        for stroke_value in self.strokes.iter(&tx) {
            let Out::YMap(stroke) = stroke_value else {
                continue;
            };
            let id = match stroke.get(&tx, FIELD_ID) {
                Some(Out::Any(Any::String(s))) => s,
                _ => continue,
            };
            let tombstoned = matches!(
                stroke.get(&tx, FIELD_TOMBSTONED),
                Some(Out::Any(Any::Bool(true)))
            );
            visit(&id, tombstoned);
        }
    }
}

/// One non-tombstoned stroke surfaced by [`StrokesDoc::for_each_stroke`].
///
/// Fields:
///   - `id`: stable per-stroke uuid (`"stroke_{uuid}"`), assigned at
///     `end_stroke` time. Used by the eraser hit-test + undo stack to
///     refer back to specific strokes for tombstone toggling.
///   - `points`: flat `[x0, y0, x1, y1, …]` in page coordinates.
///   - `pressures`: parallel to `points`, one entry per (x, y) pair
///     (`pressures.len() == points.len() / 2`).
///   - `color`: packed 0xAARRGGBB the renderer chose at `begin_stroke`
///     time.
///
/// Borrowed view; valid only for the duration of the visitor
/// callback. Copy out anything the caller wants to keep.
pub struct StrokeView<'a> {
    pub id: &'a str,
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

    /// Pair-wise (points, pressures) per stroke for the C3 path tests.
    fn collect_strokes_with_pressure(doc: &StrokesDoc) -> Vec<(Vec<f32>, Vec<f32>)> {
        let mut out = Vec::new();
        doc.for_each_stroke(|view| {
            out.push((view.points.to_vec(), view.pressures.to_vec()));
        });
        out
    }

    /// Triple (points, pressures, color) per stroke for the C4-color
    /// path tests.
    fn collect_strokes_with_color(doc: &StrokesDoc) -> Vec<(Vec<f32>, Vec<f32>, u32)> {
        let mut out = Vec::new();
        doc.for_each_stroke(|view| {
            out.push((view.points.to_vec(), view.pressures.to_vec(), view.color));
        });
        out
    }

    // ---------- Payload encoder/decoder (pure-function) ----------

    #[test]
    fn payload_round_trips() {
        let points = vec![1.0_f32, 2.0, 3.0, 4.0, 5.0, 6.0];
        let pressures = vec![0.25_f32, 0.5, 0.75];
        let bytes = encode_payload_v1(0xFF00_66FF, &points, &pressures);
        let decoded = decode_payload_v1(&bytes).expect("round-trip");
        assert_eq!(decoded.color, 0xFF00_66FF);
        assert_eq!(decoded.points, points);
        assert_eq!(decoded.pressures, pressures);
    }

    #[test]
    fn payload_empty_stroke_round_trips() {
        let bytes = encode_payload_v1(DEFAULT_COLOR, &[], &[]);
        // Header only: version + color + n_points = 9 bytes.
        assert_eq!(bytes.len(), 9);
        let decoded = decode_payload_v1(&bytes).expect("zero-point round-trip");
        assert_eq!(decoded.color, DEFAULT_COLOR);
        assert!(decoded.points.is_empty());
        assert!(decoded.pressures.is_empty());
    }

    #[test]
    fn payload_rejects_truncated_header() {
        // Anything shorter than the 9-byte header is invalid.
        assert!(decode_payload_v1(&[]).is_none());
        assert!(decode_payload_v1(&[PAYLOAD_VERSION_V1]).is_none());
        assert!(decode_payload_v1(&[PAYLOAD_VERSION_V1; 8]).is_none());
    }

    #[test]
    fn payload_rejects_unknown_version() {
        let bytes = encode_payload_v1(DEFAULT_COLOR, &[0.0, 0.0], &[1.0]);
        let mut bumped = bytes.clone();
        bumped[0] = PAYLOAD_VERSION_V1 + 1;
        assert!(decode_payload_v1(&bumped).is_none());
    }

    #[test]
    fn payload_rejects_size_mismatch() {
        // n_points = 1 but the body has zero point bytes.
        let mut bad = Vec::new();
        bad.push(PAYLOAD_VERSION_V1);
        bad.extend_from_slice(&DEFAULT_COLOR.to_le_bytes());
        bad.extend_from_slice(&1u32.to_le_bytes());
        // (no point + pressure bytes appended)
        assert!(decode_payload_v1(&bad).is_none());
    }

    // ---------- StrokesDoc round-trip / behaviour tests ----------

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
    fn empty_stroke_doesnt_commit() {
        // begin + end without any push_point → no doc entry.
        // Avoids dust accumulating from accidental pen-touches that
        // never registered a move sample (which would tessellate to
        // zero segments anyway).
        let mut doc = StrokesDoc::new();
        doc.begin_stroke(DEFAULT_COLOR);
        doc.end_stroke();
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
    fn second_begin_stroke_drops_uncommitted_first() {
        // Defensive: missed pen-up shouldn't leak the first stroke's
        // points into the second. begin_stroke clears in-progress
        // buffers (nothing was committed to yrs for the first
        // stroke since end_stroke didn't run).
        let mut doc = StrokesDoc::new();
        doc.begin_stroke(DEFAULT_COLOR);
        doc.push_point(99.0, 99.0, 1.0);
        // No end_stroke; start a fresh one.
        doc.begin_stroke(DEFAULT_COLOR);
        doc.push_point(1.0, 2.0, 1.0);
        doc.end_stroke();

        assert_eq!(collect_strokes(&doc), vec![vec![1.0, 2.0]]);
    }

    #[test]
    fn end_stroke_returns_committed_id() {
        let mut doc = StrokesDoc::new();
        doc.begin_stroke(DEFAULT_COLOR);
        doc.push_point(0.0, 0.0, 1.0);
        let id = doc.end_stroke().expect("non-empty stroke commits");
        assert!(id.starts_with("stroke_"), "id has expected prefix: {id}");

        // The id surfaced by for_each_stroke must match.
        let mut seen_ids = Vec::new();
        doc.for_each_stroke(|view| seen_ids.push(view.id.to_string()));
        assert_eq!(seen_ids, vec![id]);
    }

    #[test]
    fn end_stroke_returns_none_for_empty_stroke() {
        let mut doc = StrokesDoc::new();
        doc.begin_stroke(DEFAULT_COLOR);
        // no push_point
        assert!(doc.end_stroke().is_none());
    }

    #[test]
    fn set_stroke_tombstoned_toggles_visibility() {
        let mut doc = StrokesDoc::new();
        doc.begin_stroke(DEFAULT_COLOR);
        doc.push_point(0.0, 0.0, 1.0);
        let id = doc.end_stroke().unwrap();

        assert_eq!(collect_strokes(&doc).len(), 1);
        assert!(doc.set_stroke_tombstoned(&id, true));
        assert!(collect_strokes(&doc).is_empty());
        // Untombstone restores visibility — the eraser-undo path.
        assert!(doc.set_stroke_tombstoned(&id, false));
        assert_eq!(collect_strokes(&doc).len(), 1);
    }

    #[test]
    fn tombstone_strokes_bulk_tombstones_matching_ids() {
        use std::collections::HashSet;

        let mut doc = StrokesDoc::new();
        doc.begin_stroke(DEFAULT_COLOR);
        doc.push_point(0.0, 0.0, 1.0);
        let a = doc.end_stroke().unwrap();
        doc.begin_stroke(DEFAULT_COLOR);
        doc.push_point(1.0, 1.0, 1.0);
        let b = doc.end_stroke().unwrap();
        doc.begin_stroke(DEFAULT_COLOR);
        doc.push_point(2.0, 2.0, 1.0);
        let c = doc.end_stroke().unwrap();

        // Tombstone a + c but not b in one bulk call.
        let mut ids: HashSet<String> = HashSet::new();
        ids.insert(a.clone());
        ids.insert(c.clone());
        let n = doc.tombstone_strokes(&ids);
        assert_eq!(n, 2);

        let visible: Vec<String> = {
            let mut v = Vec::new();
            doc.for_each_stroke(|view| v.push(view.id.to_string()));
            v
        };
        assert_eq!(visible, vec![b]);
    }

    #[test]
    fn tombstone_strokes_empty_set_is_a_noop() {
        use std::collections::HashSet;
        let mut doc = StrokesDoc::new();
        doc.begin_stroke(DEFAULT_COLOR);
        doc.push_point(0.0, 0.0, 1.0);
        doc.end_stroke();

        let empty: HashSet<String> = HashSet::new();
        assert_eq!(doc.tombstone_strokes(&empty), 0);
        // Stroke still visible.
        assert_eq!(collect_strokes(&doc).len(), 1);
    }

    #[test]
    fn set_stroke_tombstoned_unknown_id_returns_false() {
        let mut doc = StrokesDoc::new();
        // No strokes at all; any id should miss.
        assert!(!doc.set_stroke_tombstoned("stroke_does_not_exist", true));
    }

    #[test]
    fn for_each_stroke_id_yields_visible_and_tombstoned() {
        let mut doc = StrokesDoc::new();
        doc.begin_stroke(DEFAULT_COLOR);
        doc.push_point(0.0, 0.0, 1.0);
        let a = doc.end_stroke().unwrap();
        doc.begin_stroke(DEFAULT_COLOR);
        doc.push_point(1.0, 1.0, 1.0);
        let b = doc.end_stroke().unwrap();
        // Tombstone b — for_each_stroke (visible only) hides it but
        // for_each_stroke_id (all) still sees it.
        doc.set_stroke_tombstoned(&b, true);

        let mut entries: Vec<(String, bool)> = Vec::new();
        doc.for_each_stroke_id(|id, tombstoned| {
            entries.push((id.to_string(), tombstoned));
        });
        assert_eq!(entries, vec![(a, false), (b, true)]);
    }

    #[test]
    fn concurrent_edits_converge() {
        // Two devices fork from the same base, each add a stroke,
        // then merge in either order. Both should end up with both
        // strokes (yrs CRDT property). The new opaque-payload schema
        // still uses Y.Array<Y.Map> at the outer level, so this
        // convergence guarantee is preserved — that's the whole
        // point of keeping the outer array as a proper yrs structure.
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
        // order. Stroke ordering between a's and b's adds is
        // determined by yrs item IDs, which are stable across
        // devices, so the order matches too.
        assert_eq!(collect_strokes(&merged_ab), collect_strokes(&merged_ba));
        // And both strokes survive.
        assert_eq!(collect_strokes(&merged_ab).len(), 3);
    }
}
