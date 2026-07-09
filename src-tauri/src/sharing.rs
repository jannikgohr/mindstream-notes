//! Collection sharing command layer.
//!
//! Etebase shares remote Collections. A shared folder scope is one manifest
//! collection (`mindstream.share_manifest`, whose content is the manifest JSON)
//! plus three required part collections — `mindstream.folders`,
//! `mindstream.notes`, `mindstream.assets`. Incoming invitations are grouped
//! into manifest-backed bundles (list/accept/decline); `invite_collection`
//! creates the scope collections + manifest and invites the recipient.
//!
//! Sharing a folder re-homes its subtree into the scope's collections: every
//! folder/note/asset under the root is stamped with `share_scope_id` and
//! detached from the vault-wide collections (see `migrate_subtree_into_scope`),
//! and `sync::scopes` then pushes/pulls each scope's dedicated collections so a
//! recipient receives the real content. Known gap: a note created or moved into
//! a shared folder *after* the share exists isn't stamped until the next
//! `invite_collection` re-runs the migration — scope inheritance on create/move
//! is a follow-up.

use std::collections::{HashMap, HashSet};

use chrono::Utc;
use etebase::managers::{CollectionInvitationManager, CollectionManager};
use etebase::{
    Account, Collection, CollectionAccessLevel, FetchOptions, InvitationPreview, ItemMetadata,
    SignedInvitation,
};
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

impl From<ShareAccessLevel> for CollectionAccessLevel {
    fn from(value: ShareAccessLevel) -> Self {
        match value {
            ShareAccessLevel::ReadOnly => Self::ReadOnly,
            ShareAccessLevel::ReadWrite => Self::ReadWrite,
            ShareAccessLevel::Admin => Self::Admin,
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

/// List incoming share invitations grouped into manifest-backed bundles.
///
/// Under the "auto-accept manifest only" policy this transparently accepts
/// every pending `mindstream.share_manifest` invitation so its manifest can be
/// decoded, then returns one bundle per share scope (folders + notes + assets)
/// plus any invitations that aren't part of a manifest scope. Accepting a
/// manifest grants access only to that metadata-only collection; the folder /
/// notes / asset collections it references stay pending until the user accepts
/// the bundle.
#[tauri::command]
pub async fn list_incoming_share_bundles(
    app: AppHandle,
) -> Result<IncomingShareInvitations, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = restore_required(&app)?;
        let inv_manager = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?;
        let cm = account
            .collection_manager()
            .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;
        let me = crate::auth::read_session_info(&app)?.map(|info| info.username);
        let invitations = list_all_incoming(&inv_manager)?;
        let manifests = collect_share_manifests(&inv_manager, &cm, &invitations, me.as_deref())?;
        Ok::<_, AppError>(bundle_incoming_share_invitations(invitations, manifests))
    })
    .await
    .map_err(|e| format!("list incoming share bundles task: {e}"))?
    .map_err(Into::into)
}

/// Accept a whole share bundle: accept every referenced folders/notes/assets
/// invitation that's still pending and project the shared root locally.
///
/// The bundle is re-derived server-side from `manifest_collection_uid` rather
/// than trusting client-passed invitation ids, so a stale UI can't accept
/// invitations the manifest doesn't actually reference. Etebase has no
/// cross-collection transaction, so this is best-effort ordered: a failure on
/// one part surfaces as an error, but parts accepted before it stay accepted
/// (re-running the accept is idempotent — already-accepted parts are skipped).
#[tauri::command]
pub async fn accept_share_bundle(
    app: AppHandle,
    manifest_collection_uid: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = restore_required(&app)?;
        let inv_manager = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?;
        let cm = account
            .collection_manager()
            .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;
        let me = crate::auth::read_session_info(&app)?.map(|info| info.username);
        let invitations = list_all_incoming(&inv_manager)?;
        let manifests = collect_share_manifests(&inv_manager, &cm, &invitations, me.as_deref())?;
        let preview = manifests
            .iter()
            .find(|m| m.manifest_collection_uid == manifest_collection_uid)
            .ok_or_else(|| AppError::NotFound(format!("share bundle {manifest_collection_uid}")))?;

        let invitation_by_collection: HashMap<&str, &CollectionInvitation> = invitations
            .iter()
            .map(|invitation| (invitation.collection_uid.as_str(), invitation))
            .collect();

        for collection_ref in &preview.manifest.collections {
            let Some(part_invitation) =
                invitation_by_collection.get(collection_ref.collection_uid.as_str())
            else {
                // Already accepted (gone from the incoming list) — nothing to do.
                continue;
            };
            let Some(signed) = find_incoming_invitation(&inv_manager, &part_invitation.id)? else {
                continue;
            };
            inv_manager.accept(&signed).map_err(|e| {
                AppError::InvalidArg(format!("accept {:?} invitation: {e}", collection_ref.part))
            })?;
        }

        // No local placeholder: the scoped sync pulls the real shared subtree
        // (the sender's own folder/note ids, stamped with this scope) into the
        // tree on the next sync, and the orphan-reparent pass lands the shared
        // root at the tree root. Creating a placeholder here would collide with
        // that real root once it arrives.

        Ok::<(), AppError>(())
    })
    .await
    .map_err(|e| format!("accept share bundle task: {e}"))?
    .map_err(Into::into)
}

