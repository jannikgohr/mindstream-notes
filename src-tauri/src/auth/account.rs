//! Account security on the sync server: signing up, getting back in with a
//! recovery key, the second factor, the password, and the devices signed in.
//!
//! Every command here talks to the server through the client library, which
//! blocks, so each runs on the blocking pool. A refusal reaches the UI as a
//! [`CommandError`] whose `reason` is the server's own code for it, or one of
//! the few this module adds. The UI translates the reasons it knows and
//! shows the message for the rest.

use std::time::Duration;

use etebase::error::Error as ServerError;
use etebase::{refusal as server, Account, InviteLink, RecoveryKey, SignupWith, User};
use qrcode::render::svg;
use qrcode::QrCode;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::{AppError, CommandError, CommandErrorCode, CommandResult};

use super::{
    active_keyring_account, client_for, end_session_locally, persist_account, resolve_server_url,
    session_path, store_session, try_restore, SessionInfo,
};

/// The server could not be asked at all.
const REASON_UNREACHABLE: &str = "unreachable";
/// What was typed is not a recovery key: too short, or a typing mistake.
const REASON_NOT_A_RECOVERY_KEY: &str = "recovery_key_malformed";
const REASON_NOT_SIGNED_IN: &str = "not_signed_in";
/// The address answers, and not the way this app's server does.
const REASON_NOT_A_SERVER: &str = "not_a_mindstream_server";

const SERVER_INFO_TIMEOUT: Duration = Duration::from_secs(8);
/// Compatibility is determined by the protocol, independently of release versions.
/// See PROTOCOL_LEVEL in backend/server/src/lib.rs.
const SUPPORTED_PROTOCOL: u32 = 1;
/// Side of the QR code in pixels, before the page scales it.
const QR_SIZE: u32 = 220;

/// Turn the client library's error into what the UI gets. `doing` names the
/// attempt for the log and for a message nobody translated.
pub(crate) fn refusal(doing: &str, err: ServerError) -> CommandError {
    match err {
        ServerError::Refused { code, detail, .. } => {
            CommandError::refused(code, format!("{doing}: {detail}"))
        }
        ServerError::Connection(detail) => {
            CommandError::refused(REASON_UNREACHABLE, format!("{doing}: {detail}"))
        }
        other => CommandError::new(CommandErrorCode::Unknown, format!("{doing}: {other}")),
    }
}

/// A code as the field was left: nothing when it is empty.
pub(super) fn typed(code: Option<&str>) -> Option<&str> {
    code.map(str::trim).filter(|code| !code.is_empty())
}

/// Whether the server's answer means this device is no longer signed in.
fn session_is_over(err: &ServerError) -> bool {
    matches!(
        err,
        ServerError::Refused { code, .. }
            if code == server::SESSION_ENDED || code == server::USER_DISABLED
    )
}

/// Run `task` with the signed-in account, off the async runtime.
async fn with_account<T: Send + 'static>(
    app: AppHandle,
    doing: &'static str,
    task: impl FnOnce(&mut Account) -> Result<T, ServerError> + Send + 'static,
) -> CommandResult<T> {
    let job = app.state::<crate::vault_jobs::Jobs>().enter()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _job = job;
        let mut account = try_restore(&app)?
            .ok_or_else(|| CommandError::refused(REASON_NOT_SIGNED_IN, "not signed in"))?;
        task(&mut account).map_err(|err| {
            if session_is_over(&err) {
                end_session_locally(&app);
            }
            refusal(doing, err)
        })
    })
    .await
    .map_err(|e| CommandError::task(format!("{doing} task: {e}")))?
}

/// A session that has just been opened by something other than signing in,
/// and the recovery key that came with it. The key is shown once.
#[derive(Serialize)]
pub struct NewAccount {
    pub session: SessionInfo,
    pub recovery_key: String,
}

#[derive(Deserialize)]
pub struct SignupArgs {
    pub server_type: String,
    pub server_url: Option<String>,
    pub username: String,
    pub email: String,
    pub password: String,
    /// A code from the server's administrator, where signup is not open.
    #[serde(default)]
    pub signup_code: Option<String>,
    /// Or an invite link whose maker let it create an account. The account
    /// is made on the link's server, whatever server was named besides, and
    /// then joins what the link leads to.
    #[serde(default)]
    pub invite_link: Option<String>,
}

/// The text is not an invite link.
const REASON_NOT_A_LINK: &str = "link_invalid";

