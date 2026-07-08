//! Collection sharing command layer.
//!
//! Etebase shares remote Collections, while Mindstream's visible folders are
//! SQLite rows synced as Items inside the single `mindstream.folders`
//! Collection. Incoming invitations can be listed/accepted/rejected today.
//! Outgoing per-folder invites are deliberately guarded until the sync model
//! can represent one remote Collection per shared folder/subtree.

use chrono::Utc;
use etebase::{Account, CollectionAccessLevel, FetchOptions, SignedInvitation};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::db::Db;
use crate::error::{AppError, AppResult};

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

#[derive(Debug, Clone, Serialize)]
pub struct CollectionInvitation {
    pub id: String,
    pub username: String,
    pub sender_username: Option<String>,
    pub collection_uid: String,
    pub access_level: ShareAccessLevel,
}

impl From<&SignedInvitation> for CollectionInvitation {
    fn from(invitation: &SignedInvitation) -> Self {
        Self {
            id: invitation.uid().to_string(),
            username: invitation.username().to_string(),
            sender_username: invitation.sender_username().map(str::to_string),
            collection_uid: invitation.collection().to_string(),
            access_level: invitation.access_level().into(),
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
        out.extend(page.data().iter().map(CollectionInvitation::from));
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
