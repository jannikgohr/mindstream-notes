//! Render-thread orchestration and the Tauri-facing public API.
//!
//! This file is the entry point the rest of the crate (the
//! `platform/` glue, `mod.rs`) and Kotlin (via JNI exports in
//! `platform::android`) reach into to drive the drawing engine.
//! The actual work is delegated:
//!
//!   * `crate::drawing::pipeline`         — wgpu state + per-frame GPU pass
//!   * `crate::drawing::ui`               — egui Context + UI widgets
//!   * `crate::drawing::surface_source`   — `SurfaceSource` trait;
//!                                          platform impls own the
//!                                          native window handle.
//!
//! Threading: every public function here just packages a `Msg` and
//! drops it on the render thread's mpsc channel. The render thread
//! itself is spawned lazily on the first `set_surface` call and
//! owns all wgpu state for its lifetime — so the only cross-thread
//! synchronisation primitive in the data plane is the channel.
//!
//! Sync teardown: `clear_surface` is the one exception — it blocks
//! the calling JNI thread on a sync ack from the render thread.
//! See the function comment for why.

use std::collections::HashMap;
use std::sync::mpsc::{self, Sender, SyncSender, TryRecvError};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use std::collections::HashSet;

use super::input::{Sample, SampleAction, ToolKind};
use super::page::{point_to_segment_distance_sq, segment_quad_positions};
use super::pipeline::{self, PersistentGpu, SurfaceBoundState, Vertex};
use super::strokes_doc::{StrokesDoc, DEFAULT_COLOR};
use super::surface_source::SurfaceSource;
use super::ui::{self, CanvasUi, ToolMode, UiState};

/// Debug palette — visual confirmation that input-device detection
/// works end-to-end. Packed 0xAARRGGBB; the leading `FF` is the
/// alpha byte (a value like `0x00FF_600F` would paint fully
/// transparent over the white background and look like the stroke
/// vanished). D5 replaces all of this with a real user-chosen
/// palette.
///
/// Three distinct colours so the user can tell which detection
/// path actually fired on their device:
///   - [`PEN_DEBUG_COLOR`] (blue): tool = Stylus, no button held.
///   - [`STYLUS_BUTTON_HELD_COLOR`] (orange): stylus barrel button
///     is held. Wins over tool-type colouring because some Samsung
///     devices *also* mirror the press into `getToolType =
///     TOOL_TYPE_ERASER`, and checking buttons first lets us tell
///     the two cases apart visually.
///   - [`ERASER_TIP_COLOR`] (red): tool = Eraser (e.g. flipped S
///     Pen on a Galaxy Note, or a Samsung driver that mirrors
///     button-press into the tool type *without* setting the
///     button bit).
const PEN_DEBUG_COLOR: u32 = 0xFF00_66FF;
const STYLUS_BUTTON_HELD_COLOR: u32 = 0xFFFF_600F;
const ERASER_TIP_COLOR: u32 = 0xFFCC_2222;

/// Decide what colour a stroke should use, given the input sample
/// that started it. See the debug-palette docs above for the
/// precedence rationale.
fn color_for_input(tool: ToolKind, buttons: u32) -> u32 {
    if buttons & super::input::buttons::STYLUS_PRIMARY != 0 {
        return STYLUS_BUTTON_HELD_COLOR;
    }
    match tool {
        ToolKind::Stylus => PEN_DEBUG_COLOR,
        ToolKind::Eraser => ERASER_TIP_COLOR,
        ToolKind::Finger | ToolKind::Mouse | ToolKind::Unknown => DEFAULT_COLOR,
    }
}

/// Reshuffle a 0xAARRGGBB packed colour into the `[R, G, B, A]` byte
/// order the `Unorm8x4` vertex attribute expects. The HW unpack
/// then turns each byte into `byte / 255` to produce the
/// `vec4<f32>` the fragment shader sees — bit-identical to the old
/// `unpack_color` → `[f32; 4]` path, just without the extra 12 bytes
/// per vertex.
fn pack_color_bytes(color: u32) -> [u8; 4] {
    let a = ((color >> 24) & 0xFF) as u8;
    let r = ((color >> 16) & 0xFF) as u8;
    let g = ((color >> 8) & 0xFF) as u8;
    let b = (color & 0xFF) as u8;
    [r, g, b, a]
}

/// Maximum stroke width in page units (1 unit = 1/144 inch ≈ 0.176 mm).
/// A pen sample with `pressure == 1.0` renders at this width; lower
/// pressures scale linearly down to [`MIN_WIDTH`]. 4.0 ≈ 0.7 mm —
/// the lower end of a felt-tip pen, which feels right for
/// stylus input on a tablet.
///
/// Stroke-level width (the schema's per-stroke `FIELD_WIDTH`) is
/// reserved for D5's "brush size" UI and currently ignored by the
/// renderer — all strokes use the same `BASE_WIDTH`. Wiring it
/// through is a one-line change once the toolbar exposes the picker.
const BASE_WIDTH: f32 = 4.0;
/// Hit-test radius for the eraser tool, in page units. ~1.4 mm at
/// 144 DPI — narrow enough to pick individual strokes in a dense
/// doodle, wide enough that the user doesn't have to be
/// pixel-perfect with a touchscreen. Tuned against the same f32
/// constants as stroke width; bump it if eraser feels "sticky"
/// (catching unintended strokes) or "missy" (passing through thin
/// ones) in practice.
const ERASER_RADIUS_PAGE: f32 = 10.0;
/// Floor for the pressure-tapered width so a near-zero-pressure
/// sample doesn't tessellate into a sub-pixel sliver that disappears
/// under nearest-pixel rasterisation. ~0.18 mm at 144 DPI.
const MIN_WIDTH: f32 = 1.0;

/// Map a raw pressure value in [0, 1] (already sanitised at the JNI
/// boundary) to a page-unit stroke width. Linear ramp from
/// MIN_WIDTH to BASE_WIDTH.
fn width_for_pressure(pressure: f32) -> f32 {
    let p = pressure.clamp(0.0, 1.0);
    MIN_WIDTH + (BASE_WIDTH - MIN_WIDTH) * p
}