/// The invite link a signup came with, if it came with one.
fn signup_link(text: Option<&str>) -> CommandResult<Option<InviteLink>> {
    typed(text)
        .map(|text| {
            InviteLink::parse(text)
                .map_err(|_| CommandError::refused(REASON_NOT_A_LINK, "that is not an invite link"))
        })
        .transpose()
}

/// Create an account and sign this device in to it.
#[tauri::command]
pub async fn account_signup(args: SignupArgs, app: AppHandle) -> CommandResult<NewAccount> {
    let link = signup_link(args.invite_link.as_deref())?;
    // A link is good on one server, the one in its address.
    let server_url = match &link {
        Some(link) => link.server_url().to_string(),
        None => resolve_server_url(&args.server_type, args.server_url.as_deref())?,
    };
    let path = session_path(&app)?;
    let keyring_account = active_keyring_account(&app);

    let job = app.state::<crate::vault_jobs::Jobs>().enter()?;
    tauri::async_runtime::spawn_blocking(move || -> CommandResult<NewAccount> {
        let _job = job;
        let client = client_for(&server_url)?;
        let user = User::new(args.username.trim(), args.email.trim());
        let mut with = SignupWith::new();
        if let Some(code) = typed(args.signup_code.as_deref()) {
            with = with.signup_code(code);
        }
        if let Some(link) = &link {
            with = with.invite_link(link);
        }
        let (account, recovery_key) = Account::signup_with(client, &user, &args.password, &with)
            .map_err(|e| refusal("sign up", e))?;
        // Having an account is not yet being in the folder the link leads
        // to. Joining is its own step, and a failure there must not undo a
        // signup that worked: the link can be pasted again.
        if let Some(link) = &link {
            if let Err(e) = account.claim_invite_link(link) {
                log::warn!("[account] signed up by an invite link but could not join by it: {e}");
            }
        }
        let session = store_session(
            &path,
            &keyring_account,
            args.username.trim(),
            &server_url,
            &account,
        )?;
        Ok(NewAccount {
            session,
            recovery_key: recovery_key.to_string(),
        })
    })
    .await
    .map_err(|e| CommandError::task(format!("signup task: {e}")))?
}

#[derive(Deserialize)]
pub struct RecoverArgs {
    pub server_type: String,
    pub server_url: Option<String>,
    pub username: String,
    pub recovery_key: String,
    pub new_password: String,
    #[serde(default)]
    pub code: Option<String>,
}

fn parse_recovery_key(text: &str) -> CommandResult<RecoveryKey> {
    RecoveryKey::parse(text).map_err(|_| {
        CommandError::refused(
            REASON_NOT_A_RECOVERY_KEY,
            "that is not a recovery key; check it for typing mistakes",
        )
    })
}

/// Get back into an account with its recovery key and set a new password.
/// Every device is signed out, this one is signed in, and the account gets
/// a new recovery key, which is returned to be shown.
#[tauri::command]
pub async fn account_recover(args: RecoverArgs, app: AppHandle) -> CommandResult<NewAccount> {
    let server_url = resolve_server_url(&args.server_type, args.server_url.as_deref())?;
    // Checked here, so a typing mistake costs no attempt at the server.
    let key = parse_recovery_key(&args.recovery_key)?;
    let path = session_path(&app)?;
    let keyring_account = active_keyring_account(&app);

    let job = app.state::<crate::vault_jobs::Jobs>().enter()?;
    tauri::async_runtime::spawn_blocking(move || -> CommandResult<NewAccount> {
        let _job = job;
        let client = client_for(&server_url)?;
        let username = args.username.trim();
        let recovery = Account::recover(client, username, &key, typed(args.code.as_deref()))
            .map_err(|e| refusal("recover", e))?;
        let (account, new_key) = recovery
            .complete(&args.new_password)
            .map_err(|e| refusal("recover", e))?;
        let session = store_session(&path, &keyring_account, username, &server_url, &account)?;
        Ok(NewAccount {
            session,
            recovery_key: new_key.to_string(),
        })
    })
    .await
    .map_err(|e| CommandError::task(format!("recovery task: {e}")))?
}

#[derive(Serialize)]
pub struct SecurityOverview {
    pub authenticator: bool,
    pub backup_codes: u32,
    pub recovery_key: bool,
    /// Whether this device signed in with a second factor. One that did may
    /// replace the authenticator on the password alone.
    pub session_verified: bool,
}

#[tauri::command]
pub async fn account_security_status(app: AppHandle) -> CommandResult<SecurityOverview> {
    with_account(app, "read account security", |account| {
        let status = account.security().status()?;
        Ok(SecurityOverview {
            authenticator: status.authenticator(),
            backup_codes: status.backup_codes(),
            recovery_key: status.recovery_key(),
            session_verified: status.session_verified(),
        })
    })
    .await
}