/// Decline a share bundle: reject every still-pending referenced invitation and
/// leave the auto-accepted manifest collection so the transparent accept is
/// fully undone and the bundle stops reappearing on the next scan.
#[tauri::command]
pub async fn decline_share_bundle(
    app: AppHandle,
    manifest_collection_uid: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account = restore_required(&app)?;
        let inv_manager = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?;
        let cm = account
            .collection_manager()
            .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;

        // Read the manifest straight from its (already-accepted) collection so
        // decline has no accept side effect. If it isn't fetchable the manifest
        // invitation may still be pending — reject that and stop.
        let col = match cm.fetch(&manifest_collection_uid, None) {
            Ok(col) if !col.is_deleted() => col,
            other => {
                if let Err(e) = other {
                    log::warn!(
                        "[sharing] fetch manifest {manifest_collection_uid} to decline: {e}"
                    );
                }
                let invitations = list_all_incoming(&inv_manager)?;
                if let Some(pending_manifest) = invitations.iter().find(|invitation| {
                    invitation.collection_uid == manifest_collection_uid
                        && invitation.collection_type.as_deref()
                            == Some(COLLECTION_TYPE_SHARE_MANIFEST)
                }) {
                    if let Some(signed) =
                        find_incoming_invitation(&inv_manager, &pending_manifest.id)?
                    {
                        inv_manager.reject(&signed).map_err(|e| {
                            AppError::InvalidArg(format!("reject manifest invitation: {e}"))
                        })?;
                    }
                }
                return Ok(());
            }
        };
        let manifest = decode_manifest(&col)?;

        let invitations = list_all_incoming(&inv_manager)?;
        let invitation_by_collection: HashMap<&str, &CollectionInvitation> = invitations
            .iter()
            .map(|invitation| (invitation.collection_uid.as_str(), invitation))
            .collect();

        for collection_ref in &manifest.collections {
            let Some(part_invitation) =
                invitation_by_collection.get(collection_ref.collection_uid.as_str())
            else {
                continue;
            };
            if let Some(signed) = find_incoming_invitation(&inv_manager, &part_invitation.id)? {
                inv_manager.reject(&signed).map_err(|e| {
                    AppError::InvalidArg(format!(
                        "reject {:?} invitation: {e}",
                        collection_ref.part
                    ))
                })?;
            }
        }

        // Leave the manifest collection last; a failure here is non-fatal (the
        // part invitations are already rejected) but is worth surfacing in logs.
        let member_manager = cm
            .member_manager(&col)
            .map_err(|e| AppError::InvalidArg(format!("member_manager: {e}")))?;
        if let Err(e) = member_manager.leave() {
            log::warn!("[sharing] leave manifest collection {manifest_collection_uid}: {e}");
        }

        Ok::<(), AppError>(())
    })
    .await
    .map_err(|e| format!("decline share bundle task: {e}"))?
    .map_err(Into::into)
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
        let role: ShareAccessLevel = invitation.access_level().into();
        let owner = invitation.sender_username();
        db.with_conn(|conn| {
            record_accepted_share(conn, invitation.collection(), role, owner, None)
        })?;
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
    tauri::async_runtime::spawn_blocking(move || {
        let InviteCollectionInput {
            collection_id,
            username,
            access_level,
        } = input;

        // Validate the target folder locally first — cheap, and avoids creating
        // remote collections for a bogus or un-shareable id.
        let db = app.state::<Db>();
        let folder = db.with_conn(|conn| crate::collections::get(conn, &collection_id))?;
        if collection_id == crate::collections::TRASH_ID {
            return Err(AppError::InvalidArg(
                "the trash collection cannot be shared".into(),
            ));
        }

        let account = restore_required(&app)?;
        let owner_username = crate::auth::read_session_info(&app)?.map(|info| info.username);

        // Block self-invite before touching the network — Etebase would let you
        // invite yourself, producing a bundle you can't meaningfully accept.
        let recipient = username.trim();
        if recipient.is_empty() {
            return Err(AppError::InvalidArg(
                "a recipient username is required".into(),
            ));
        }
        if owner_username
            .as_deref()
            .is_some_and(|me| me.eq_ignore_ascii_case(recipient))
        {
            return Err(AppError::InvalidArg(
                "you can't share a folder with yourself".into(),
            ));
        }

        // Read the folder's existing scope tag separately (it isn't on the
        // public Collection struct) so a re-share reuses that scope.
        let existing_scope_id: Option<String> = db.with_conn(|conn| {
            Ok(conn
                .query_row(
                    "SELECT share_scope_id FROM collections WHERE id = ?1",
                    params![collection_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten())
        })?;

        let inv_manager = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?;
        let cm = account
            .collection_manager()
            .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;

        // Resolve the recipient's public key up front so an unknown username
        // fails before any collections are created.
        let profile = inv_manager
            .fetch_user_profile(recipient)
            .map_err(|e| profile_lookup_error(recipient, e))?;
        let pubkey = profile.pubkey().to_vec();

        // Reuse the folder's scope if it already has one so re-sharing adds a
        // member rather than spawning a duplicate scope; otherwise create it.
        let (scope, created) = resolve_or_create_scope(
            &cm,
            &folder,
            existing_scope_id.as_deref(),
            owner_username.as_deref(),
        )?;

        // Refuse a duplicate: the recipient already has a pending invite to, or
        // membership in, this scope.
        if recipient_already_on_scope(&inv_manager, &cm, &scope, recipient)? {
            return Err(AppError::InvalidArg(format!(
                "{recipient} has already been invited to this folder"
            )));
        }

        // Invite the recipient: part collections at the requested level, the
        // manifest read-only (recipients read it, they don't edit it).
        let level: CollectionAccessLevel = access_level.into();
        invite_to_collection(
            &inv_manager,
            &scope.manifest,
            recipient,
            &pubkey,
            CollectionAccessLevel::ReadOnly,
        )?;
        invite_to_collection(&inv_manager, &scope.folders, recipient, &pubkey, level)?;
        invite_to_collection(&inv_manager, &scope.notes, recipient, &pubkey, level)?;
        invite_to_collection(&inv_manager, &scope.assets, recipient, &pubkey, level)?;

        // Route the shared subtree into the scope's collections: stamp every
        // folder/note/asset under the root with the scope id and detach it from
        // the vault-wide collections (tombstone the old vault item, clear the
        // uid, mark dirty) so the next sync re-homes it. Run on every invite so
        // content added since the first share is picked up when someone new is
        // added. On the very first share also record the shared-by-me root.
        let folders_uid = scope.folders.uid().to_string();
        let scope_id = scope.share_scope_id.clone();
        db.with_conn(|conn| {
            migrate_subtree_into_scope(conn, &collection_id, &scope_id)?;
            if created {
                record_outgoing_share(
                    conn,
                    &collection_id,
                    &scope_id,
                    &folders_uid,
                    access_level,
                    owner_username.as_deref(),
                )?;
            }
            Ok::<(), AppError>(())
        })?;

        db.with_conn(|conn| local_share_state(conn, &collection_id))
    })
    .await
    .map_err(|e| format!("invite collection task: {e}"))?
    .map_err(Into::into)
}

/// The four collections that make up one share scope.
struct ScopeCollections {
    manifest: Collection,
    folders: Collection,
    notes: Collection,
    assets: Collection,
    share_scope_id: String,
}

/// Reuse the folder's existing scope (so re-sharing adds a member) or create a
/// fresh one. The `bool` is `true` when a new scope was created.
fn resolve_or_create_scope(
    cm: &CollectionManager,
    folder: &crate::collections::Collection,
    existing_scope_id: Option<&str>,
    owner_username: Option<&str>,
) -> AppResult<(ScopeCollections, bool)> {
    if let Some(scope_id) = existing_scope_id {
        if let Some(scope) = find_existing_scope(cm, scope_id)? {
            return Ok((scope, false));
        }
        log::warn!(
            "[sharing] folder {} tagged scope {scope_id} but its manifest is gone; creating a fresh scope",
            folder.id
        );
    }
    Ok((create_new_scope(cm, folder, owner_username)?, true))
}

/// Find the scope whose manifest carries `share_scope_id` and fetch its four
/// collections. Returns `None` if no manifest matches (e.g. deleted server-side).
fn find_existing_scope(
    cm: &CollectionManager,
    share_scope_id: &str,
) -> AppResult<Option<ScopeCollections>> {
    let list = cm
        .list(COLLECTION_TYPE_SHARE_MANIFEST, None)
        .map_err(|e| AppError::InvalidArg(format!("list manifest collections: {e}")))?;
    for col in list.data() {
        if col.is_deleted() {
            continue;
        }
        let manifest = match decode_manifest(col) {
            Ok(manifest) => manifest,
            Err(_) => continue,
        };
        if manifest.share_scope_id != share_scope_id {
            continue;
        }
        let folders = fetch_scope_part(cm, &manifest, ShareScopePart::Folders)?;
        let notes = fetch_scope_part(cm, &manifest, ShareScopePart::Notes)?;
        let assets = fetch_scope_part(cm, &manifest, ShareScopePart::Assets)?;
        return Ok(Some(ScopeCollections {
            manifest: col.clone(),
            folders,
            notes,
            assets,
            share_scope_id: manifest.share_scope_id,
        }));
    }
    Ok(None)
}

fn fetch_scope_part(
    cm: &CollectionManager,
    manifest: &ShareManifest,
    part: ShareScopePart,
) -> AppResult<Collection> {
    let uid = manifest
        .collections
        .iter()
        .find(|collection| collection.part == part)
        .map(|collection| collection.collection_uid.as_str())
        .ok_or_else(|| AppError::InvalidArg(format!("manifest missing {part:?} collection")))?;
    cm.fetch(uid, None)
        .map_err(|e| AppError::InvalidArg(format!("fetch {part:?} collection: {e}")))
}

/// Create + upload the three part collections and the manifest collection that
/// ties them together.
fn create_new_scope(
    cm: &CollectionManager,
    folder: &crate::collections::Collection,
    owner_username: Option<&str>,
) -> AppResult<ScopeCollections> {
    let share_scope_id = format!("scope_{}", uuid::Uuid::new_v4());
    let folders = create_share_collection(
        cm,
        COLLECTION_TYPE_SHARE_FOLDERS,
        &format!("{} — folders", folder.name),
        &[],
    )?;
    let notes = create_share_collection(
        cm,
        COLLECTION_TYPE_SHARE_NOTES,
        &format!("{} — notes", folder.name),
        &[],
    )?;
    let assets = create_share_collection(
        cm,
        COLLECTION_TYPE_SHARE_ASSETS,
        &format!("{} — assets", folder.name),
        &[],
    )?;
    let manifest = build_share_manifest(
        &share_scope_id,
        &folder.name,
        &folder.id,
        owner_username,
        folders.uid(),
        notes.uid(),
        assets.uid(),
    );
    let manifest_json = serde_json::to_vec(&manifest)
        .map_err(|e| AppError::InvalidArg(format!("encode manifest: {e}")))?;
    let manifest_col = create_share_collection(
        cm,
        COLLECTION_TYPE_SHARE_MANIFEST,
        &format!("{} — share", folder.name),
        &manifest_json,
    )?;
    Ok(ScopeCollections {
        manifest: manifest_col,
        folders,
        notes,
        assets,
        share_scope_id,
    })
}

/// True if `username` already has a pending invite to, or is a member of, this
/// scope — checked against the scope's collections so it never blocks an invite
/// to the same user for a *different* folder.
fn recipient_already_on_scope(
    inv_manager: &CollectionInvitationManager,
    cm: &CollectionManager,
    scope: &ScopeCollections,
    username: &str,
) -> AppResult<bool> {
    let scope_uids = [
        scope.manifest.uid(),
        scope.folders.uid(),
        scope.notes.uid(),
        scope.assets.uid(),
    ];

    let mut iterator: Option<String> = None;
    loop {
        let options = FetchOptions::new().limit(100).iterator(iterator.as_deref());
        let page = inv_manager
            .list_outgoing(Some(&options))
            .map_err(|e| AppError::InvalidArg(format!("list outgoing invitations: {e}")))?;
        for invitation in page.data() {
            if invitation.username() == username && scope_uids.contains(&invitation.collection()) {
                return Ok(true);
            }
        }
        if page.done() {
            break;
        }
        match page.iterator().map(str::to_string) {
            Some(next) => iterator = Some(next),
            None => break,
        }
    }

    // Already-accepted members share the same three part collections; the
    // folders collection is enough to detect them.
    let member_manager = cm
        .member_manager(&scope.folders)
        .map_err(|e| AppError::InvalidArg(format!("member_manager: {e}")))?;
    let mut iterator: Option<String> = None;
    loop {
        let options = FetchOptions::new().limit(100).iterator(iterator.as_deref());
        let page = member_manager
            .list(Some(&options))
            .map_err(|e| AppError::InvalidArg(format!("list members: {e}")))?;
        for member in page.data() {
            if member.username() == username {
                return Ok(true);
            }
        }
        if page.done() {
            break;
        }
        match page.iterator().map(str::to_string) {
            Some(next) => iterator = Some(next),
            None => break,
        }
    }

    Ok(false)
}

/// Turn Etebase's opaque profile-lookup failure into an actionable message. A
/// brand-new account has no published `UserInfo` until it has signed in once.
fn profile_lookup_error(username: &str, err: impl std::fmt::Display) -> AppError {
    let raw = err.to_string();
    if raw.contains("matching query does not exist") {
        AppError::InvalidArg(format!(
            "No user named “{username}” was found. Check the spelling — a brand-new account must sign in once before it can be invited."
        ))
    } else {
        AppError::InvalidArg(format!("fetch recipient profile: {raw}"))
    }
}

/// Create + upload one collection for a share scope. `content` is empty for the
/// part collections and the manifest JSON for the manifest collection.
fn create_share_collection(
    cm: &CollectionManager,
    collection_type: &str,
    name: &str,
    content: &[u8],
) -> AppResult<Collection> {
    let mut meta = ItemMetadata::new();
    meta.set_name(Some(name))
        .set_mtime(Some(Utc::now().timestamp_millis()));
    let col = cm
        .create(collection_type, &meta, content)
        .map_err(|e| AppError::InvalidArg(format!("create {collection_type}: {e}")))?;
    cm.upload(&col, None)
        .map_err(|e| AppError::InvalidArg(format!("upload {collection_type}: {e}")))?;
    Ok(col)
}

fn invite_to_collection(
    inv_manager: &CollectionInvitationManager,
    collection: &Collection,
    username: &str,
    pubkey: &[u8],
    access_level: CollectionAccessLevel,
) -> AppResult<()> {
    inv_manager
        .invite(collection, username, pubkey, access_level)
        .map_err(|e| {
            AppError::InvalidArg(format!("invite {username} to {}: {e}", collection.uid()))
        })
}

/// Build the manifest that ties a scope's three part collections together. Pure
/// so it can be unit-tested without a server.
fn build_share_manifest(
    share_scope_id: &str,
    name: &str,
    root_folder_id: &str,
    owner_username: Option<&str>,
    folders_uid: &str,
    notes_uid: &str,
    assets_uid: &str,
) -> ShareManifest {
    ShareManifest {
        schema: 1,
        share_scope_id: share_scope_id.to_string(),
        name: name.to_string(),
        root_folder_id: root_folder_id.to_string(),
        owner_username: owner_username.map(str::to_string),
        collections: vec![
            ShareManifestCollectionRef {
                part: ShareScopePart::Folders,
                collection_uid: folders_uid.to_string(),
                required: true,
            },
            ShareManifestCollectionRef {
                part: ShareScopePart::Notes,
                collection_uid: notes_uid.to_string(),
                required: true,
            },
            ShareManifestCollectionRef {
                part: ShareScopePart::Assets,
                collection_uid: assets_uid.to_string(),
                required: true,
            },
        ],
    }
}

/// Stamp the local root folder as shared-by-me and anchor the scope on it.
fn record_outgoing_share(
    conn: &Connection,
    collection_id: &str,
    share_scope_id: &str,
    folders_uid: &str,
    role: ShareAccessLevel,
    owner: Option<&str>,
) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    let role_db = share_access_level_to_db(role);
    conn.execute(
        "UPDATE collections
            SET share_scope_id = ?1,
                share_id = ?2,
                shared_role = ?3,
                shared_owner = ?4,
                shared_by_me = 1,
                modified = ?5
          WHERE id = ?6",
        params![
            share_scope_id,
            folders_uid,
            role_db,
            owner,
            now,
            collection_id
        ],
    )?;
    Ok(())
}