/// Adapt the host-testable [`segment_quad_positions`] math into the
/// wgpu `Vertex` array shape the render pipeline consumes. Colour is
/// uniform across the six output vertices — the value the caller
/// chose at `begin_stroke` time (already packed to `[R, G, B, A]`
/// bytes via [`pack_color_bytes`]) stays constant for the whole
/// stroke.
///
/// Joints between consecutive segments are not mitered — each quad
/// is independent. For thin strokes (sub-pixel-scale widths) this is
/// invisible; if thick-stroke joints look notchy later we can revisit
/// (lyon's stroke tessellator handles miters / rounded joins).
fn tessellate_segment(
    p0: (f32, f32),
    p1: (f32, f32),
    w0: f32,
    w1: f32,
    color: [u8; 4],
) -> [Vertex; 6] {
    let positions = segment_quad_positions(p0, p1, w0, w1);
    positions.map(|position| Vertex { position, color })
}

/// Messages the render thread accepts.
enum Msg {
    /// Pre-warm `PersistentGpu` (instance + adapter + device +
    /// pipeline + egui_renderer) so the first `SurfaceReady` only
    /// has to do the per-surface bind. Fired from `lib.rs::run`'s
    /// Tauri setup hook via [`prewarm`] so the wgpu cost moves off
    /// the user-perceived open critical path. Idempotent — a
    /// subsequent Prewarm with PersistentGpu already built is a
    /// no-op log line.
    Prewarm,
    SurfaceReady {
        window: Box<dyn SurfaceSource>,
        width: u32,
        height: u32,
    },
    Resize {
        width: u32,
        height: u32,
    },
    /// `surfaceDestroyed` fired. The optional reply slot is what
    /// makes `clear_surface()` block until the render thread acks
    /// that the `SurfaceBoundState` has been dropped — keeps the
    /// drop inside the window where the ANativeWindow is still
    /// valid.
    SurfaceLost {
        reply: Option<SyncSender<()>>,
    },
    /// One platform-neutral pointer sample. The platform layer
    /// (today: `crate::drawing::platform::android`) converts native event shapes
    /// into [`Sample`] before sending. See `crate::drawing::input`
    /// for the type definitions.
    Sample(Sample),
    Clear,
    /// Switch which note's stroke document the renderer is editing.
    /// `None` parks the renderer with no active document (no
    /// strokes drawn, samples ignored). Sent from `drawing_show`
    /// before the SurfaceView is brought up so the first render
    /// already shows the right note's content.
    ///
    /// `initial_state` is the persisted yrs bytes for this note —
    /// the frontend loads it from SQLite and passes it through.
    /// Empty / missing = fresh note. Only consulted when the note
    /// isn't already in the in-memory `documents` map; subsequent
    /// activations of the same note id reuse the live doc so the
    /// in-memory state stays authoritative.
    SetActiveNote {
        note_id: Option<String>,
        initial_state: Option<Vec<u8>>,
    },
    /// Request a yrs serialisation of the active note's stroke
    /// document. The render thread replies with the encoded
    /// bytes (or empty if no active note). Used by
    /// `drawing_get_state` to fetch state for `save_note`.
    GetState {
        reply: SyncSender<Vec<u8>>,
    },
}

/// A single reversible change to the active note's stroke document,
/// captured for the undo/redo stack. Each variant's *direction* is
/// determined by which stack it's on: an `UndoOp` on the undo stack
/// represents "do the inverse to undo me"; the same op moved to the
/// redo stack represents "redo my original effect".
///
/// Stroke entries are referenced by id (the uuid assigned at
/// `end_stroke` time), not array index, so concurrent remote
/// inserts can't shift the indices out from under our records.
#[derive(Debug, Clone)]
enum UndoOp {
    /// User drew a new stroke. Undo: tombstone it. Redo: untombstone.
    StrokeAdded(String),
    /// One eraser drag tombstoned this set of strokes. The whole
    /// drag is one undo step (matches Apple Notes / OneNote UX) —
    /// undoing un-tombstones every stroke the eraser touched in
    /// that gesture. Redo re-tombstones them.
    EraserDrag(Vec<String>),
    /// Toolbar Clear: every previously-visible stroke at the time
    /// of the press, captured so undo restores exactly what was
    /// visible (rather than untombstoning every doc entry including
    /// strokes the user had already erased before pressing Clear).
    ClearAll(Vec<String>),
}

/// Per-note stroke storage on the render thread.
///
/// `strokes_doc` is the source of truth — yrs-backed, mergeable,
/// what we serialise on save. `segments` is a render-side cache of
/// tessellated triangle vertices derived from `strokes_doc`; we keep
/// it because rebuilding from yrs on every frame would cost an
/// O(strokes × segments) walk through the doc. The two are kept in
/// sync by the sample handlers (pen ACTION_DOWN/MOVE/UP append to
/// both), `CanvasDocument::from_bytes` / `rebuild_segments` (which
/// re-tessellate from scratch after a doc-level mutation like
/// undo/redo/clear/initial-decode), and the eraser hit-test path
/// (which rebuilds after tombstoning).
///
/// `undo` / `redo` are per-note transient stacks — not persisted,
/// scoped to this note's open session. Switching to a different
/// note in the same process keeps its stacks intact; restarting the
/// app loses history (acceptable; matches every consumer note app).
struct CanvasDocument {
    strokes_doc: StrokesDoc,
    segments: Vec<Vertex>,
    undo: Vec<UndoOp>,
    redo: Vec<UndoOp>,
}

impl CanvasDocument {
    fn new() -> Self {
        Self {
            strokes_doc: StrokesDoc::new(),
            segments: Vec::new(),
            undo: Vec::new(),
            redo: Vec::new(),
        }
    }

