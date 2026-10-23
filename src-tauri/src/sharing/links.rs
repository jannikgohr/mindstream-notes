//! Invite links to a shared folder: making, listing and removing them, and
//! joining by one.
//!
//! A link invites whoever holds it, where an invitation invites a user by
//! name. Its secret is in its text and nowhere else, so a link can be shown
//! once, when it is made, and the server can be asked about it but never
//! for it. See the client library's `mindstream::links` for how that works.

use etebase::error::Error as ServerError;
use etebase::{InviteLink, LinkInfo, LinkOptions};
use reqwest::Url;

use super::*;
use crate::auth::account::refusal;
use crate::error::CommandError;

/// The text is not an invite link, or leads to something that is not a
/// shared folder.
const REASON_NOT_A_LINK: &str = "link_invalid";
/// The link is for a server this device is not signed in to.
const REASON_OTHER_SERVER: &str = "link_other_server";
const REASON_NOT_SIGNED_IN: &str = "not_signed_in";

const SECS_PER_DAY: u64 = 24 * 3600;

#[derive(Debug, Clone, Deserialize)]
pub struct CreateShareLinkInput {
    pub collection_id: String,
    pub access_level: ShareAccessLevel,
    /// How many people the link lets in. The server's default is one.
    #[serde(default)]
    pub max_uses: Option<u32>,
    /// How long it lasts. The server's default is a week.
    #[serde(default)]
    pub expires_in_days: Option<u32>,
    /// Whether it may create an account for someone who has none. Only a
    /// server whose signup setting is `invite` allows that.
    #[serde(default)]
    pub allow_signup: bool,
}

/// A link that was just made. `link` is the only copy of its secret.
#[derive(Debug, Clone, Serialize)]
pub struct CreatedShareLink {
    pub link: String,
    pub uid: String,
}

/// A link as the people who manage a folder see it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ShareLink {
    pub uid: String,
    pub access_level: ShareAccessLevel,
    pub max_uses: u32,
    pub uses: u32,
    pub allows_signup: bool,
    /// Seconds since 1970.
    pub expires_at: i64,
    pub created_at: i64,
    pub sender_username: String,
}

impl From<&LinkInfo> for ShareLink {
    fn from(info: &LinkInfo) -> Self {
        Self {
            uid: info.uid().to_string(),
            access_level: info.access_level().into(),
            max_uses: info.max_uses(),
            uses: info.uses(),
            allows_signup: info.allows_signup(),
            expires_at: info.expires_at(),
            created_at: info.created_at(),
            sender_username: info.sender_username().to_string(),
        }
    }
}

/// What a link leads to, for someone deciding whether to join.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ShareLinkPreview {
    /// The server the link belongs to.
    pub server_url: String,
    pub collection_uid: String,
    pub name: Option<String>,
    pub sender_username: String,
    pub access_level: ShareAccessLevel,
    /// The link can still create an account on its server.
    pub can_signup: bool,
    /// This device is signed in to the link's server, so it can join.
    pub signed_in: bool,
    /// The folder is on this device already.
    pub already_member: bool,
}

/// What a link's maker may ask for. A link gives read or write access and
/// never the power to remove everyone else.
pub(super) fn link_options(input: &CreateShareLinkInput) -> AppResult<LinkOptions> {
    if matches!(input.access_level, ShareAccessLevel::Admin) {
        return Err(AppError::InvalidArg(
            "an invite link can let people view or edit, not manage the folder".into(),
        ));
    }
    let mut options = LinkOptions::new().allow_signup(input.allow_signup);
    if let Some(people) = input.max_uses {
        options = options.max_uses(people);
    }
    if let Some(days) = input.expires_in_days {
        options = options.expires_in(u64::from(days) * SECS_PER_DAY);
    }
    Ok(options)
}

