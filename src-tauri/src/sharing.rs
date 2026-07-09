//! Collection sharing command layer.
//!
//! Etebase shares remote Collections, while Mindstream's visible folders are
//! SQLite rows synced as Items inside the single `mindstream.folders`
//! Collection. Incoming invitations can be listed/accepted/rejected today.
//! Outgoing per-folder invites are deliberately guarded until the sync model
//! can represent one remote Collection per shared folder/subtree.

use std::collections::{HashMap, HashSet};

use chrono::Utc;
use etebase::{Account, CollectionAccessLevel, FetchOptions, InvitationPreview, SignedInvitation};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::db::Db;
use crate::error::{AppError, AppResult};

pub const COLLECTION_TYPE_SHARE_MANIFEST: &str = "mindstream.share_manifest";
pub const COLLECTION_TYPE_SHARE_FOLDERS: &str = "mindstream.folders";
pub const COLLECTION_TYPE_SHARE_NOTES: &str = "mindstream.notes";
pub const COLLECTION_TYPE_SHARE_ASSETS: &str = "mindstream.assets";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ShareAccessLevel {
    ReadOnly,
    ReadWrite,
    Admin,
}

impl From<CollectionAccessLevel> for ShareAccessLevel {
    fn from(value: CollectionAccessLevel) -> Self {
        match value {
            CollectionAccessLevel::ReadOnly => Self::ReadOnly,
            CollectionAccessLevel::ReadWrite => Self::ReadWrite,
            CollectionAccessLevel::Admin => Self::Admin,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CollectionInvitation {
    pub id: String,
    pub username: String,
    pub sender_username: Option<String>,
    pub collection_uid: String,
    pub access_level: ShareAccessLevel,
    pub collection_type: Option<String>,
}

impl From<&SignedInvitation> for CollectionInvitation {
    fn from(invitation: &SignedInvitation) -> Self {
        Self {
            id: invitation.uid().to_string(),
            username: invitation.username().to_string(),
            sender_username: invitation.sender_username().map(str::to_string),
            collection_uid: invitation.collection().to_string(),
            access_level: invitation.access_level().into(),
            collection_type: None,
        }
    }
}

impl From<InvitationPreview> for CollectionInvitation {
    fn from(preview: InvitationPreview) -> Self {
        Self {
            id: preview.uid().to_string(),
            username: preview.username().to_string(),
            sender_username: preview.sender_username().map(str::to_string),
            collection_uid: preview.collection_uid().to_string(),
            access_level: preview.access_level().into(),
            collection_type: Some(preview.collection_type().to_string()),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct InviteCollectionInput {
    pub collection_id: String,
    pub username: String,
    pub access_level: ShareAccessLevel,
}

#[derive(Debug, Clone, Serialize)]
pub struct CollectionMember {
    pub username: String,
    pub access_level: ShareAccessLevel,
}

#[derive(Debug, Clone, Serialize)]
pub struct CollectionShareState {
    pub collection_id: String,
    pub share_id: Option<String>,
    pub shared_role: Option<ShareAccessLevel>,
    pub shared_owner: Option<String>,
    pub shared_by_me: bool,
    pub members: Vec<CollectionMember>,
    pub outgoing_invitations: Vec<CollectionInvitation>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ShareScopePart {
    Folders,
    Notes,
    Assets,
}

impl ShareScopePart {
    fn collection_type(self) -> &'static str {
        match self {
            ShareScopePart::Folders => COLLECTION_TYPE_SHARE_FOLDERS,
            ShareScopePart::Notes => COLLECTION_TYPE_SHARE_NOTES,
            ShareScopePart::Assets => COLLECTION_TYPE_SHARE_ASSETS,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShareManifest {
    pub schema: u32,
    pub share_scope_id: String,
    pub name: String,
    pub root_folder_id: String,
    #[serde(default)]
    pub owner_username: Option<String>,
    #[serde(default)]
    pub collections: Vec<ShareManifestCollectionRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShareManifestCollectionRef {
    pub part: ShareScopePart,
    pub collection_uid: String,
    #[serde(default = "default_manifest_collection_required")]
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShareManifestPreview {
    pub invitation_id: String,
    pub manifest_collection_uid: String,
    pub manifest: ShareManifest,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct IncomingShareInvitations {
    pub bundles: Vec<IncomingShareBundle>,
    pub unbundled_invitations: Vec<CollectionInvitation>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct IncomingShareBundle {
    pub manifest_invitation_id: String,
    pub manifest_collection_uid: String,
    pub share_scope_id: String,
    pub name: String,
    pub root_folder_id: String,
    pub owner_username: Option<String>,
    pub sender_username: Option<String>,
    pub access_level: Option<ShareAccessLevel>,
    pub complete: bool,
    pub parts: Vec<IncomingShareBundlePart>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct IncomingShareBundlePart {
    pub part: ShareScopePart,
    pub collection_uid: Option<String>,
    pub expected_collection_type: String,
    pub required: bool,
    pub invitation: Option<CollectionInvitation>,
}

fn default_manifest_collection_required() -> bool {
    true
}

#[tauri::command]
pub async fn list_collection_invitations(
    app: AppHandle,
) -> Result<Vec<CollectionInvitation>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = restore_required(&app)?;
        let manager = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?;
        list_all_incoming(&manager).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("list collection invitations task: {e}"))?
}

#[tauri::command]
pub async fn accept_collection_invitation(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = restore_required(&app)?;
        let manager = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?;
        let invitation = find_incoming_invitation(&manager, &id)?
            .ok_or_else(|| AppError::NotFound(format!("invitation {id}")))?;
        manager
            .accept(&invitation)
            .map_err(|e| AppError::InvalidArg(format!("accept invitation: {e}")))?;

        let db = app.state::<Db>();
        db.with_conn(|conn| record_accepted_share(conn, &invitation))?;
        Ok::<(), AppError>(())
    })
    .await
    .map_err(|e| format!("accept collection invitation task: {e}"))?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn reject_collection_invitation(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = restore_required(&app)?;
        let manager = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?;
        let invitation = find_incoming_invitation(&manager, &id)?
            .ok_or_else(|| AppError::NotFound(format!("invitation {id}")))?;
        manager
            .reject(&invitation)
            .map_err(|e| AppError::InvalidArg(format!("reject invitation: {e}")))?;
        Ok::<(), AppError>(())
    })
    .await
    .map_err(|e| format!("reject collection invitation task: {e}"))?
    .map_err(Into::into)
}

#[tauri::command]
pub fn get_collection_share_state(
    db: tauri::State<'_, Db>,
    collection_id: String,
) -> Result<CollectionShareState, String> {
    db.with_conn(|conn| local_share_state(conn, &collection_id))
        .map_err(Into::into)
}

#[tauri::command]
pub async fn invite_collection(
    app: AppHandle,
    input: InviteCollectionInput,
) -> Result<CollectionShareState, String> {
    let _ = app;
    let _ = (&input.collection_id, &input.username, input.access_level);
    Err("Per-folder Etebase sharing is not available yet. This vault currently syncs folders as items inside one Etebase folders collection, so sending this invite would grant access to more than the selected folder.".into())
}

fn restore_required(app: &AppHandle) -> AppResult<Account> {
    crate::auth::try_restore(app)
        .map_err(|e| AppError::InvalidArg(format!("restore session: {e}")))?
        .ok_or_else(|| AppError::InvalidArg("not signed in".into()))
}

fn list_all_incoming(
    manager: &etebase::managers::CollectionInvitationManager,
) -> AppResult<Vec<CollectionInvitation>> {
    let mut out = Vec::new();
    let mut iterator: Option<String> = None;
    loop {
        let options = FetchOptions::new().limit(100).iterator(iterator.as_deref());
        let page = manager
            .list_incoming(Some(&options))
            .map_err(|e| AppError::InvalidArg(format!("list incoming invitations: {e}")))?;
        out.extend(page.data().iter().map(|invitation| {
            manager
                .preview(invitation)
                .map(CollectionInvitation::from)
                .unwrap_or_else(|_| CollectionInvitation::from(invitation))
        }));
        if page.done() {
            break;
        }
        let Some(next) = page.iterator().map(str::to_string) else {
            break;
        };
        iterator = Some(next);
    }
    Ok(out)
}

pub fn bundle_incoming_share_invitations(
    invitations: Vec<CollectionInvitation>,
    manifests: Vec<ShareManifestPreview>,
) -> IncomingShareInvitations {
    let invitation_by_id: HashMap<&str, &CollectionInvitation> = invitations
        .iter()
        .map(|invitation| (invitation.id.as_str(), invitation))
        .collect();
    let invitation_by_collection_uid: HashMap<&str, &CollectionInvitation> = invitations
        .iter()
        .map(|invitation| (invitation.collection_uid.as_str(), invitation))
        .collect();

    let manifest_invitation_ids: HashSet<String> = manifests
        .iter()
        .map(|preview| preview.invitation_id.clone())
        .collect();
    let referenced_collection_uids: HashSet<String> = manifests
        .iter()
        .flat_map(|preview| {
            preview
                .manifest
                .collections
                .iter()
                .map(|collection| collection.collection_uid.clone())
        })
        .collect();

    let bundles = manifests
        .into_iter()
        .map(|preview| {
            let manifest_invitation = invitation_by_id.get(preview.invitation_id.as_str());
            build_incoming_share_bundle(
                preview,
                manifest_invitation.copied(),
                &invitation_by_collection_uid,
            )
        })
        .collect();

    let unbundled_invitations = invitations
        .iter()
        .filter(|invitation| !manifest_invitation_ids.contains(invitation.id.as_str()))
        .filter(|invitation| {
            !referenced_collection_uids.contains(invitation.collection_uid.as_str())
        })
        .filter(|invitation| {
            invitation.collection_type.as_deref() != Some(COLLECTION_TYPE_SHARE_MANIFEST)
        })
        .cloned()
        .collect();

    IncomingShareInvitations {
        bundles,
        unbundled_invitations,
    }
}

fn build_incoming_share_bundle(
    preview: ShareManifestPreview,
    manifest_invitation: Option<&CollectionInvitation>,
    invitation_by_collection_uid: &HashMap<&str, &CollectionInvitation>,
) -> IncomingShareBundle {
    let manifest = preview.manifest;
    let refs_by_part: HashMap<ShareScopePart, &ShareManifestCollectionRef> = manifest
        .collections
        .iter()
        .map(|collection| (collection.part, collection))
        .collect();
    let mut complete = true;
    let mut warnings = Vec::new();
    let mut parts = Vec::new();

    for part in [
        ShareScopePart::Folders,
        ShareScopePart::Notes,
        ShareScopePart::Assets,
    ] {
        let expected_collection_type = part.collection_type().to_string();
        let collection_ref = refs_by_part.get(&part).copied();
        if collection_ref.is_none() {
            complete = false;
            warnings.push(format!("manifest is missing required {part:?} collection"));
        }

        let invitation = collection_ref
            .and_then(|collection| {
                invitation_by_collection_uid.get(collection.collection_uid.as_str())
            })
            .copied()
            .cloned();

        if collection_ref.is_some() && invitation.is_none() {
            complete = false;
            warnings.push(format!(
                "missing invitation for required {part:?} collection"
            ));
        }

        if let Some(invitation) = invitation.as_ref() {
            if let Some(collection_type) = invitation.collection_type.as_deref() {
                if collection_type != expected_collection_type {
                    complete = false;
                    warnings.push(format!(
                        "{part:?} invitation has collection type {collection_type}"
                    ));
                }
            } else {
                warnings.push(format!("{part:?} invitation collection type is unknown"));
            }
        }

        parts.push(IncomingShareBundlePart {
            part,
            collection_uid: collection_ref.map(|collection| collection.collection_uid.clone()),
            expected_collection_type,
            required: collection_ref
                .map(|collection| collection.required)
                .unwrap_or(true),
            invitation,
        });
    }

    IncomingShareBundle {
        manifest_invitation_id: preview.invitation_id,
        manifest_collection_uid: preview.manifest_collection_uid,
        share_scope_id: manifest.share_scope_id,
        name: manifest.name,
        root_folder_id: manifest.root_folder_id,
        owner_username: manifest.owner_username,
        sender_username: manifest_invitation
            .and_then(|invitation| invitation.sender_username.clone()),
        access_level: manifest_invitation.map(|invitation| invitation.access_level),
        complete,
        parts,
        warnings,
    }
}

fn find_incoming_invitation(
    manager: &etebase::managers::CollectionInvitationManager,
    id: &str,
) -> AppResult<Option<SignedInvitation>> {
    let mut iterator: Option<String> = None;
    loop {
        let options = FetchOptions::new().limit(100).iterator(iterator.as_deref());
        let page = manager
            .list_incoming(Some(&options))
            .map_err(|e| AppError::InvalidArg(format!("list incoming invitations: {e}")))?;
        if let Some(invitation) = page.data().iter().find(|invitation| invitation.uid() == id) {
            return Ok(Some(invitation.clone()));
        }
        if page.done() {
            return Ok(None);
        }
        let Some(next) = page.iterator().map(str::to_string) else {
            return Ok(None);
        };
        iterator = Some(next);
    }
}

fn record_accepted_share(conn: &Connection, invitation: &SignedInvitation) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    let role = share_access_level_to_db(invitation.access_level().into());
    let owner = invitation.sender_username();
    let changed = conn.execute(
        "UPDATE collections
            SET shared_role = ?1,
                shared_owner = ?2,
                shared_by_me = 0,
                modified = ?3
          WHERE share_id = ?4",
        params![role, owner, now, invitation.collection()],
    )?;
    if changed > 0 {
        return Ok(());
    }

    let position = conn
        .query_row(
            "SELECT MAX(position) FROM collections WHERE parent_collection_id IS NULL",
            [],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()?
        .flatten()
        .unwrap_or(-1)
        + 1;
    let id = format!("coll_{}", uuid::Uuid::new_v4());
    let name = owner
        .map(|sender| format!("{sender}'s shared collection"))
        .unwrap_or_else(|| "Shared collection".to_string());
    conn.execute(
        "INSERT INTO collections(
            id, parent_collection_id, name, position, created, modified,
            dirty, share_id, shared_role, shared_owner, shared_by_me
         )
         VALUES (?1, NULL, ?2, ?3, ?4, ?4, 0, ?5, ?6, ?7, 0)",
        params![
            id,
            name,
            position,
            now,
            invitation.collection(),
            role,
            owner,
        ],
    )?;
    Ok(())
}

fn local_share_state(conn: &Connection, collection_id: &str) -> AppResult<CollectionShareState> {
    conn.query_row(
        "SELECT id, share_id, shared_role, shared_owner, shared_by_me
           FROM collections
          WHERE id = ?1",
        params![collection_id],
        |row| {
            let role: Option<String> = row.get(2)?;
            Ok(CollectionShareState {
                collection_id: row.get(0)?,
                share_id: row.get(1)?,
                shared_role: role.as_deref().and_then(share_access_level_from_db),
                shared_owner: row.get(3)?,
                shared_by_me: row.get::<_, i64>(4)? != 0,
                members: Vec::new(),
                outgoing_invitations: Vec::new(),
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("collection {collection_id}")))
}

fn share_access_level_to_db(value: ShareAccessLevel) -> &'static str {
    match value {
        ShareAccessLevel::ReadOnly => "read_only",
        ShareAccessLevel::ReadWrite => "read_write",
        ShareAccessLevel::Admin => "admin",
    }
}

fn share_access_level_from_db(value: &str) -> Option<ShareAccessLevel> {
    match value {
        "read_only" => Some(ShareAccessLevel::ReadOnly),
        "read_write" => Some(ShareAccessLevel::ReadWrite),
        "admin" => Some(ShareAccessLevel::Admin),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn invitation(id: &str, collection_uid: &str, collection_type: &str) -> CollectionInvitation {
        CollectionInvitation {
            id: id.to_string(),
            username: "recipient".into(),
            sender_username: Some("sender".into()),
            collection_uid: collection_uid.to_string(),
            access_level: ShareAccessLevel::ReadWrite,
            collection_type: Some(collection_type.to_string()),
        }
    }

    fn manifest_preview(collections: Vec<ShareManifestCollectionRef>) -> ShareManifestPreview {
        ShareManifestPreview {
            invitation_id: "invite_manifest".into(),
            manifest_collection_uid: "col_manifest".into(),
            manifest: ShareManifest {
                schema: 1,
                share_scope_id: "scope_root".into(),
                name: "Shared project".into(),
                root_folder_id: "folder_root".into(),
                owner_username: Some("sender".into()),
                collections,
            },
        }
    }

    fn collection_ref(part: ShareScopePart, collection_uid: &str) -> ShareManifestCollectionRef {
        ShareManifestCollectionRef {
            part,
            collection_uid: collection_uid.to_string(),
            required: true,
        }
    }

    #[test]
    fn manifest_bundle_hides_referenced_invites_and_requires_assets() {
        let invitations = vec![
            invitation(
                "invite_manifest",
                "col_manifest",
                COLLECTION_TYPE_SHARE_MANIFEST,
            ),
            invitation(
                "invite_folders",
                "col_folders",
                COLLECTION_TYPE_SHARE_FOLDERS,
            ),
            invitation("invite_notes", "col_notes", COLLECTION_TYPE_SHARE_NOTES),
            invitation("invite_assets", "col_assets", COLLECTION_TYPE_SHARE_ASSETS),
        ];
        let manifests = vec![manifest_preview(vec![
            collection_ref(ShareScopePart::Folders, "col_folders"),
            collection_ref(ShareScopePart::Notes, "col_notes"),
            collection_ref(ShareScopePart::Assets, "col_assets"),
        ])];

        let result = bundle_incoming_share_invitations(invitations, manifests);

        assert!(result.unbundled_invitations.is_empty());
        assert_eq!(result.bundles.len(), 1);
        let bundle = &result.bundles[0];
        assert!(bundle.complete, "{:?}", bundle.warnings);
        assert_eq!(bundle.share_scope_id, "scope_root");
        assert_eq!(bundle.sender_username.as_deref(), Some("sender"));
        assert_eq!(bundle.parts.len(), 3);
        assert!(bundle.parts.iter().any(|part| {
            part.part == ShareScopePart::Assets
                && part.required
                && part.invitation.as_ref().map(|invite| invite.id.as_str())
                    == Some("invite_assets")
        }));
    }

    #[test]
    fn manifest_without_assets_scope_is_incomplete() {
        let invitations = vec![
            invitation(
                "invite_manifest",
                "col_manifest",
                COLLECTION_TYPE_SHARE_MANIFEST,
            ),
            invitation(
                "invite_folders",
                "col_folders",
                COLLECTION_TYPE_SHARE_FOLDERS,
            ),
            invitation("invite_notes", "col_notes", COLLECTION_TYPE_SHARE_NOTES),
        ];
        let manifests = vec![manifest_preview(vec![
            collection_ref(ShareScopePart::Folders, "col_folders"),
            collection_ref(ShareScopePart::Notes, "col_notes"),
        ])];

        let result = bundle_incoming_share_invitations(invitations, manifests);
        let bundle = &result.bundles[0];

        assert!(!bundle.complete);
        assert!(bundle
            .warnings
            .iter()
            .any(|warning| warning.contains("Assets")));
        assert!(bundle.parts.iter().any(|part| {
            part.part == ShareScopePart::Assets
                && part.required
                && part.collection_uid.is_none()
                && part.invitation.is_none()
        }));
    }

    #[test]
    fn unreferenced_collection_invites_stay_user_facing() {
        let standalone = invitation("invite_other", "col_other", "custom.collection");
        let invitations = vec![
            invitation(
                "invite_manifest",
                "col_manifest",
                COLLECTION_TYPE_SHARE_MANIFEST,
            ),
            invitation(
                "invite_folders",
                "col_folders",
                COLLECTION_TYPE_SHARE_FOLDERS,
            ),
            invitation("invite_notes", "col_notes", COLLECTION_TYPE_SHARE_NOTES),
            invitation("invite_assets", "col_assets", COLLECTION_TYPE_SHARE_ASSETS),
            standalone.clone(),
        ];
        let manifests = vec![manifest_preview(vec![
            collection_ref(ShareScopePart::Folders, "col_folders"),
            collection_ref(ShareScopePart::Notes, "col_notes"),
            collection_ref(ShareScopePart::Assets, "col_assets"),
        ])];

        let result = bundle_incoming_share_invitations(invitations, manifests);

        assert_eq!(result.unbundled_invitations, vec![standalone]);
    }
}