    /// Record a new mutating op on the undo stack and clear the redo
    /// stack. Standard undo/redo semantics — any fresh user action
    /// invalidates the previously-redoable history.
    fn record_op(&mut self, op: UndoOp) {
        self.undo.push(op);
        self.redo.clear();
    }

    /// Apply the *inverse* of `op` to the doc — what the user means
    /// when they press Undo for the op that was at the top of the
    /// undo stack. Caller is responsible for stack-juggling (popping
    /// from undo, pushing to redo) — separated so the borrow shapes
    /// stay simple.
    fn apply_undo_op(&mut self, op: &UndoOp) {
        match op {
            UndoOp::StrokeAdded(id) => {
                self.strokes_doc.set_stroke_tombstoned(id, true);
            }
            UndoOp::EraserDrag(ids) | UndoOp::ClearAll(ids) => {
                for id in ids {
                    self.strokes_doc.set_stroke_tombstoned(id, false);
                }
            }
        }
        self.rebuild_segments();
    }

    /// Apply `op` in its original direction — what the user means by
    /// Redo. Mirror of [`apply_undo_op`].
    fn apply_redo_op(&mut self, op: &UndoOp) {
        match op {
            UndoOp::StrokeAdded(id) => {
                self.strokes_doc.set_stroke_tombstoned(id, false);
            }
            UndoOp::EraserDrag(ids) | UndoOp::ClearAll(ids) => {
                for id in ids {
                    self.strokes_doc.set_stroke_tombstoned(id, true);
                }
            }
        }
        self.rebuild_segments();
    }

    /// Re-tessellate `segments` from the current strokes_doc state.
    /// Used after doc-level mutations (undo/redo/clear/eraser drag)
    /// where the visible-stroke set changed but we don't want to
    /// re-decode bytes — just re-walk what's already in memory.
    fn rebuild_segments(&mut self) {
        // Build into a local Vec then swap, so the closure captures
        // `&mut local_segments` (disjoint from the `&self.strokes_doc`
        // for_each_stroke needs).
        let mut fresh: Vec<Vertex> = Vec::new();
        self.strokes_doc.for_each_stroke(|view| {
            let color = pack_color_bytes(view.color);
            let mut prev: Option<(f32, f32, f32)> = None;
            for (i, chunk) in view.points.chunks_exact(2).enumerate() {
                let curr_p = view.pressures.get(i).copied().unwrap_or(1.0);
                let curr = (chunk[0], chunk[1], curr_p);
                if let Some((px, py, pp)) = prev {
                    let w_prev = width_for_pressure(pp);
                    let w_curr = width_for_pressure(curr.2);
                    fresh.extend_from_slice(&tessellate_segment(
                        (px, py),
                        (curr.0, curr.1),
                        w_prev,
                        w_curr,
                        color,
                    ));
                }
                prev = Some(curr);
            }
        });
        self.segments = fresh;
    }

    fn from_bytes(bytes: &[u8]) -> Self {
        // Timing — scales with stroke count, so heavy notes might
        // measurably stall the first frame after open. Logging
        // here makes it obvious when the rebuild itself is the
        // perf bottleneck vs. wgpu init or IPC overhead.
        let t_total = std::time::Instant::now();
        let t_decode = std::time::Instant::now();
        let strokes_doc = StrokesDoc::from_bytes(bytes);
        let decode_ms = t_decode.elapsed();
        let mut segments = Vec::new();
        let mut stroke_count: usize = 0;
        // Each stroke's points are [x0, y0, x1, y1, …]; emit
        // (prev → curr) line-list pairs for the GPU. Single-point
        // strokes (no second sample) generate no segments — the
        // user lifted the pen without moving; nothing to draw.
        // Walk each stroke's (point, pressure) pairs and emit a
        // tessellated quad per segment, coloured by the stroke's
        // stored colour. Geometry + colour are identical to what the
        // live ACTION_MOVE handler emits, so a re-hydrated doc
        // renders pixel-equivalently to the same doc replayed
        // sample-by-sample.
        strokes_doc.for_each_stroke(|view| {
            stroke_count += 1;
            let color = pack_color_bytes(view.color);
            let mut prev: Option<(f32, f32, f32)> = None;
            for (i, chunk) in view.points.chunks_exact(2).enumerate() {
                let curr_p = view.pressures.get(i).copied().unwrap_or(1.0);
                let curr = (chunk[0], chunk[1], curr_p);
                if let Some((px, py, pp)) = prev {
                    let w_prev = width_for_pressure(pp);
                    let w_curr = width_for_pressure(curr.2);
                    segments.extend_from_slice(&tessellate_segment(
                        (px, py),
                        (curr.0, curr.1),
                        w_prev,
                        w_curr,
                        color,
                    ));
                }
                prev = Some(curr);
            }
        });
        log::info!(
            "[drawing.perf] from_bytes TOTAL={:?} decode={:?} bytes={} strokes={} vertices={}",
            t_total.elapsed(),
            decode_ms,
            bytes.len(),
            stroke_count,
            segments.len(),
        );
        Self {
            strokes_doc,
            segments,
            undo: Vec::new(),
            redo: Vec::new(),
        }
    }
}

/// Find every visible stroke whose closest segment is within
/// [`ERASER_RADIUS_PAGE`] of `point` (page coordinates). Walks the
/// outer strokes array once; for each stroke, checks segments until
/// the first hit (early-returns from the closure — no point
/// re-tombstoning the same stroke multiple times via different
/// segments). Returns the matched stroke ids; caller tombstones +
/// records the eraser-drag op.
fn strokes_within_eraser_radius(
    strokes_doc: &StrokesDoc,
    point: (f32, f32),
) -> Vec<String> {
    let mut hits = Vec::new();
    let radius_sq = ERASER_RADIUS_PAGE * ERASER_RADIUS_PAGE;
    strokes_doc.for_each_stroke(|view| {
        let mut prev: Option<(f32, f32)> = None;
        for chunk in view.points.chunks_exact(2) {
            let curr = (chunk[0], chunk[1]);
            if let Some(prev_pt) = prev {
                if point_to_segment_distance_sq(point, prev_pt, curr) <= radius_sq {
                    hits.push(view.id.to_string());
                    return;
                }
            }
            prev = Some(curr);
        }
    });
    hits
}

