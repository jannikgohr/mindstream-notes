//! Shared fixtures for the sync unit tests.

use super::*;

pub(super) fn remote_note(id: &str, parent: Option<&str>, trashed_at: Option<&str>) -> NotePayload {
    NotePayload {
        schema: 2,
        id: id.into(),
        parent_folder_id: parent.map(str::to_string),
        title: "Remote Title".into(),
        position: 0,
        created: Some("2026-05-01T12:00:00Z".into()),
        modified: Some("2026-05-02T12:00:00Z".into()),
        tags: vec![],
        tags_state: vec![],
        trashed_at: trashed_at.map(str::to_string),
        yrs_state: vec![],
        body: String::new(),
        crypto_key: vec![],
        favourite: false,
        note_kind: "markdown".into(),
    }
}

pub(super) fn collab_info(epoch: u64, salt: &[u8]) -> ShareScopeCollabInfo {
    ShareScopeCollabInfo {
        notes_collection_uid: "scope_notes".into(),
        assets_collection_uid: "scope_assets".into(),
        collab_epoch: epoch,
        collab_salt: salt.to_vec(),
    }
}

pub(super) fn remote_folder(id: &str, parent: Option<&str>, name: &str) -> FolderPayload {
    FolderPayload {
        schema: 1,
        id: id.into(),
        parent_folder_id: parent.map(str::to_string),
        name: name.into(),
        position: 0,
        created: Some("2026-04-01T12:00:00Z".into()),
        modified: Some("2026-04-02T12:00:00Z".into()),
    }
}