/// Re-home a shared folder subtree into its scope collections.
///
/// For every folder under `root_folder_id` (inclusive) and every note/asset
/// beneath them: queue a vault-side delete for anything already pushed (done
/// first, while `share_scope_id` is still NULL so `queue_tombstone` routes it
/// to the vault collection), then stamp the scope, clear `etebase_uid`, and
/// mark dirty so the next sync creates it fresh in the scope collection. This
/// is the "one home" migration — a scoped row lives only in its scope
/// collection. Idempotent: rows already re-homed have no `etebase_uid` and so
/// queue no tombstone.
///
/// Known gap: a note created or moved into the folder *after* a share exists
/// isn't stamped until the next `invite_collection` call re-runs this. Inheriting
/// the scope on create/move is a follow-up.
fn migrate_subtree_into_scope(
    conn: &Connection,
    root_folder_id: &str,
    share_scope_id: &str,
) -> AppResult<()> {
    const SUBTREE_CTE: &str = "WITH RECURSIVE subtree(id) AS (
            SELECT ?1
            UNION ALL
            SELECT c.id FROM collections c JOIN subtree s ON c.parent_collection_id = s.id
        )";

    // 1. Queue vault tombstones for already-pushed rows before we stamp/detach.
    let folder_uids = collect_uids(
        conn,
        &format!("{SUBTREE_CTE} SELECT etebase_uid FROM collections WHERE id IN (SELECT id FROM subtree) AND etebase_uid IS NOT NULL"),
        root_folder_id,
    )?;
    for uid in &folder_uids {
        crate::sync::queue_tombstone(conn, "folder", uid)?;
    }
    let note_uids = collect_uids(
        conn,
        &format!("{SUBTREE_CTE} SELECT etebase_uid FROM notes WHERE parent_collection_id IN (SELECT id FROM subtree) AND etebase_uid IS NOT NULL"),
        root_folder_id,
    )?;
    for uid in &note_uids {
        crate::sync::queue_tombstone(conn, "note", uid)?;
    }
    let asset_uids = collect_uids(
        conn,
        &format!("{SUBTREE_CTE} SELECT a.etebase_uid FROM assets a JOIN notes n ON a.owning_note_id = n.id WHERE n.parent_collection_id IN (SELECT id FROM subtree) AND a.etebase_uid IS NOT NULL"),
        root_folder_id,
    )?;
    for uid in &asset_uids {
        crate::sync::queue_tombstone(conn, "asset", uid)?;
    }

    // 2. Stamp the scope, detach from the vault, and mark dirty.
    conn.execute(
        &format!("{SUBTREE_CTE} UPDATE collections SET share_scope_id = ?2, etebase_uid = NULL, dirty = 1 WHERE id IN (SELECT id FROM subtree)"),
        params![root_folder_id, share_scope_id],
    )?;
    conn.execute(
        &format!("{SUBTREE_CTE} UPDATE notes SET share_scope_id = ?2, etebase_uid = NULL, dirty = 1 WHERE parent_collection_id IN (SELECT id FROM subtree)"),
        params![root_folder_id, share_scope_id],
    )?;
    conn.execute(
        &format!("{SUBTREE_CTE} UPDATE assets SET share_scope_id = ?2, etebase_uid = NULL, dirty = 1 WHERE owning_note_id IN (SELECT n.id FROM notes n WHERE n.parent_collection_id IN (SELECT id FROM subtree))"),
        params![root_folder_id, share_scope_id],
    )?;
    Ok(())
}

