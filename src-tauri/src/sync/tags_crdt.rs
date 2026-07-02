//! CRDT-backed tag set for note metadata.
//!
//! Tags are edited through Rust IPC as whole string lists, not directly in JS.
//! We translate each full-list save into Y.Array insert/delete operations so
//! concurrent edits can merge without one side replacing the other's list.

use std::collections::BTreeSet;

use yrs::updates::decoder::Decode;
use yrs::{Array, Doc, ReadTxn, StateVector, Transact, Update};

const TAGS_KEY: &str = "tags";

pub fn init(tags: &[String]) -> Vec<u8> {
    let doc = Doc::new();
    let tags_ref = doc.get_or_insert_array(TAGS_KEY);
    {
        let mut txn = doc.transact_mut();
        for tag in canonical_tags(tags) {
            tags_ref.push_back(&mut txn, tag);
        }
    }
    encode_state(&doc)
}

pub fn apply_full_list(state: &[u8], old_tags: &[String], new_tags: &[String]) -> Vec<u8> {
    let base = if state.is_empty() {
        init(old_tags)
    } else {
        state.to_vec()
    };
    let doc = load(&base);
    let tags_ref = doc.get_or_insert_array(TAGS_KEY);
    let target: BTreeSet<String> = canonical_tags(new_tags).into_iter().collect();
    {
        let mut txn = doc.transact_mut();
        let current_entries = array_entries(&tags_ref, &txn);
        let current: BTreeSet<String> = current_entries.iter().map(|(_, t)| t.clone()).collect();

        let mut remove_indices = Vec::new();
        for (idx, tag) in current_entries {
            if !target.contains(&tag) {
                remove_indices.push(idx);
            }
        }
        for idx in remove_indices.into_iter().rev() {
            tags_ref.remove(&mut txn, idx);
        }

        for tag in target.difference(&current) {
            tags_ref.push_back(&mut txn, tag.clone());
        }
    }
    encode_state(&doc)
}

pub fn merge(local_state: &[u8], remote_state: &[u8]) -> Vec<u8> {
    let doc = load(local_state);
    {
        let mut txn = doc.transact_mut();
        if let Ok(update) = Update::decode_v1(remote_state) {
            let _ = txn.apply_update(update);
        }
    }
    encode_state(&doc)
}

pub fn tags(state: &[u8]) -> Vec<String> {
    let doc = load(state);
    let tags_ref = doc.get_or_insert_array(TAGS_KEY);
    let txn = doc.transact();
    canonical_tags(
        &array_entries(&tags_ref, &txn)
            .into_iter()
            .map(|(_, tag)| tag)
            .collect::<Vec<_>>(),
    )
}

pub fn merge_or_resolve(
    local_state: &[u8],
    local_tags: &[String],
    remote_state: &[u8],
    remote_tags: &[String],
    keep_local_for_legacy_remote: bool,
) -> (Vec<u8>, Vec<String>) {
    match (local_state.is_empty(), remote_state.is_empty()) {
        (false, false) => {
            let merged = merge(local_state, remote_state);
            let tags = tags(&merged);
            (merged, tags)
        }
        (false, true) if keep_local_for_legacy_remote => {
            let tags = tags(local_state);
            (local_state.to_vec(), tags)
        }
        (false, true) => {
            let updated = apply_full_list(local_state, local_tags, remote_tags);
            let tags = tags(&updated);
            (updated, tags)
        }
        (true, false) => {
            let tags = tags(remote_state);
            (remote_state.to_vec(), tags)
        }
        (true, true) => {
            let state = init(if keep_local_for_legacy_remote {
                local_tags
            } else {
                remote_tags
            });
            let tags = tags(&state);
            (state, tags)
        }
    }
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

fn canonical_tags(tags: &[String]) -> Vec<String> {
    tags.iter()
        .map(|tag| tag.trim())
        .filter(|tag| !tag.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(str::to_string)
        .collect()
}

fn array_entries<T: ReadTxn>(tags_ref: &yrs::ArrayRef, txn: &T) -> Vec<(u32, String)> {
    let mut out = Vec::new();
    for idx in 0..tags_ref.len(txn) {
        if let Ok(tag) = tags_ref.get_as::<_, String>(txn, idx) {
            let tag = tag.trim();
            if !tag.is_empty() {
                out.push((idx, tag.to_string()));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(tags: &[&str]) -> Vec<String> {
        tags.iter().map(|tag| tag.to_string()).collect()
    }

    #[test]
    fn full_list_edit_round_trips() {
        let base = init(&s(&["work"]));
        let edited = apply_full_list(&base, &s(&["work"]), &s(&["personal", "urgent"]));
        assert_eq!(tags(&edited), s(&["personal", "urgent"]));
    }

    #[test]
    fn concurrent_adds_survive_merge() {
        let base = init(&s(&["base"]));
        let a = apply_full_list(&base, &s(&["base"]), &s(&["base", "a"]));
        let b = apply_full_list(&base, &s(&["base"]), &s(&["base", "b"]));
        let merged = merge(&a, &b);
        assert_eq!(tags(&merged), s(&["a", "b", "base"]));
    }

    #[test]
    fn concurrent_remove_and_add_converge() {
        let base = init(&s(&["drop", "keep"]));
        let a = apply_full_list(&base, &s(&["drop", "keep"]), &s(&["keep"]));
        let b = apply_full_list(&base, &s(&["drop", "keep"]), &s(&["drop", "keep", "new"]));
        let merged_ab = merge(&a, &b);
        let merged_ba = merge(&b, &a);
        assert_eq!(tags(&merged_ab), tags(&merged_ba));
        assert_eq!(tags(&merged_ab), s(&["keep", "new"]));
    }
}
