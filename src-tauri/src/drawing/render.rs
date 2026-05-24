//! Render-thread orchestration and the JNI-facing public API.
//!
//! This file is the entry point the rest of the crate (`jni.rs`,
//! `mod.rs`) and Kotlin (via JNI exports) reach into to drive the
//! drawing engine. The actual work is delegated:
//!
//!   * `crate::drawing::pipeline` — wgpu state + per-frame GPU pass
//!   * `crate::drawing::ui`       — egui Context + UI widgets
//!   * `crate::drawing::surface`  — ANativeWindow ownership
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
use std::ptr::NonNull;
use std::sync::mpsc::{self, Sender, SyncSender, TryRecvError};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use super::pipeline::{self, PersistentGpu, SurfaceBoundState, Vertex};
use super::strokes_doc::StrokesDoc;
use super::ui::{self, CanvasUi};

/// Android MotionEvent action constants we care about. Mirrors
/// `android.view.MotionEvent.ACTION_*` so the Kotlin side can
/// forward the raw int without translation.
const ACTION_DOWN: i32 = 0;
const ACTION_UP: i32 = 1;
const ACTION_MOVE: i32 = 2;
const ACTION_CANCEL: i32 = 3;

/// Messages the render thread accepts.
enum Msg {
    SurfaceReady {
        native_window: NonNull<ndk_sys::ANativeWindow>,
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
    Sample {
        x: f32,
        y: f32,
        action: i32,
    },
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

/// Per-note stroke storage on the render thread.
///
/// `strokes_doc` is the source of truth — yrs-backed, mergeable,
/// what we serialise on save. `segments` is a render-side cache
/// of line-list vertex pairs derived from `strokes_doc`; we keep it
/// because the GPU needs paired vertices for `LineList` topology,
/// and reconstructing it every frame would cost an O(strokes ×
/// points) walk through the yrs doc. The two are kept in sync by
/// the sample handlers (`ACTION_DOWN`/`MOVE`/`UP` write to both)
/// and by `CanvasDocument::from_bytes` (which rebuilds `segments`
/// from the freshly-decoded doc).
struct CanvasDocument {
    strokes_doc: StrokesDoc,
    segments: Vec<Vertex>,
}

impl CanvasDocument {
    fn new() -> Self {
        Self {
            strokes_doc: StrokesDoc::new(),
            segments: Vec::new(),
        }
    }

    fn from_bytes(bytes: &[u8]) -> Self {
        let strokes_doc = StrokesDoc::from_bytes(bytes);
        let mut segments = Vec::new();
        // Each stroke's points are [x0, y0, x1, y1, …]; emit
        // (prev → curr) line-list pairs for the GPU. Single-point
        // strokes (no second sample) generate no segments — the
        // user lifted the pen without moving; nothing to draw.
        strokes_doc.for_each_stroke_points(|flat| {
            let mut prev: Option<(f32, f32)> = None;
            for chunk in flat.chunks_exact(2) {
                let curr = (chunk[0], chunk[1]);
                if let Some((px, py)) = prev {
                    segments.push(Vertex {
                        position: [px, py],
                    });
                    segments.push(Vertex {
                        position: [curr.0, curr.1],
                    });
                }
                prev = Some(curr);
            }
        });
        Self {
            strokes_doc,
            segments,
        }
    }
}

// SAFETY: NonNull<ANativeWindow> is the only non-Send field; the
// pointer is owned (acquired via ANativeWindow_fromSurface) and we
// transfer ownership across threads via the channel.
unsafe impl Send for Msg {}

// ---------- channel plumbing ----------

static SENDER: OnceLock<Mutex<Option<Sender<Msg>>>> = OnceLock::new();

fn sender_slot() -> &'static Mutex<Option<Sender<Msg>>> {
    SENDER.get_or_init(|| Mutex::new(None))
}

fn send(msg: Msg) {
    if let Ok(slot) = sender_slot().lock() {
        if let Some(tx) = slot.as_ref() {
            let _ = tx.send(msg);
        }
    }
}

// ---------- public API (called from JNI exports in jni.rs) ----------

/// JNI entrypoint: hand a freshly-acquired ANativeWindow over to
/// the render thread, spawning it lazily on first call.
pub fn set_surface(native_window: NonNull<ndk_sys::ANativeWindow>, width: u32, height: u32) {
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
        let _ = tx.send(Msg::SurfaceReady {
            native_window,
            width,
            height,
        });
    }
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

pub fn push_sample(x: f32, y: f32, action: i32) {
    // debug! rather than trace! so the per-sample stream is visible
    // under default logcat filters during POC bring-up. Drop back
    // to trace! once the input pipeline is fully verified.
    log::debug!("[drawing] push_sample x={x:.1} y={y:.1} action={action}");
    send(Msg::Sample { x, y, action });
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

fn render_thread(rx: mpsc::Receiver<Msg>) {
    let mut persistent: Option<PersistentGpu> = None;
    let mut surface_state: Option<SurfaceBoundState> = None;
    let mut canvas_ui = CanvasUi::new();
    // Per-note stroke storage. Keyed by note_id. Entries are
    // created lazily on the first sample for an active note and
    // live for the render thread's lifetime (= process lifetime,
    // ephemeral until C2 lands yrs persistence).
    let mut documents: HashMap<String, CanvasDocument> = HashMap::new();
    /// Which document samples accumulate into and which renders
    /// pull segments from. `None` means "no note open" — the
    /// renderer still draws background + toolbar but skips strokes.
    let mut active_note_id: Option<String> = None;
    // The most-recent sample's surface coordinates, used to anchor
    // the next MOVE sample's starting vertex. None between strokes.
    // Per-stroke transient; reset on active-note swap so an
    // in-flight stroke can't leak from one note into another.
    let mut last_point: Option<(f32, f32)> = None;
    // True while the in-progress gesture started inside the toolbar
    // region — mirror to egui so its buttons see the press, but
    // skip the line pipeline.
    let mut stroke_suppressed = false;
    // Per-frame input batch handed to egui. Drained on each render
    // via std::mem::take.
    let mut egui_input = egui::RawInput::default();

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
                Msg::SurfaceReady {
                    native_window,
                    width,
                    height,
                } => {
                    surface_state = None;
                    if persistent.is_none() {
                        match pollster::block_on(pipeline::build_first_time(
                            native_window,
                            width,
                            height,
                        )) {
                            Ok((p, s)) => {
                                persistent = Some(p);
                                surface_state = Some(s);
                                needs_rebuild = true;
                            }
                            Err(e) => log::error!("[drawing] build_first_time failed: {e:?}"),
                        }
                    } else {
                        let p = persistent.as_ref().unwrap();
                        match pollster::block_on(pipeline::build_surface_only(
                            p,
                            native_window,
                            width,
                            height,
                        )) {
                            Ok(s) => {
                                surface_state = Some(s);
                                needs_rebuild = true;
                            }
                            Err(e) => log::error!("[drawing] build_surface_only failed: {e:?}"),
                        }
                    }
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
                Msg::Sample { x, y, action } => {
                    let pos = px_to_egui(x, y);
                    match action {
                        ACTION_DOWN => {
                            egui_input.events.push(egui::Event::PointerMoved(pos));
                            egui_input.events.push(egui::Event::PointerButton {
                                pos,
                                button: egui::PointerButton::Primary,
                                pressed: true,
                                modifiers: egui::Modifiers::NONE,
                            });
                            if y < ui::toolbar::TOOLBAR_HEIGHT_PX {
                                stroke_suppressed = true;
                            } else {
                                stroke_suppressed = false;
                                last_point = Some((x, y));
                                // Open a fresh stroke in the active
                                // doc and seed its points array with
                                // the down sample. The first MOVE
                                // emits the first segment (down →
                                // move-1); subsequent MOVEs pair
                                // (move-N → move-N+1).
                                if let (Some(id), Some(s)) =
                                    (active_note_id.as_ref(), surface_state.as_ref())
                                {
                                    let doc = documents
                                        .entry(id.clone())
                                        .or_insert_with(CanvasDocument::new);
                                    doc.strokes_doc.begin_stroke();
                                    let [px, py] = s.surface_to_page(x, y);
                                    doc.strokes_doc.push_point(px, py);
                                }
                            }
                            dirty = true;
                        }
                        ACTION_MOVE => {
                            egui_input.events.push(egui::Event::PointerMoved(pos));
                            if !stroke_suppressed {
                                if let (Some((px, py)), Some(s), Some(id)) = (
                                    last_point,
                                    surface_state.as_ref(),
                                    active_note_id.as_ref(),
                                ) {
                                    // Page coords for both endpoints
                                    // so stored vertices stay stable
                                    // across rotation / re-attach.
                                    let prev_page = s.surface_to_page(px, py);
                                    let curr_page = s.surface_to_page(x, y);
                                    let doc = documents
                                        .entry(id.clone())
                                        .or_insert_with(CanvasDocument::new);
                                    // Render-side cache: line-list
                                    // pair for the GPU.
                                    doc.segments.push(Vertex {
                                        position: prev_page,
                                    });
                                    doc.segments.push(Vertex {
                                        position: curr_page,
                                    });
                                    // Source-of-truth side: append
                                    // the new point to the in-flight
                                    // stroke's yrs points array.
                                    doc.strokes_doc.push_point(curr_page[0], curr_page[1]);
                                    dirty = true;
                                }
                                last_point = Some((x, y));
                            }
                        }
                        ACTION_UP | ACTION_CANCEL => {
                            egui_input.events.push(egui::Event::PointerButton {
                                pos,
                                button: egui::PointerButton::Primary,
                                pressed: false,
                                modifiers: egui::Modifiers::NONE,
                            });
                            if let Some(id) = active_note_id.as_ref() {
                                if let Some(doc) = documents.get_mut(id) {
                                    doc.strokes_doc.end_stroke();
                                }
                            }
                            last_point = None;
                            stroke_suppressed = false;
                            dirty = true;
                        }
                        _ => {}
                    }
                }
                Msg::Clear => {
                    if let Some(id) = active_note_id.as_ref() {
                        if let Some(doc) = documents.get_mut(id) {
                            doc.strokes_doc.tombstone_all();
                            doc.segments.clear();
                        }
                    }
                    last_point = None;
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
                    // Truncate any in-flight stroke that came from
                    // the previous note's gesture so it can't leak
                    // into the new doc on the next MOVE sample.
                    last_point = None;
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
                let input = std::mem::take(&mut egui_input);
                let (actions, ui_output) = canvas_ui.run(input, s.size_px());
                match pipeline::render_frame(p, s, segs, ui_output) {
                    Ok(()) => {
                        if actions.clear {
                            if let Some(id) = active_note_id.as_ref() {
                                if let Some(doc) = documents.get_mut(id) {
                                    doc.segments.clear();
                                }
                            }
                            last_point = None;
                            // Re-render so the user sees the cleared
                            // canvas immediately.
                            let fresh_segs = active_segments(&active_note_id, &documents);
                            let fresh_input = egui::RawInput::default();
                            let (_, fresh_ui) = canvas_ui.run(fresh_input, s.size_px());
                            let _ = pipeline::render_frame(p, s, fresh_segs, fresh_ui);
                        }
                        if actions.back {
                            if let Err(e) = crate::drawing::jni::ui::call_back() {
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