/// Run the eraser hit-test for one sample at `(x, y)` (surface
/// coords), tombstone every newly-hit stroke in the active note's
/// doc, dedupe via `seen` so subsequent samples in the same drag
/// don't re-tombstone the same stroke, and append the new hits to
/// `drag_hits` (committed as a single `UndoOp::EraserDrag` on UP).
///
/// Splits out of the `Msg::Sample` arm because both DOWN and MOVE
/// need this exact sequence; inlining would mean duplicating the
/// borrow dance around `documents` + `surface_state`.
fn erase_at(
    active_note_id: &Option<String>,
    documents: &mut HashMap<String, CanvasDocument>,
    surface_state: Option<&SurfaceBoundState>,
    sample_surface: (f32, f32),
    drag_hits: &mut Vec<String>,
    seen: &mut HashSet<String>,
) {
    let Some(id) = active_note_id.as_ref() else {
        return;
    };
    let Some(s) = surface_state else {
        return;
    };
    let doc = documents.entry(id.clone()).or_insert_with(CanvasDocument::new);
    let [px, py] = s.surface_to_page(sample_surface.0, sample_surface.1);
    let fresh_hits: Vec<String> = strokes_within_eraser_radius(&doc.strokes_doc, (px, py))
        .into_iter()
        .filter(|hit_id| seen.insert(hit_id.clone()))
        .collect();
    if fresh_hits.is_empty() {
        return;
    }
    for hit_id in &fresh_hits {
        doc.strokes_doc.set_stroke_tombstoned(hit_id, true);
    }
    doc.rebuild_segments();
    drag_hits.extend(fresh_hits);
}

// `unsafe impl Send for Msg` is no longer required: post-R3 every
// `Msg` variant is built from `Send` fields (`Box<dyn SurfaceSource>`
// includes `Send` in the trait bounds, so the dyn object is `Send`
// too). The compiler now derives Send automatically. Kept this
// note rather than deleting silently because the previous unsafe
// impl was load-bearing on the old `NonNull<ANativeWindow>` design.

// ---------- channel plumbing ----------

static SENDER: OnceLock<Mutex<Option<Sender<Msg>>>> = OnceLock::new();

fn sender_slot() -> &'static Mutex<Option<Sender<Msg>>> {
    SENDER.get_or_init(|| Mutex::new(None))
}

/// Send a message to the render thread, lazily spawning the thread
/// on first call. This is the single entry point all public
/// APIs (and the JNI exports) go through.
///
/// Lazy spawn here, not in `set_surface`, because `drawing_show`
/// calls `set_active_note` BEFORE `call_show` — without the lazy
/// spawn the SetActiveNote message lands in a None sender slot
/// and gets dropped, leaving `active_note_id` unset and the first
/// surfaceCreated → render rendering an empty doc.
fn send(msg: Msg) {
    let mut slot = match sender_slot().lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if slot.is_none() {
        let (tx, rx) = mpsc::channel();
        thread::Builder::new()
            .name("mindstream-drawing".into())
            .spawn(move || {
                // catch_unwind so a panic inside wgpu / egui / our
                // own code surfaces in logcat with a backtrace
                // instead of disappearing into a bare SIGSEGV.
                if let Err(payload) =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| render_thread(rx)))
                {
                    let msg = if let Some(s) = payload.downcast_ref::<&str>() {
                        (*s).to_string()
                    } else if let Some(s) = payload.downcast_ref::<String>() {
                        s.clone()
                    } else {
                        "unknown panic payload".to_string()
                    };
                    log::error!("[drawing] render thread panicked: {msg}");
                }
            })
            .expect("spawn drawing render thread");
        *slot = Some(tx);
    }
    if let Some(tx) = slot.as_ref() {
        let _ = tx.send(msg);
    }
}

// ---------- public API (called from JNI exports in jni.rs) ----------

/// Request a prewarm of the surface-independent wgpu state
/// (`PersistentGpu`). Called once at app startup from
/// `lib.rs::run`'s Tauri setup hook so the heavy adapter / device /
/// pipeline / egui-renderer build is off the user-perceived
/// "tap ink note → see canvas" critical path. Fires off the message
/// and returns immediately — the actual build runs on the render
/// thread (spawned lazily by `send` here on first call).
pub fn prewarm() {
    send(Msg::Prewarm);
}

/// Platform-bridge entrypoint: hand a freshly-acquired
/// `SurfaceSource` to the render thread. The caller (today: the
/// `setSurface` JNI export in `platform::android`) constructs the
/// platform-specific window wrapper and boxes it as `dyn SurfaceSource`
/// so the render thread never has to name the concrete type.
pub fn set_surface(window: Box<dyn SurfaceSource>, width: u32, height: u32) {
    send(Msg::SurfaceReady {
        window,
        width,
        height,
    });
}

pub fn resize_surface(width: u32, height: u32) {
    send(Msg::Resize { width, height });
}

/// Synchronously drop the wgpu surface — blocks the JNI caller
/// until the render thread acks. This must run before the JNI
/// thread returns from `SurfaceHolder.Callback.surfaceDestroyed`,
/// otherwise Android invalidates the ANativeWindow under wgpu's
/// feet and the swap-chain teardown races into a destroyed EGL
/// context (FORTIFY pthread_mutex_lock-on-destroyed-mutex
/// SIGABRT).
///
/// Bounded wait: a stuck render thread shouldn't hang Android's
/// surface lifecycle indefinitely. 500ms is generous for "drop a
/// Surface" and matches the order of magnitude Android gives
/// lifecycle callbacks before ANR.
pub fn clear_surface() {
    let render_thread_present = sender_slot()
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false);
    log::info!(
        "[drawing] clear_surface: entering sync wait (render thread alive = {render_thread_present})"
    );
    let (tx, rx) = mpsc::sync_channel::<()>(1);
    send(Msg::SurfaceLost { reply: Some(tx) });
    match rx.recv_timeout(Duration::from_millis(500)) {
        Ok(()) => log::info!("[drawing] clear_surface: render thread acked drop"),
        Err(_) => log::warn!("[drawing] clear_surface: ack timed out — proceeding anyway"),
    }
}