/// Whether two addresses name the same server. A link is only good on the
/// server that made it, and the two may be written a little differently:
/// with or without a trailing slash, a default port, or capitals in the
/// host.
pub(super) fn same_server(one: &str, other: &str) -> bool {
    fn parts(text: &str) -> Option<(String, String, Option<u16>, String)> {
        let url = Url::parse(text.trim()).ok()?;
        Some((
            url.scheme().to_string(),
            url.host_str()?.to_ascii_lowercase(),
            url.port_or_known_default(),
            url.path().trim_end_matches('/').to_string(),
        ))
    }
    match (parts(one), parts(other)) {
        (Some(one), Some(other)) => one == other,
        _ => false,
    }
}

fn not_a_link() -> CommandError {
    CommandError::refused(REASON_NOT_A_LINK, "that is not an invite link")
}

fn parse_link(text: &str) -> Result<InviteLink, CommandError> {
    InviteLink::parse(text).map_err(|_| not_a_link())
}

/// The account, if this device is signed in to the server `link` is for.
fn account_for(app: &AppHandle, link: &InviteLink) -> Result<Option<Account>, CommandError> {
    let Some(session) = crate::auth::read_session_info(app)? else {
        return Ok(None);
    };
    if !same_server(&session.server_url, link.server_url().as_str()) {
        return Ok(None);
    }
    Ok(crate::auth::try_restore(app)
        .map_err(|e| AppError::InvalidArg(format!("restore session: {e}")))?)
}

fn open_link(link: &InviteLink) -> Result<etebase::LinkPreview, CommandError> {
    let client = crate::auth::client_for(link.server_url().as_str())?;
    let preview = link
        .open(&client)
        .map_err(|e| refusal("open the invite link", e))?;
    // Only a shared folder is something this app joins, for the reason an
    // invitation to anything else is not shown: its maker would be putting a
    // collection of their choosing among the user's.
    if preview.collection_type() != COLLECTION_TYPE_SHARED {
        return Err(not_a_link());
    }
    Ok(preview)
}

/// Make an invite link to a folder, sharing the folder first if it is not
/// shared yet. The link comes back once and cannot be shown again.
#[tauri::command]
pub async fn create_share_link(
    app: AppHandle,
    input: CreateShareLinkInput,
) -> CommandResult<CreatedShareLink> {
    let job = app.state::<crate::vault_jobs::Jobs>().enter()?;
    tauri::async_runtime::spawn_blocking(move || -> CommandResult<CreatedShareLink> {
        let _job = job;
        let options = link_options(&input)?;
        let collection_id = input.collection_id.as_str();
        let db = app.state::<Db>();
        let folder = db.with_conn(|conn| crate::collections::get(conn, collection_id))?;
        if collection_id == crate::collections::TRASH_ID {
            return Err(
                AppError::InvalidArg("the trash collection cannot be shared".into()).into(),
            );
        }

        let account = restore_required(&app)?;
        let owner_username = crate::auth::read_session_info(&app)?.map(|info| info.username);
        let cm = account
            .collection_manager()
            .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;
        let existing_scope = db.with_conn(|conn| collection_scope(conn, collection_id))?;
        // Before the server makes a collection that recording would then
        // refuse.
        db.with_conn(|conn| crate::demo_notes::ensure_folder_shareable(conn, collection_id))?;
        let (collection, created) = resolve_or_create_space(
            &cm,
            &folder,
            existing_scope.as_deref(),
            owner_username.as_deref(),
        )?;

        // Recorded before the link is made. If making it fails, the folder
        // is shared with nobody yet and the next try finds its collection.
        // Recording afterwards would leave a collection nothing points to,
        // and make another on every try.
        db.with_conn(|conn| {
            move_into_space(
                conn,
                collection_id,
                collection.uid(),
                created,
                owner_username.as_deref(),
            )
        })?;

        let link = account
            .create_invite_link(&collection, input.access_level.into(), &options)
            .map_err(|e| refusal("make an invite link", e))?;

        Ok(CreatedShareLink {
            uid: link.uid().to_string(),
            link: link.to_string(),
        })
    })
    .await
    .map_err(|e| CommandError::task(format!("create share link task: {e}")))?
}