/// An authenticator that is being set up: the secret to type in, the same as
/// a link, and the link as a QR code to scan.
#[derive(Serialize)]
pub struct AuthenticatorSetup {
    pub secret: String,
    pub url: String,
    pub qr_svg: String,
}

fn qr_svg(text: &str) -> Result<String, String> {
    let code = QrCode::new(text.as_bytes()).map_err(|e| format!("qr code: {e}"))?;
    Ok(code
        .render::<svg::Color>()
        .min_dimensions(QR_SIZE, QR_SIZE)
        // Black on white whatever the theme: scanners expect it, and the
        // quiet zone has to be light.
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .build())
}

#[tauri::command]
pub async fn account_begin_authenticator(
    password: String,
    code: Option<String>,
    app: AppHandle,
) -> CommandResult<AuthenticatorSetup> {
    let setup = with_account(app, "set up the authenticator", move |account| {
        account
            .security()
            .begin_authenticator(&password, typed(code.as_deref()))
    })
    .await?;
    Ok(AuthenticatorSetup {
        qr_svg: qr_svg(setup.url())?,
        secret: setup.secret().to_string(),
        url: setup.url().to_string(),
    })
}

/// Finish the setup with a code from the authenticator. Returns the backup
/// codes, which the server will not show again.
#[tauri::command]
pub async fn account_confirm_authenticator(
    code: String,
    app: AppHandle,
) -> CommandResult<Vec<String>> {
    with_account(app, "confirm the authenticator", move |account| {
        account.security().confirm_authenticator(code.trim())
    })
    .await
}

#[tauri::command]
pub async fn account_remove_authenticator(
    password: String,
    code: String,
    app: AppHandle,
) -> CommandResult<()> {
    with_account(app, "remove the authenticator", move |account| {
        account
            .security()
            .remove_authenticator(&password, code.trim())
    })
    .await
}

#[tauri::command]
pub async fn account_new_backup_codes(
    password: String,
    code: String,
    app: AppHandle,
) -> CommandResult<Vec<String>> {
    with_account(app, "replace the backup codes", move |account| {
        account.security().new_backup_codes(&password, code.trim())
    })
    .await
}

/// Replace the account's recovery key. Returns the new one, to be shown.
#[tauri::command]
pub async fn account_new_recovery_key(
    password: String,
    code: Option<String>,
    app: AppHandle,
) -> CommandResult<String> {
    with_account(app, "replace the recovery key", move |account| {
        let key = account
            .security()
            .new_recovery_key(&password, typed(code.as_deref()))?;
        Ok(key.to_string())
    })
    .await
}

/// Set a new password. The server signs every other device out. This one
/// stays signed in, with its stored session rewritten for the new password.
#[tauri::command]
pub async fn account_change_password(
    new_password: String,
    code: Option<String>,
    app: AppHandle,
) -> CommandResult<()> {
    let app_for_save = app.clone();
    with_account(app, "change the password", move |account| {
        account.change_password_with_code(&new_password, typed(code.as_deref()))?;
        // The server has the new password from here on. A session file
        // that could not be rewritten still holds a working session, so
        // this is worth a warning and not a failure the user would read
        // as "the password did not change".
        if let Err(err) = persist_account(&app_for_save, account) {
            log::warn!("[auth] password changed but the session was not rewritten: {err}");
        }
        Ok(())
    })
    .await
}

#[derive(Serialize)]
pub struct DeviceSession {
    pub id: i64,
    pub device_name: String,
    /// Seconds since 1970.
    pub created_at: i64,
    pub last_used_at: i64,
    pub second_factor: bool,
    /// The device asking.
    pub current: bool,
}

