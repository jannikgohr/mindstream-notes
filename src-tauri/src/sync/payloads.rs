//! Wire formats for the Etebase items this sync loop reads and writes.
//!
//! Every payload carries our own local `id` so a pulled item correlates
//! back to an existing SQLite row even before its `etebase_uid` has been
//! persisted (e.g. the row was created on another device).

use super::*;

/// What ends up in `Item::content` for a note. We keep our own `id`
/// (the local SQLite UUID) inside the payload so we can correlate
/// pulled items back to existing local rows even if the etebase_uid
/// hasn't been persisted yet (e.g. created on another device).
///
/// Schema versions:
///   * **1** — legacy. `yrs_state` is a `Y.Text "body"` blob (the old
///     Rust-side diff path). No `body` snapshot, no `crypto_key`. Read
///     by `apply_note` for backward compat; never written by this code.
///   * **2** — current. `yrs_state` is a y-prosemirror `XmlFragment`
///     update produced by the live editor. `body` is the rendered
///     markdown snapshot (canonical for fast local reads — Rust doesn't
///     try to render markdown from prosemirror). `crypto_key` is the
///     AES-GCM secret used by the live collab provider.
#[derive(Debug, Serialize, Deserialize)]
pub(super) struct NotePayload {
    pub(super) schema: u32,
    pub(super) id: String,
    pub(super) parent_folder_id: Option<String>,
    pub(super) title: String,
    pub(super) position: i64,
    /// Canonical note creation timestamp. Added after schema 2; older
    /// payloads default to None and fall back to the local row / pull time.
    #[serde(default)]
    pub(super) created: Option<String>,
    /// Canonical note modification timestamp. Added after schema 2; older
    /// payloads default to None and fall back to the local row / pull time.
    #[serde(default)]
    pub(super) modified: Option<String>,
    pub(super) tags: Vec<String>,
    #[serde(default, with = "serde_bytes")]
    pub(super) tags_state: Vec<u8>,
    /// RFC3339; None means not trashed.
    pub(super) trashed_at: Option<String>,
    /// yrs-encoded Doc state — see sync/yrs_doc.rs.
    #[serde(with = "serde_bytes")]
    pub(super) yrs_state: Vec<u8>,
    /// v2: rendered markdown snapshot. Default empty for legacy decode.
    #[serde(default)]
    pub(super) body: String,
    /// v2: 32-byte AES-GCM key for the live collab room. Default empty
    /// for legacy decode; absence means "no live collab for this note".
    #[serde(default, with = "serde_bytes")]
    pub(super) crypto_key: Vec<u8>,
    /// Favourite flag. Added without bumping the schema marker — older
    /// clients see an unknown field (rmp-serde ignores them) and newer
    /// clients reading older payloads get the serde default of `false`.
    #[serde(default)]
    pub(super) favourite: bool,
    /// Editor-kind discriminator: `"markdown"` (Crepe / y-prosemirror) or
    /// `"freeform"` (drawing canvas). Added without bumping `schema` —
    /// rmp-serde-named ignores unknown fields, and older clients reading
    /// newer payloads default to "markdown" (which means they'll try to
    /// render a freeform note in the markdown editor, but won't lose any
    /// data — the yrs_state survives untouched).
    #[serde(default = "crate::notes::default_note_kind")]
    pub(super) note_kind: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct FolderPayload {
    pub(super) schema: u32,
    pub(super) id: String,
    pub(super) parent_folder_id: Option<String>,
    pub(super) name: String,
    pub(super) position: i64,
    #[serde(default)]
    pub(super) created: Option<String>,
    #[serde(default)]
    pub(super) modified: Option<String>,
}

/// Wire format for a drawing-asset Etebase Item.
///
/// `id` is the same client-generated UUID the SQLite row uses and that
/// drawing records can refer to via `mindstream-asset://<id>` — stable across
/// devices. `etebase_uid` doesn't appear here because Etebase already
/// owns it (it's the Item.uid()); we only need it on the local row for
/// dirty-tracking and tombstone routing.
///
/// `owning_note_id` carries the FK back to the note so a fresh device
/// can stitch pulled assets to their drawings. If the note hasn't been
/// pulled yet (small race window between notes-pull and assets-pull),
/// apply_asset skips the row without advancing the stoken — the next
/// sync retries it once the note exists locally.
///
/// `bytes` are the raw file payload. Etebase encrypts the whole item
/// content end-to-end with the collection key, so the relay only sees
/// ciphertext — same E2EE story as notes.
#[derive(Debug, Serialize, Deserialize)]
pub(super) struct AssetPayload {
    pub(super) schema: u32,
    pub(super) id: String,
    pub(super) owning_note_id: String,
    pub(super) mime_type: String,
    #[serde(with = "serde_bytes")]
    pub(super) bytes: Vec<u8>,
    pub(super) size: i64,
    pub(super) created: String,
    pub(super) modified: String,
}

/// Public signing key a writable shared-folder member publishes into the
/// scope's encrypted assets collection. It authorizes live-collab write frames
/// for one collab epoch; rotating the epoch naturally retires old keys.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct CollabWriterKeyPayload {
    pub(super) schema: u32,
    pub(super) share_scope_id: String,
    pub(super) collab_epoch: u64,
    pub(super) public_key_b64: String,
    pub(super) username: Option<String>,
}

/// What ends up in `Item::content` for a signature. `data` is the opaque
/// JSON geometry blob (see signatures/mod.rs); we keep our own `id` inside
/// so pulled items correlate back to local rows. Etebase E2E-encrypts the
/// whole content, same as notes/assets.
#[derive(Debug, Serialize, Deserialize)]
pub(super) struct SignaturePayload {
    pub(super) schema: u32,
    pub(super) id: String,
    pub(super) data: String,
    pub(super) created: String,
    pub(super) modified: String,
}