/// The links into a folder that have not run out of time. One that is used
/// up stays listed until then, so that its maker sees it was used. Empty
/// for a folder that is not shared.
#[tauri::command]
pub async fn list_share_links(
    app: AppHandle,
    collection_id: String,
) -> CommandResult<Vec<ShareLink>> {
    let job = app.state::<crate::vault_jobs::Jobs>().enter()?;
    tauri::async_runtime::spawn_blocking(move || -> CommandResult<Vec<ShareLink>> {
        let _job = job;
        let account = restore_required(&app)?;
        let db = app.state::<Db>();
        let Some(scope) = db.with_conn(|conn| collection_scope(conn, &collection_id))? else {
            return Ok(Vec::new());
        };
        let cm = account
            .collection_manager()
            .map_err(|e| AppError::InvalidArg(format!("collection_manager: {e}")))?;
        let Some(collection) = open_space(&cm, &scope)? else {
            return Ok(Vec::new());
        };
        let links = account
            .invite_links(&collection)
            .map_err(|e| refusal("list invite links", e))?;
        Ok(links.iter().map(ShareLink::from).collect())
    })
    .await
    .map_err(|e| CommandError::task(format!("list share links task: {e}")))?
}

/// Remove a link, so that it lets nobody else in. Whoever it already let in
/// stays.
#[tauri::command]
pub async fn revoke_share_link(app: AppHandle, uid: String) -> CommandResult<()> {
    let job = app.state::<crate::vault_jobs::Jobs>().enter()?;
    tauri::async_runtime::spawn_blocking(move || -> CommandResult<()> {
        let _job = job;
        let account = restore_required(&app)?;
        account
            .revoke_invite_link(&uid)
            .map_err(|e| refusal("remove the invite link", e))
    })
    .await
    .map_err(|e| CommandError::task(format!("revoke share link task: {e}")))?
}

/// Look at what a pasted link leads to. Joins nothing and needs no account.
#[tauri::command]
pub async fn open_share_link(app: AppHandle, link: String) -> CommandResult<ShareLinkPreview> {
    let job = app.state::<crate::vault_jobs::Jobs>().enter()?;
    tauri::async_runtime::spawn_blocking(move || -> CommandResult<ShareLinkPreview> {
        let _job = job;
        let link = parse_link(&link)?;
        let preview = open_link(&link)?;
        let signed_in = account_for(&app, &link)?.is_some();
        let db = app.state::<Db>();
        let already_member = db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM collections WHERE share_scope_id = ?1)",
                params![preview.collection_uid()],
                |row| row.get::<_, bool>(0),
            )?)
        })?;
        Ok(ShareLinkPreview {
            server_url: link.server_url().to_string(),
            collection_uid: preview.collection_uid().to_string(),
            name: preview
                .collection_name()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string),
            sender_username: preview.sender_username().to_string(),
            access_level: preview.access_level().into(),
            can_signup: preview.can_signup(),
            signed_in,
            already_member,
        })
    })
    .await
    .map_err(|e| CommandError::task(format!("open share link task: {e}")))?
}

/// Join the shared folder a link leads to. Like accepting an invitation,
/// this creates nothing locally: the next sync pulls the folder in.
#[tauri::command]
pub async fn claim_share_link(app: AppHandle, link: String) -> CommandResult<()> {
    let job = app.state::<crate::vault_jobs::Jobs>().enter()?;
    tauri::async_runtime::spawn_blocking(move || -> CommandResult<()> {
        let _job = job;
        let link = parse_link(&link)?;
        if crate::auth::read_session_info(&app)?.is_none() {
            return Err(CommandError::refused(REASON_NOT_SIGNED_IN, "not signed in"));
        }
        let Some(account) = account_for(&app, &link)? else {
            return Err(CommandError::refused(
                REASON_OTHER_SERVER,
                format!("this link is for {}", link.server_url()),
            ));
        };
        // Looked at before it is claimed, so that a link to anything but a
        // shared folder is never joined.
        open_link(&link)?;
        account
            .claim_invite_link(&link)
            .map_err(|e: ServerError| refusal("join by the invite link", e))
    })
    .await
    .map_err(|e| CommandError::task(format!("claim share link task: {e}")))?
}