pub fn push_sample(sample: Sample) {
    // debug! rather than trace! so the per-sample stream is visible
    // under default logcat filters during POC bring-up. Drop back
    // to trace! once the input pipeline is fully verified. Buttons
    // are logged in hex so the BUTTON_STYLUS_PRIMARY bit (0x20) is
    // obvious at a glance when the user holds the S Pen side button.
    log::debug!(
        "[drawing] push_sample x={x:.1} y={y:.1} p={p:.2} tool={tool:?} buttons=0x{buttons:x} action={action:?}",
        x = sample.x,
        y = sample.y,
        p = sample.pressure,
        tool = sample.tool,
        buttons = sample.buttons,
        action = sample.action,
    );
    send(Msg::Sample(sample));
}

pub fn clear_strokes() {
    send(Msg::Clear);
}

/// Tell the render thread which note's stroke document is active.
/// Pass `None` for `note_id` to detach (no doc → renderer paints
/// background + toolbar only, samples ignored). `initial_state` is
/// the persisted yrs bytes from SQLite — only consulted if this is
/// the first activation of this note in the current process, so
/// hot-reloads (open A → home → open A again) don't blow away
/// in-memory edits with stale disk state.
pub fn set_active_note(note_id: Option<String>, initial_state: Option<Vec<u8>>) {
    send(Msg::SetActiveNote {
        note_id,
        initial_state,
    });
}

/// Synchronously fetch the active note's stroke document as v1-yrs
/// bytes — what the frontend hands to `save_note` to persist.
/// Returns empty if no note is active or the render thread isn't
/// responsive (bounded by the same 500ms timeout the other sync
/// JNI calls use). Blocks the calling thread.
pub fn get_active_state() -> Vec<u8> {
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(1);
    send(Msg::GetState { reply: tx });
    rx.recv_timeout(Duration::from_millis(500)).unwrap_or_default()
}

// ---------- render thread ----------

/// Translate a pixel coordinate (origin top-left) into the egui
/// "point" space the Context lives in.
fn px_to_egui(x: f32, y: f32) -> egui::Pos2 {
    egui::Pos2::new(x / ui::PIXELS_PER_POINT, y / ui::PIXELS_PER_POINT)
}

/// Slice into the active note's stroke segments — empty slice if
/// no note is active or its doc hasn't been seeded yet. Lifetime
/// is tied to the `documents` borrow so the slice can be handed
/// straight to `pipeline::render_frame` without a clone.
fn active_segments<'a>(
    active_id: &Option<String>,
    documents: &'a HashMap<String, CanvasDocument>,
) -> &'a [Vertex] {
    active_id
        .as_ref()
        .and_then(|id| documents.get(id))
        .map(|d| d.segments.as_slice())
        .unwrap_or(&[])
}

/// Snapshot the bits the egui toolbar needs to render correctly:
/// the active tool (for the selected-button highlight) and whether
/// the undo / redo stacks have anything to pop (for the
/// add_enabled grey-out). Defaults to "no buttons enabled" if no
/// note is open or the doc hasn't been activated yet.
fn build_ui_state(
    tool_mode: ToolMode,
    active_id: &Option<String>,
    documents: &HashMap<String, CanvasDocument>,
) -> UiState {
    let active = active_id.as_ref().and_then(|id| documents.get(id));
    UiState {
        current_tool: tool_mode,
        can_undo: active.map(|d| !d.undo.is_empty()).unwrap_or(false),
        can_redo: active.map(|d| !d.redo.is_empty()).unwrap_or(false),
    }
}

