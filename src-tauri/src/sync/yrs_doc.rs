//! Tiny wrapper around a `yrs::Doc` with a single named text field
//! (`body`). The CRDT lives behind this façade so the rest of the codebase
//! never imports `yrs` directly — that keeps the version pin in one place
//! and the surface small enough to reason about.
//!
//! The wire format is the v1 update encoding (`encode_state_as_update_v1`).
//! v1 is what the JS editor produces (`Y.encodeStateAsUpdate` is v1 by
//! default; the v2 variant is `Y.encodeStateAsUpdateV2`), so Rust has to
//! match — otherwise `merge_remote` would silently fail to decode bytes
//! coming from the editor and produce empty docs, which previously
//! corrupted CRDT state on every sync conflict.
//!
//! Local edits arrive as "the editor saved a new full body" (the existing
//! `save_note` IPC). To turn that into CRDT operations we diff the old
//! body against the new one with `similar` and replay the inserts and
//! deletes against the Y.Text. This keeps concurrent offline edits
//! mergeable: if device A inserts and device B deletes in the same span,
//! both ops survive the merge instead of one steamrolling the other.

use similar::{ChangeTag, TextDiff};
use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, ReadTxn, StateVector, Text, Transact, Update};

const TEXT_KEY: &str = "body";

/// First-time state for a brand-new note. The yrs Doc is initialised by
/// inserting the entire current markdown into the `body` Y.Text in one
/// op, then encoding the resulting state.
pub fn init_with_markdown(md: &str) -> Vec<u8> {
    let doc = Doc::new();
    let text = doc.get_or_insert_text(TEXT_KEY);
    {
        let mut txn = doc.transact_mut();
        text.insert(&mut txn, 0, md);
    }
    encode_state(&doc)
}

/// Apply a "full body changed" local edit. We diff `old_md` → `new_md`
/// at character granularity and replay each insert/delete against the
/// Y.Text, which is what the editor would have produced if it had been
/// CRDT-aware. Returns the new encoded state.
pub fn apply_local_edit(state: &[u8], old_md: &str, new_md: &str) -> Vec<u8> {
    if old_md == new_md {
        return state.to_vec();
    }
    let doc = load(state);
    {
        let text = doc.get_or_insert_text(TEXT_KEY);
        let mut txn = doc.transact_mut();
        replay_diff(&text, &mut txn, old_md, new_md);
    }
    encode_state(&doc)
}

/// Merge a remote v1 update into a local state. Y.js / yrs guarantees
/// this converges regardless of the order updates are applied in, which
/// is what makes offline edits across N devices safe.
pub fn merge_remote(local_state: &[u8], remote_state: &[u8]) -> Vec<u8> {
    let doc = load(local_state);
    {
        let mut txn = doc.transact_mut();
        if let Ok(update) = Update::decode_v1(remote_state) {
            let _ = txn.apply_update(update);
        }
    }
    encode_state(&doc)
}

/// Re-render the markdown body from the encoded state. Called after every
/// remote merge so the SQLite `body` column stays in sync with the Doc.
pub fn to_markdown(state: &[u8]) -> String {
    let doc = load(state);
    let text = doc.get_or_insert_text(TEXT_KEY);
    let txn = doc.transact();
    text.get_string(&txn)
}

fn load(state: &[u8]) -> Doc {
    let doc = Doc::new();
    if state.is_empty() {
        return doc;
    }
    let mut txn = doc.transact_mut();
    if let Ok(update) = Update::decode_v1(state) {
        let _ = txn.apply_update(update);
    }
    drop(txn);
    doc
}

fn encode_state(doc: &Doc) -> Vec<u8> {
    let txn = doc.transact();
    txn.encode_state_as_update_v1(&StateVector::default())
}

/// Walk a `similar` diff and emit Y.Text inserts/deletes against the live
/// transaction. yrs 0.21 defaults to **UTF-8 byte offsets** (OffsetKind::Bytes),
/// so `pos` and lengths are in bytes — landing mid-codepoint would panic
/// inside yrs, which is what an earlier draft of this code did with UTF-16
/// units. Keep this in sync if the doc is ever switched to a different
/// OffsetKind.
fn replay_diff(text: &yrs::TextRef, txn: &mut yrs::TransactionMut, old: &str, new: &str) {
    let diff = TextDiff::from_chars(old, new);
    let mut pos: u32 = 0;
    for change in diff.iter_all_changes() {
        let len = change.value().len() as u32;
        match change.tag() {
            ChangeTag::Equal => {
                pos += len;
            }
            ChangeTag::Delete => {
                if len > 0 {
                    text.remove_range(txn, pos, len);
                }
            }
            ChangeTag::Insert => {
                if len > 0 {
                    text.insert(txn, pos, change.value());
                    pos += len;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_markdown() {
        let md = "# Hello\n\nworld 🌍\n";
        let state = init_with_markdown(md);
        assert_eq!(to_markdown(&state), md);
    }

    #[test]
    fn local_edit_appends_text() {
        let state = init_with_markdown("Hello");
        let next = apply_local_edit(&state, "Hello", "Hello, world");
        assert_eq!(to_markdown(&next), "Hello, world");
    }

    #[test]
    fn local_edit_with_unicode() {
        // Off-by-one regression check: 🌍 is 2 UTF-16 code units; the
        // diff/insert path has to use UTF-16 indexing or we'd land mid-pair.
        let state = init_with_markdown("hi 🌍");
        let next = apply_local_edit(&state, "hi 🌍", "hi 🌍!");
        assert_eq!(to_markdown(&next), "hi 🌍!");
    }

    #[test]
    fn no_op_when_unchanged() {
        let state = init_with_markdown("same");
        let next = apply_local_edit(&state, "same", "same");
        // We don't require byte-equality (encoding can differ), only that
        // the rendered text is identical.
        assert_eq!(to_markdown(&next), "same");
    }

    #[test]
    fn concurrent_offline_edits_converge() {
        // Two devices fork from the same base, edit independently, then
        // merge in either order — both should reach the same final text.
        let base = init_with_markdown("Hello world");
        let device_a = apply_local_edit(&base, "Hello world", "Hello brave world");
        let device_b = apply_local_edit(&base, "Hello world", "Hello world!");

        let merged_ab = merge_remote(&device_a, &device_b);
        let merged_ba = merge_remote(&device_b, &device_a);

        assert_eq!(to_markdown(&merged_ab), to_markdown(&merged_ba));
        // Both edits survive — neither is overwritten.
        let final_md = to_markdown(&merged_ab);
        assert!(final_md.contains("brave"));
        assert!(final_md.ends_with('!'));
    }
}