#[tauri::command]
pub async fn account_sessions(app: AppHandle) -> CommandResult<Vec<DeviceSession>> {
    with_account(app, "list devices", |account| {
        let sessions = account.security().sessions()?;
        Ok(sessions
            .iter()
            .map(|session| DeviceSession {
                id: session.id(),
                device_name: session.device_name().to_string(),
                created_at: session.created_at(),
                last_used_at: session.last_used_at(),
                second_factor: session.second_factor(),
                current: session.current(),
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn account_end_session(id: i64, app: AppHandle) -> CommandResult<()> {
    with_account(app, "sign a device out", move |account| {
        account.security().end_session(id)
    })
    .await
}

#[tauri::command]
pub async fn account_end_other_sessions(app: AppHandle) -> CommandResult<()> {
    with_account(app, "sign the other devices out", |account| {
        account.security().end_other_sessions()
    })
    .await
}

/// What a server says about itself before anyone signs in.
#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct ServerInfo {
    /// "open", "invite" or "closed": who may create an account.
    pub signup: String,
    pub protocol: u32,
    pub version: String,
}

fn info_url(server_url: &str) -> Result<Url, AppError> {
    let mut url =
        Url::parse(server_url).map_err(|e| AppError::InvalidArg(format!("server URL: {e}")))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(AppError::InvalidArg(
            "server URL must use http:// or https://".into(),
        ));
    }
    url.set_query(None);
    url.set_fragment(None);
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    url.join("api/v1/mindstream/info/")
        .map_err(|e| AppError::InvalidArg(format!("info URL: {e}")))
}

fn parse_server_info(status: u16, body: &[u8]) -> CommandResult<ServerInfo> {
    let not_a_server =
        || CommandError::refused(REASON_NOT_A_SERVER, "this is not a Mindstream sync server");
    if !(200..300).contains(&status) {
        return Err(not_a_server());
    }
    #[derive(Deserialize)]
    struct Response {
        server: String,
        #[serde(flatten)]
        info: ServerInfo,
    }
    let response: Response = serde_json::from_slice(body).map_err(|_| not_a_server())?;
    if response.server != "mindstream-server" || response.info.version.trim().is_empty() {
        return Err(not_a_server());
    }
    let info = response.info;
    if info.protocol != SUPPORTED_PROTOCOL {
        let reason = if info.protocol > SUPPORTED_PROTOCOL {
            "server_protocol_too_new"
        } else {
            "server_protocol_too_old"
        };
        return Err(CommandError::refused(
            reason,
            format!(
                "server {} uses protocol {}; this app supports protocol {}",
                info.version, info.protocol, SUPPORTED_PROTOCOL
            ),
        ));
    }
    Ok(info)
}

/// Read and validate the server identity and protocol for both URL checks and signup.
pub(super) async fn fetch_server_info(
    client: &reqwest::Client,
    server_url: &str,
) -> CommandResult<ServerInfo> {
    let url = info_url(server_url)?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| CommandError::refused(REASON_UNREACHABLE, format!("server info: {e}")))?;
    let status = response.status().as_u16();
    let body = response
        .bytes()
        .await
        .map_err(|e| CommandError::refused(REASON_UNREACHABLE, format!("server info: {e}")))?;
    parse_server_info(status, &body)
}

/// Ask a compatible server whether it takes new accounts, so the signup
/// form can ask for a code only where one is needed.
#[tauri::command]
pub async fn account_server_info(
    server_type: String,
    server_url: Option<String>,
) -> CommandResult<ServerInfo> {
    let server_url = resolve_server_url(&server_type, server_url.as_deref())?;
    let client = reqwest::Client::builder()
        .timeout(SERVER_INFO_TIMEOUT)
        .build()
        .map_err(|e| format!("server info client: {e}"))?;
    fetch_server_info(&client, &server_url).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(code: &str) -> ServerError {
        ServerError::Refused {
            status: 401,
            code: code.to_string(),
            detail: "in words".to_string(),
        }
    }

    #[test]
    fn refusal_carries_the_servers_reason_to_the_ui() {
        let err = refusal("sign in", refused(server::CODE_REQUIRED));
        assert_eq!(err.code, CommandErrorCode::Refused);
        assert_eq!(err.reason.as_deref(), Some("totp_required"));
        assert_eq!(err.message, "sign in: in words");
    }

    #[test]
    fn refusal_says_when_the_server_could_not_be_asked() {
        let err = refusal("sign in", ServerError::Connection("no route".into()));
        assert_eq!(err.reason.as_deref(), Some(REASON_UNREACHABLE));
        // Anything else is passed on as it came, with no reason to act on.
        let err = refusal("sign in", ServerError::Encryption("bad key"));
        assert_eq!(err.code, CommandErrorCode::Unknown);
        assert_eq!(err.reason, None);
        assert_eq!(err.message, "sign in: bad key");
    }

    #[test]
    fn reason_is_left_out_of_an_error_that_has_none() {
        let plain = serde_json::to_value(CommandError::task("boom")).unwrap();
        assert_eq!(
            plain,
            serde_json::json!({ "code": "task", "message": "boom" })
        );
        let with = serde_json::to_value(CommandError::refused("totp_invalid", "no")).unwrap();
        assert_eq!(
            with,
            serde_json::json!({ "code": "refused", "message": "no", "reason": "totp_invalid" })
        );
    }

    #[test]
    fn empty_code_field_sends_no_code() {
        assert_eq!(typed(None), None);
        assert_eq!(typed(Some("")), None);
        assert_eq!(typed(Some("   ")), None);
        assert_eq!(typed(Some(" 123456 ")), Some("123456"));
    }

    #[test]
    fn ended_session_is_told_from_other_refusals() {
        assert!(session_is_over(&refused(server::SESSION_ENDED)));
        assert!(session_is_over(&refused(server::USER_DISABLED)));
        // A wrong password or code says nothing about the session.
        assert!(!session_is_over(&refused(server::WRONG_PASSWORD)));
        assert!(!session_is_over(&refused(server::CODE_INVALID)));
        assert!(!session_is_over(&ServerError::Connection("down".into())));
    }

    #[test]
    fn mistyped_recovery_key_is_caught_before_the_server_is_asked() {
        let err = parse_recovery_key("ABCD-EFGH").unwrap_err();
        assert_eq!(err.reason.as_deref(), Some(REASON_NOT_A_RECOVERY_KEY));
        let key = RecoveryKey::generate().to_string();
        assert!(parse_recovery_key(&key.to_lowercase()).is_ok());
    }

    #[test]
    fn qr_code_is_an_svg_in_black_on_white() {
        let svg = qr_svg("otpauth://totp/Mindstream:ann?secret=JBSWY3DPEHPK3PXP").unwrap();
        assert!(svg.starts_with("<?xml") || svg.starts_with("<svg"));
        assert!(svg.contains("#000000"));
        assert!(svg.contains("#ffffff"));
        // Nothing in it runs.
        assert!(!svg.contains("<script"));
    }

    #[test]
    fn info_address_sits_under_the_servers_own() {
        let at = |base: &str| info_url(base).unwrap().to_string();
        assert_eq!(
            at("https://notes.example.com"),
            "https://notes.example.com/api/v1/mindstream/info/"
        );
        assert_eq!(
            at("https://example.com/notes?x=1#y"),
            "https://example.com/notes/api/v1/mindstream/info/"
        );
        assert!(info_url("ftp://example.com").is_err());
        assert!(info_url("not a url").is_err());
    }

    #[test]
    fn server_info_is_read_and_anything_else_is_not_a_server() {
        let body =
            br#"{"server":"mindstream-server","version":"0.1.0","protocol":1,"signup":"invite"}"#;
        assert_eq!(
            parse_server_info(200, body).unwrap(),
            ServerInfo {
                signup: "invite".into(),
                protocol: 1,
                version: "0.1.0".into(),
            }
        );
        let not = |status, body: &[u8]| parse_server_info(status, body).unwrap_err().reason;
        assert_eq!(not(404, b"Not found").as_deref(), Some(REASON_NOT_A_SERVER));
        assert_eq!(
            not(200, b"<html>hello</html>").as_deref(),
            Some(REASON_NOT_A_SERVER)
        );
        for body in [
            br#"{"version":"0.1.0","protocol":1,"signup":"open"}"#.as_slice(),
            br#"{"server":"other","version":"0.1.0","protocol":1,"signup":"open"}"#,
            br#"{"server":"mindstream-server","version":"","protocol":1,"signup":"open"}"#,
            br#"{"server":"mindstream-server","version":"0.1.0","signup":"open"}"#,
            br#"{"server":"mindstream-server","version":"0.1.0","protocol":"1","signup":"open"}"#,
        ] {
            assert_eq!(not(200, body).as_deref(), Some(REASON_NOT_A_SERVER));
        }
    }

    #[test]
    fn compatibility_depends_on_protocol_not_release_version() {
        for version in ["0.1.0", "0.2.0", "2.0.0"] {
            let body = format!(
                r#"{{"server":"mindstream-server","version":"{version}","protocol":1,"signup":"open"}}"#
            );
            assert!(parse_server_info(200, body.as_bytes()).is_ok());
        }
        for (protocol, reason) in [
            (0, "server_protocol_too_old"),
            (2, "server_protocol_too_new"),
        ] {
            let body = format!(
                r#"{{"server":"mindstream-server","version":"0.1.0","protocol":{protocol},"signup":"open"}}"#
            );
            let err = parse_server_info(200, body.as_bytes()).unwrap_err();
            assert_eq!(err.reason.as_deref(), Some(reason));
            assert!(err.message.contains(&format!("protocol {protocol}")));
        }
    }
}