fn render_thread(rx: mpsc::Receiver<Msg>) {
    let mut persistent: Option<PersistentGpu> = None;
    let mut surface_state: Option<SurfaceBoundState> = None;
    let mut canvas_ui = CanvasUi::new();
    // Per-note stroke storage. Keyed by note_id. Entries are
    // created lazily on the first sample for an active note and
    // live for the render thread's lifetime (= process lifetime,
    // ephemeral until C2 lands yrs persistence).
    let mut documents: HashMap<String, CanvasDocument> = HashMap::new();
    // Which document samples accumulate into and which renders
    // pull segments from. `None` means "no note open" — the
    // renderer still draws background + toolbar but skips strokes.
    let mut active_note_id: Option<String> = None;
    // The most-recent sample's surface coordinates + pressure, used
    // to anchor the next MOVE sample's starting vertex (position) and
    // its starting width (pressure). None between strokes.
    // Per-stroke transient; reset on active-note swap so an
    // in-flight stroke can't leak from one note into another.
    let mut last_point: Option<(f32, f32)> = None;
    let mut last_pressure: Option<f32> = None;
    // Linear-RGBA colour for the currently-open stroke, chosen at
    // ACTION_DOWN from the input tool type via [`color_for_tool`].
    // Same lifecycle as `last_point` — None between strokes; set on
    // DOWN; consumed on every MOVE's tessellation; cleared on UP /
    // CANCEL / Clear / SetActiveNote so a leaked colour can't paint
    // an unrelated note's stroke the wrong shade.
    let mut current_stroke_color: Option<[u8; 4]> = None;
    // User-selected drawing tool. Authoritative state lives here on
    // the render thread; the egui toolbar mirrors via UiState and
    // sends changes back via RenderActions::set_tool. Defaults to
    // Pen — the existing single-tool behaviour pre-D3.
    let mut tool_mode: ToolMode = ToolMode::Pen;
    // Strokes tombstoned during the *current* eraser drag (between
    // ACTION_DOWN and ACTION_UP in Eraser mode). On UP, this Vec
    // becomes the payload of a single `UndoOp::EraserDrag` so the
    // whole drag is one undo step. The HashSet sibling is just a
    // dedup so we don't tombstone the same stroke twice when the
    // eraser passes over it multiple times mid-drag.
    let mut eraser_drag_hits: Vec<String> = Vec::new();
    let mut eraser_drag_seen: HashSet<String> = HashSet::new();
    // True while the in-progress gesture started inside the toolbar
    // region — mirror to egui so its buttons see the press, but
    // skip the line pipeline.
    let mut stroke_suppressed = false;
    // Per-frame input batch handed to egui. Drained on each render
    // via std::mem::take.
    let mut egui_input = egui::RawInput::default();
    // One-shot: log the duration of the very first successful
    // render_frame. That's the "user-perceived first paint" cost,
    // separate from the wgpu init logged elsewhere. Flipped to
    // false after the first log so subsequent frames stay quiet.
    let mut log_first_frame = true;

    loop {
        let first = match rx.recv() {
            Ok(m) => m,
            Err(_) => return,
        };
        let mut messages = vec![first];
        loop {
            match rx.try_recv() {
                Ok(m) => messages.push(m),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return,
            }
        }

        let mut dirty = false;
        let mut needs_rebuild = false;
        for msg in messages {
            match msg {
                Msg::Prewarm => {
                    if persistent.is_some() {
                        log::debug!("[drawing] Prewarm requested but PersistentGpu already built — ignoring");
                    } else {
                        log::info!("[drawing] Prewarm: building PersistentGpu in the background");
                        match pollster::block_on(pipeline::build_persistent()) {
                            Ok(p) => persistent = Some(p),
                            Err(e) => log::error!(
                                "[drawing] prewarm build_persistent failed: {e:?} — first ink open will fall back to lazy init"
                            ),
                        }
                    }
                }
                Msg::SurfaceReady {
                    window,
                    width,
                    height,
                } => {
                    // Mark SurfaceReady arrival — this is the
                    // hand-off point between "Android UI thread
                    // attached the SurfaceView" and "render thread
                    // is doing wgpu work". The wallclock between
                    // drawing_show (logged in mod.rs) and this line
                    // is roughly the Kotlin runOnUiThread + addView
                    // + layout-pass cost.
                    let t_ready = std::time::Instant::now();
                    surface_state = None;
                    // Lazy fallback: if `Msg::Prewarm` didn't run
                    // (or didn't finish) before this, build
                    // PersistentGpu now on the critical path. Same
                    // wall-clock as the old `build_first_time`
                    // pathway — worst case = today's experience.
                    let prewarmed = persistent.is_some();
                    if !prewarmed {
                        match pollster::block_on(pipeline::build_persistent()) {
                            Ok(p) => persistent = Some(p),
                            Err(e) => {
                                log::error!("[drawing] lazy build_persistent failed: {e:?}");
                                continue;
                            }
                        }
                    }
                    let p = persistent.as_ref().expect("persistent built above");
                    match pollster::block_on(pipeline::build_surface_bound(
                        p, window, width, height,
                    )) {
                        Ok(s) => {
                            surface_state = Some(s);
                            needs_rebuild = true;
                        }
                        Err(e) => log::error!("[drawing] build_surface_bound failed: {e:?}"),
                    }
                    let path = if prewarmed { "prewarmed" } else { "lazy_persistent" };
                    log::info!(
                        "[drawing.perf] SurfaceReady handled in {:?} (path={path} size={width}x{height})",
                        t_ready.elapsed(),
                    );
                }
                Msg::Resize { width, height } => {
                    if let (Some(p), Some(s)) = (persistent.as_ref(), surface_state.as_mut()) {
                        let (prev_w, prev_h) = s.size_px();
                        log::info!(
                            "[drawing] Msg::Resize w={width} h={height} (was {prev_w}x{prev_h})"
                        );
                        s.resize(p, width, height);
                        dirty = true;
                    }
                }
                Msg::SurfaceLost { reply } => {
                    surface_state = None;
                    if let Some(tx) = reply {
                        let _ = tx.send(());
                    }
                }
                Msg::Sample(sample) => {
                    let Sample {
                        x,
                        y,
                        pressure,
                        tool,
                        buttons,
                        action,
                    } = sample;
                    let pos = px_to_egui(x, y);
                    // Forward all gestures to egui so toolbar buttons
                    // remain interactive regardless of tool mode.
                    match action {
                        SampleAction::Down => {
                            egui_input.events.push(egui::Event::PointerMoved(pos));
                            egui_input.events.push(egui::Event::PointerButton {
                                pos,
                                button: egui::PointerButton::Primary,
                                pressed: true,
                                modifiers: egui::Modifiers::NONE,
                            });
                        }
                        SampleAction::Move => {
                            egui_input.events.push(egui::Event::PointerMoved(pos));
                        }
                        SampleAction::Up | SampleAction::Cancel => {
                            egui_input.events.push(egui::Event::PointerButton {
                                pos,
                                button: egui::PointerButton::Primary,
                                pressed: false,
                                modifiers: egui::Modifiers::NONE,
                            });
                        }
                    }
                    // Toolbar-region gesture? Suppress both pen + eraser
                    // paths for the duration of the drag so the user can
                    // tap buttons without unintended draws or erases.
                    if matches!(action, SampleAction::Down) {
                        stroke_suppressed = y < ui::toolbar::TOOLBAR_HEIGHT_PX;
                    }
                    dirty = true;
                    if stroke_suppressed {
                        if matches!(action, SampleAction::Up | SampleAction::Cancel) {
                            stroke_suppressed = false;
                        }
                        continue;
                    }

                    // Branch on tool. Pen and Eraser have very
                    // different data flows — Pen accumulates points
                    // into an in-progress yrs stroke, Eraser hits
                    // existing strokes per-sample and tombstones
                    // them. Common state (last_point / last_pressure)
                    // is reused so a future tool switch keeps the
                    // "where did the last sample land" cursor.
                    match (tool_mode, action) {
                        // ---------- Pen ----------
                        (ToolMode::Pen, SampleAction::Down) => {
                            last_point = Some((x, y));
                            last_pressure = Some(pressure);
                            let packed = color_for_input(tool, buttons);
                            log::info!(
                                "[drawing] stroke_open tool={tool:?} buttons=0x{buttons:x} -> color=0x{packed:08X}"
                            );
                            current_stroke_color = Some(pack_color_bytes(packed));
                            if let (Some(id), Some(s)) =
                                (active_note_id.as_ref(), surface_state.as_ref())
                            {
                                let doc = documents
                                    .entry(id.clone())
                                    .or_insert_with(CanvasDocument::new);
                                doc.strokes_doc.begin_stroke(packed);
                                let [px, py] = s.surface_to_page(x, y);
                                doc.strokes_doc.push_point(px, py, pressure);
                            }
                        }
                        (ToolMode::Pen, SampleAction::Move) => {
                            if let (
                                Some((px, py)),
                                Some(pp),
                                Some(color),
                                Some(s),
                                Some(id),
                            ) = (
                                last_point,
                                last_pressure,
                                current_stroke_color,
                                surface_state.as_ref(),
                                active_note_id.as_ref(),
                            ) {
                                let prev_page = s.surface_to_page(px, py);
                                let curr_page = s.surface_to_page(x, y);
                                let doc = documents
                                    .entry(id.clone())
                                    .or_insert_with(CanvasDocument::new);
                                let w_prev = width_for_pressure(pp);
                                let w_curr = width_for_pressure(pressure);
                                doc.segments.extend_from_slice(&tessellate_segment(
                                    (prev_page[0], prev_page[1]),
                                    (curr_page[0], curr_page[1]),
                                    w_prev,
                                    w_curr,
                                    color,
                                ));
                                doc.strokes_doc.push_point(
                                    curr_page[0],
                                    curr_page[1],
                                    pressure,
                                );
                            }
                            last_point = Some((x, y));
                            last_pressure = Some(pressure);
                        }
                        (ToolMode::Pen, SampleAction::Up | SampleAction::Cancel) => {
                            if let Some(id) = active_note_id.as_ref() {
                                let committed_id = documents
                                    .get_mut(id)
                                    .and_then(|doc| doc.strokes_doc.end_stroke());
                                if let Some(stroke_id) = committed_id {
                                    // Pen stroke landed in the doc —
                                    // record an undo op + notify
                                    // auto-save.
                                    if let Some(doc) = documents.get_mut(id) {
                                        doc.record_op(UndoOp::StrokeAdded(stroke_id));
                                    }
                                    crate::drawing::notify_dirty(id);
                                }
                            }
                            last_point = None;
                            last_pressure = None;
                            current_stroke_color = None;
                        }
                        // ---------- Eraser ----------
                        (ToolMode::Eraser, SampleAction::Down) => {
                            // Start a fresh drag — undo gets one
                            // step for the whole drag, not per hit.
                            eraser_drag_hits.clear();
                            eraser_drag_seen.clear();
                            last_point = Some((x, y));
                            erase_at(
                                &active_note_id,
                                &mut documents,
                                surface_state.as_ref(),
                                (x, y),
                                &mut eraser_drag_hits,
                                &mut eraser_drag_seen,
                            );
                        }
                        (ToolMode::Eraser, SampleAction::Move) => {
                            erase_at(
                                &active_note_id,
                                &mut documents,
                                surface_state.as_ref(),
                                (x, y),
                                &mut eraser_drag_hits,
                                &mut eraser_drag_seen,
                            );
                            last_point = Some((x, y));
                        }
                        (ToolMode::Eraser, SampleAction::Up | SampleAction::Cancel) => {
                            // Commit the drag as a single undo step
                            // (if anything was actually erased).
                            if !eraser_drag_hits.is_empty() {
                                if let Some(id) = active_note_id.as_ref() {
                                    if let Some(doc) = documents.get_mut(id) {
                                        let hits = std::mem::take(&mut eraser_drag_hits);
                                        doc.record_op(UndoOp::EraserDrag(hits));
                                    }
                                    crate::drawing::notify_dirty(id);
                                }
                            }
                            eraser_drag_hits.clear();
                            eraser_drag_seen.clear();
                            last_point = None;
                        }
                    }
                }
                Msg::Clear => {
                    if let Some(id) = active_note_id.as_ref() {
                        if let Some(doc) = documents.get_mut(id) {
                            // Capture which strokes were visible
                            // before the clear so undo restores
                            // exactly that set (rather than blindly
                            // untombstoning every doc entry —
                            // resurrecting strokes the user had
                            // already erased earlier).
                            let mut cleared: Vec<String> = Vec::new();
                            doc.strokes_doc.for_each_stroke(|view| {
                                cleared.push(view.id.to_string());
                            });
                            doc.strokes_doc.tombstone_all();
                            doc.segments.clear();
                            if !cleared.is_empty() {
                                doc.record_op(UndoOp::ClearAll(cleared));
                            }
                        }
                        crate::drawing::notify_dirty(id);
                    }
                    last_point = None;
                    last_pressure = None;
                    current_stroke_color = None;
                    eraser_drag_hits.clear();
                    eraser_drag_seen.clear();
                    dirty = true;
                }
                Msg::SetActiveNote {
                    note_id,
                    initial_state,
                } => {
                    log::info!(
                        "[drawing] active note: {:?} -> {:?} (initial state: {} bytes)",
                        active_note_id.as_deref(),
                        note_id.as_deref(),
                        initial_state.as_deref().map(|b| b.len()).unwrap_or(0)
                    );
                    if let Some(id) = note_id.as_ref() {
                        // First activation of this note in the
                        // process → decode the persisted bytes from
                        // SQLite. Subsequent activations (e.g. open
                        // A → home → A) reuse the live doc so any
                        // in-memory edits since the last save aren't
                        // lost to a stale disk snapshot.
                        documents.entry(id.clone()).or_insert_with(|| {
                            CanvasDocument::from_bytes(
                                initial_state.as_deref().unwrap_or(&[]),
                            )
                        });
                    }
                    active_note_id = note_id;
                    // Truncate any in-flight stroke or eraser drag
                    // that came from the previous note's gesture so
                    // it can't leak into the new doc on the next
                    // MOVE sample. Tool mode itself is intentionally
                    // preserved across notes — most users want a
                    // single "I'm in pen mode" mental model rather
                    // than per-note settings.
                    last_point = None;
                    last_pressure = None;
                    current_stroke_color = None;
                    eraser_drag_hits.clear();
                    eraser_drag_seen.clear();
                    stroke_suppressed = false;
                    dirty = true;
                }
                Msg::GetState { reply } => {
                    let bytes = active_note_id
                        .as_ref()
                        .and_then(|id| documents.get(id))
                        .map(|doc| doc.strokes_doc.encode())
                        .unwrap_or_default();
                    let _ = reply.send(bytes);
                }
            }
        }

        if let (Some(p), Some(s)) = (persistent.as_mut(), surface_state.as_mut()) {
            if needs_rebuild || dirty {
                let segs = active_segments(&active_note_id, &documents);
                let segs_len = segs.len();
                let input = std::mem::take(&mut egui_input);
                // Build the UiState the toolbar reads for selected-
                // tool highlight + undo/redo button enabled state.
                // Active doc lookup is `documents.get(id)`; defaults
                // to "no buttons enabled" when no note is open or
                // the doc hasn't been activated yet.
                let ui_state = build_ui_state(tool_mode, &active_note_id, &documents);
                let (actions, ui_output) = canvas_ui.run(input, s.size_px(), ui_state);
                let t_frame = std::time::Instant::now();
                match pipeline::render_frame(p, s, segs, ui_output) {
                    Ok(()) => {
                        if log_first_frame {
                            log::info!(
                                "[drawing.perf] first render_frame took {:?} (vertices={})",
                                t_frame.elapsed(),
                                segs_len,
                            );
                            log_first_frame = false;
                        }

                        // Drive doc/state mutations from toolbar
                        // actions. Anything that changes what's
                        // visible flips `needs_rerender = true` so we
                        // submit a follow-up frame at the bottom of
                        // this block — the user sees the result
                        // immediately rather than waiting for the
                        // next sample.
                        let mut needs_rerender = false;

                        if let Some(new_tool) = actions.set_tool {
                            log::info!(
                                "[drawing] tool: {:?} -> {:?}",
                                tool_mode,
                                new_tool
                            );
                            tool_mode = new_tool;
                            // Drop any in-flight gesture state —
                            // switching mid-drag shouldn't carry pen
                            // or eraser buffers across.
                            last_point = None;
                            last_pressure = None;
                            current_stroke_color = None;
                            eraser_drag_hits.clear();
                            eraser_drag_seen.clear();
                            // Tool change alone doesn't repaint
                            // anything, but the toolbar highlight
                            // needs a re-render to reflect it.
                            needs_rerender = true;
                        }

                        if actions.undo {
                            if let Some(id) = active_note_id.as_ref() {
                                if let Some(doc) = documents.get_mut(id) {
                                    if let Some(op) = doc.undo.pop() {
                                        doc.apply_undo_op(&op);
                                        doc.redo.push(op);
                                        crate::drawing::notify_dirty(id);
                                        needs_rerender = true;
                                    }
                                }
                            }
                        }

                        if actions.redo {
                            if let Some(id) = active_note_id.as_ref() {
                                if let Some(doc) = documents.get_mut(id) {
                                    if let Some(op) = doc.redo.pop() {
                                        doc.apply_redo_op(&op);
                                        doc.undo.push(op);
                                        crate::drawing::notify_dirty(id);
                                        needs_rerender = true;
                                    }
                                }
                            }
                        }

                        if actions.clear {
                            if let Some(id) = active_note_id.as_ref() {
                                if let Some(doc) = documents.get_mut(id) {
                                    // Capture pre-clear visibility
                                    // for the ClearAll undo step,
                                    // matching Msg::Clear semantics.
                                    let mut cleared: Vec<String> = Vec::new();
                                    doc.strokes_doc.for_each_stroke(|view| {
                                        cleared.push(view.id.to_string());
                                    });
                                    doc.strokes_doc.tombstone_all();
                                    doc.segments.clear();
                                    if !cleared.is_empty() {
                                        doc.record_op(UndoOp::ClearAll(cleared));
                                    }
                                }
                                crate::drawing::notify_dirty(id);
                            }
                            last_point = None;
                            last_pressure = None;
                            current_stroke_color = None;
                            eraser_drag_hits.clear();
                            eraser_drag_seen.clear();
                            needs_rerender = true;
                        }

                        if needs_rerender {
                            // Build a fresh frame from the post-
                            // mutation state. New UiState so the
                            // toolbar reflects e.g. an empty undo
                            // stack after we popped its last entry.
                            let fresh_segs =
                                active_segments(&active_note_id, &documents);
                            let fresh_input = egui::RawInput::default();
                            let fresh_state = build_ui_state(
                                tool_mode,
                                &active_note_id,
                                &documents,
                            );
                            let (_, fresh_ui) =
                                canvas_ui.run(fresh_input, s.size_px(), fresh_state);
                            let _ = pipeline::render_frame(p, s, fresh_segs, fresh_ui);
                        }

                        if actions.back {
                            if let Err(e) = crate::drawing::platform::android::ui::call_back() {
                                log::warn!("[drawing] call_back failed: {e}");
                            }
                        }
                    }
                    Err(e) => log::warn!("[drawing] render failed: {e:?}"),
                }
            }
        }
    }
}