fn collect_uids(conn: &Connection, sql: &str, root_folder_id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params![root_folder_id], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
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

/// Gather the manifests backing the current incoming invitations.
///
/// Two sources, merged so a bundle survives past the first scan:
///   * pending `share_manifest` invitations — accepted here (first sight) so
///     the manifest collection becomes fetchable, and
///   * manifest collections accepted on a previous scan, which no longer show
///     up as invitations and so are read straight from the collection list.
///
/// Accepting is idempotent from the caller's perspective: a decode/network
/// failure for one manifest is logged and skipped rather than failing the whole
/// listing, so a single malformed share can't hide every other bundle.
///
/// `current_username` is the signed-in user: manifests they own are dropped so
/// a sender never sees their own outgoing shares surface as incoming bundles
/// (they're a member of the manifest collections they created, so `cm.list`
/// returns them).
fn collect_share_manifests(
    inv_manager: &CollectionInvitationManager,
    cm: &CollectionManager,
    invitations: &[CollectionInvitation],
    current_username: Option<&str>,
) -> AppResult<Vec<ShareManifestPreview>> {
    // Keyed by manifest collection uid so the two sources can't produce a
    // duplicate bundle for the same scope.
    let mut by_collection: HashMap<String, ShareManifestPreview> = HashMap::new();

    for invitation in invitations {
        if invitation.collection_type.as_deref() != Some(COLLECTION_TYPE_SHARE_MANIFEST) {
            continue;
        }
        match accept_and_decode_manifest(inv_manager, cm, &invitation.id) {
            Ok(Some(preview)) => {
                by_collection.insert(preview.manifest_collection_uid.clone(), preview);
            }
            Ok(None) => {}
            Err(e) => log::warn!("[sharing] manifest invite {} skipped: {e}", invitation.id),
        }
    }

    match cm.list(COLLECTION_TYPE_SHARE_MANIFEST, None) {
        Ok(list) => {
            for col in list.data() {
                if col.is_deleted() {
                    continue;
                }
                let uid = col.uid().to_string();
                if by_collection.contains_key(&uid) {
                    continue;
                }
                match decode_manifest(col) {
                    // No pending invitation for an already-accepted manifest, so
                    // the manifest collection uid stands in as the id. The
                    // bundle still surfaces sender/access by falling back to a
                    // referenced part invitation (see build_incoming_share_bundle).
                    Ok(manifest) => {
                        by_collection.insert(
                            uid.clone(),
                            ShareManifestPreview {
                                invitation_id: uid.clone(),
                                manifest_collection_uid: uid,
                                manifest,
                            },
                        );
                    }
                    Err(e) => log::warn!("[sharing] accepted manifest {uid} skipped: {e}"),
                }
            }
        }
        Err(e) => log::warn!("[sharing] list manifest collections failed: {e}"),
    }

    let mut previews: Vec<ShareManifestPreview> = by_collection.into_values().collect();
    if let Some(me) = current_username {
        // Case-insensitive to match the self-invite guard in `invite_collection`:
        // Etebase treats usernames case-insensitively, so an exact compare would
        // let a sender's own share resurface as an incoming bundle when the
        // manifest's stored casing differs from the signed-in username.
        previews.retain(|preview| {
            preview
                .manifest
                .owner_username
                .as_deref()
                .is_none_or(|owner| !owner.eq_ignore_ascii_case(me))
        });
    }
    Ok(previews)
}

/// Accept a pending manifest invitation and decode its manifest content.
/// Returns `Ok(None)` when the invitation vanished (already handled) or the
/// collection was deleted server-side.
fn accept_and_decode_manifest(
    inv_manager: &CollectionInvitationManager,
    cm: &CollectionManager,
    invitation_id: &str,
) -> AppResult<Option<ShareManifestPreview>> {
    let Some(invitation) = find_incoming_invitation(inv_manager, invitation_id)? else {
        return Ok(None);
    };
    inv_manager
        .accept(&invitation)
        .map_err(|e| AppError::InvalidArg(format!("accept manifest invitation: {e}")))?;
    let col_uid = invitation.collection().to_string();
    let col = cm
        .fetch(&col_uid, None)
        .map_err(|e| AppError::InvalidArg(format!("fetch manifest collection: {e}")))?;
    if col.is_deleted() {
        return Ok(None);
    }
    let manifest = decode_manifest(&col)?;
    Ok(Some(ShareManifestPreview {
        invitation_id: invitation_id.to_string(),
        manifest_collection_uid: col_uid,
        manifest,
    }))
}

/// A manifest is stored as the manifest collection's own JSON content (not as
/// items inside it), so decoding is content-bytes → serde_json.
fn decode_manifest(col: &Collection) -> AppResult<ShareManifest> {
    let raw = col
        .content()
        .map_err(|e| AppError::InvalidArg(format!("manifest content: {e}")))?;
    serde_json::from_slice(&raw)
        .map_err(|e| AppError::InvalidArg(format!("decode manifest json: {e}")))
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

    // The manifest invitation carries sender/access, but once it's been
    // auto-accepted it's gone from the incoming list — fall back to a
    // referenced part invitation, which shares the same sender and (by our
    // share-creation policy) the same access level.
    let fallback_invitation = parts.iter().find_map(|part| part.invitation.as_ref());
    let sender_username = manifest_invitation
        .and_then(|invitation| invitation.sender_username.clone())
        .or_else(|| fallback_invitation.and_then(|invitation| invitation.sender_username.clone()));
    let access_level = manifest_invitation
        .map(|invitation| invitation.access_level)
        .or_else(|| fallback_invitation.map(|invitation| invitation.access_level));

    IncomingShareBundle {
        manifest_invitation_id: preview.invitation_id,
        manifest_collection_uid: preview.manifest_collection_uid,
        share_scope_id: manifest.share_scope_id,
        name: manifest.name,
        root_folder_id: manifest.root_folder_id,
        owner_username: manifest.owner_username,
        sender_username,
        access_level,
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

/// Project an accepted remote share onto the local `collections` table: update
/// the row already anchored to `collection_uid`, or insert a placeholder shared
/// root so the folder shows up in "shared with me" before the scoped sync pulls
/// its real contents.
///
/// `name_override` lets a manifest bundle name the root after the share (e.g.
/// "Project X") instead of the generic "sender's shared collection" fallback
/// used by a bare single-collection accept.
fn record_accepted_share(
    conn: &Connection,
    collection_uid: &str,
    role: ShareAccessLevel,
    owner: Option<&str>,
    name_override: Option<&str>,
) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    let role_db = share_access_level_to_db(role);
    let changed = conn.execute(
        "UPDATE collections
            SET shared_role = ?1,
                shared_owner = ?2,
                shared_by_me = 0,
                modified = ?3
          WHERE share_id = ?4",
        params![role_db, owner, now, collection_uid],
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
    let name = name_override
        .map(str::to_string)
        .or_else(|| owner.map(|sender| format!("{sender}'s shared collection")))
        .unwrap_or_else(|| "Shared collection".to_string());
    conn.execute(
        "INSERT INTO collections(
            id, parent_collection_id, name, position, created, modified,
            dirty, share_id, shared_role, shared_owner, shared_by_me
         )
         VALUES (?1, NULL, ?2, ?3, ?4, ?4, 0, ?5, ?6, ?7, 0)",
        params![id, name, position, now, collection_uid, role_db, owner],
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
    fn migrate_subtree_into_scope_stamps_detaches_and_tombstones() {
        let db = crate::db::open_memory_for_tests();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO collections(id, parent_collection_id, name, position, created, modified, etebase_uid, dirty)
                 VALUES ('root', NULL, 'Root', 0, 't', 't', 'vault_root', 0)",
                [],
            )?;
            conn.execute(
                "INSERT INTO collections(id, parent_collection_id, name, position, created, modified, etebase_uid, dirty)
                 VALUES ('child', 'root', 'Child', 0, 't', 't', 'vault_child', 0)",
                [],
            )?;
            conn.execute(
                "INSERT INTO notes(id, parent_collection_id, title, body, position, created, modified, etebase_uid, dirty)
                 VALUES ('n1', 'child', 'N1', '', 0, 't', 't', 'vault_n1', 0)",
                [],
            )?;
            // n2 was never pushed (no etebase_uid) — it must still get stamped
            // but queue no tombstone.
            conn.execute(
                "INSERT INTO notes(id, parent_collection_id, title, body, position, created, modified, dirty)
                 VALUES ('n2', 'root', 'N2', '', 0, 't', 't', 0)",
                [],
            )?;
            conn.execute(
                "INSERT INTO assets(id, owning_note_id, mime_type, bytes, size, created, modified, etebase_uid, dirty)
                 VALUES ('a1', 'n1', 'image/png', x'00', 1, 't', 't', 'vault_a1', 0)",
                [],
            )?;
            Ok::<(), AppError>(())
        })
        .unwrap();

        db.with_conn(|conn| migrate_subtree_into_scope(conn, "root", "scope_1"))
            .unwrap();

        db.with_conn(|conn| {
            for (table, id) in [
                ("collections", "root"),
                ("collections", "child"),
                ("notes", "n1"),
                ("notes", "n2"),
                ("assets", "a1"),
            ] {
                let (scope, uid, dirty): (Option<String>, Option<String>, i64) = conn.query_row(
                    &format!(
                        "SELECT share_scope_id, etebase_uid, dirty FROM {table} WHERE id = ?1"
                    ),
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?;
                assert_eq!(scope.as_deref(), Some("scope_1"), "{table} {id} scope");
                assert!(uid.is_none(), "{table} {id} etebase_uid must be detached");
                assert_eq!(dirty, 1, "{table} {id} must be dirty");
            }

            // Only the four already-pushed rows get a tombstone, all routed to
            // the vault (share_scope_id NULL) so the old vault items are deleted.
            let mut stmt = conn.prepare(
                "SELECT etebase_uid, share_scope_id FROM tombstones ORDER BY etebase_uid",
            )?;
            let rows: Vec<(String, Option<String>)> = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let uids: Vec<&str> = rows.iter().map(|(u, _)| u.as_str()).collect();
            assert_eq!(uids, ["vault_a1", "vault_child", "vault_n1", "vault_root"]);
            assert!(
                rows.iter().all(|(_, scope)| scope.is_none()),
                "migration tombstones must route to the vault collection"
            );
            Ok::<(), AppError>(())
        })
        .unwrap();
    }

    #[test]
    fn profile_lookup_error_is_friendly_for_missing_user() {
        let friendly = profile_lookup_error("bob", "UserInfo matching query does not exist.");
        let AppError::InvalidArg(message) = friendly else {
            panic!("expected InvalidArg");
        };
        assert!(message.contains("bob"), "{message}");
        assert!(message.contains("sign in once"), "{message}");
        assert!(
            !message.contains("matching query"),
            "raw etebase text should not leak: {message}"
        );

        // Unrelated errors keep their detail for debugging.
        let other = profile_lookup_error("bob", "network unreachable");
        let AppError::InvalidArg(message) = other else {
            panic!("expected InvalidArg");
        };
        assert!(message.contains("network unreachable"), "{message}");
    }

    #[test]
    fn build_share_manifest_lists_three_required_parts() {
        let manifest = build_share_manifest(
            "scope_1",
            "Project X",
            "coll_root",
            Some("alice"),
            "col_folders",
            "col_notes",
            "col_assets",
        );

        assert_eq!(manifest.schema, 1);
        assert_eq!(manifest.share_scope_id, "scope_1");
        assert_eq!(manifest.root_folder_id, "coll_root");
        assert_eq!(manifest.owner_username.as_deref(), Some("alice"));
        assert_eq!(manifest.collections.len(), 3);
        for part in [
            ShareScopePart::Folders,
            ShareScopePart::Notes,
            ShareScopePart::Assets,
        ] {
            let entry = manifest
                .collections
                .iter()
                .find(|collection| collection.part == part)
                .unwrap_or_else(|| panic!("missing {part:?} ref"));
            assert!(entry.required, "{part:?} must be required");
        }

        // Round-trips through the same JSON the receiver's decode_manifest reads.
        let json = serde_json::to_vec(&manifest).unwrap();
        let decoded: ShareManifest = serde_json::from_slice(&json).unwrap();
        assert_eq!(decoded, manifest);
    }

    #[test]
    fn accepted_manifest_falls_back_to_part_invitation_for_sender_and_access() {
        // Mirrors a second scan: the manifest has been auto-accepted so its
        // invitation is gone, but the part invitations are still pending. The
        // bundle must still show sender/access, drawn from a part invitation.
        let invitations = vec![
            invitation(
                "invite_folders",
                "col_folders",
                COLLECTION_TYPE_SHARE_FOLDERS,
            ),
            invitation("invite_notes", "col_notes", COLLECTION_TYPE_SHARE_NOTES),
            invitation("invite_assets", "col_assets", COLLECTION_TYPE_SHARE_ASSETS),
        ];
        // Synthetic id == manifest collection uid (no pending manifest invite).
        let mut preview = manifest_preview(vec![
            collection_ref(ShareScopePart::Folders, "col_folders"),
            collection_ref(ShareScopePart::Notes, "col_notes"),
            collection_ref(ShareScopePart::Assets, "col_assets"),
        ]);
        preview.invitation_id = preview.manifest_collection_uid.clone();

        let result = bundle_incoming_share_invitations(invitations, vec![preview]);

        assert_eq!(result.bundles.len(), 1);
        let bundle = &result.bundles[0];
        assert!(bundle.complete, "{:?}", bundle.warnings);
        assert_eq!(bundle.sender_username.as_deref(), Some("sender"));
        assert_eq!(bundle.access_level, Some(ShareAccessLevel::ReadWrite));
        assert!(
            result.unbundled_invitations.is_empty(),
            "part invites must stay bundled even without a manifest invitation"
        );
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
