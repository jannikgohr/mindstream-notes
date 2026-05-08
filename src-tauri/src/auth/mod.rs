//! Etebase authentication: login, logout, and session restore.
//!
//! The user's password is **never** persisted. After a successful
//! `Account::login`, we generate a random 32-byte key, encrypt the saved
//! account state with it via `Account::save(Some(&key))`, then split the
//! result across two stores:
//!
//!   * the encryption key lives in the OS keystore (Windows Credential
//!     Manager / macOS Keychain / Linux Secret Service) under
//!     `mindstream-notes / etebase-session-key`;
//!   * the encrypted blob plus the username + server URL lives in
//!     `<app_data>/etebase.session` as JSON.
//!
//! Both pieces are required to unlock the session. A leak of the on-disk
//! file alone yields nothing without the keystore entry.

use std::fs;
use std::path::{Path, PathBuf};

use etebase::utils::{from_base64, randombytes, to_base64};
use etebase::{Account, Client};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

const KEYRING_SERVICE: &str = "mindstream-notes";
const KEYRING_ACCOUNT: &str = "etebase-session-key";
const SESSION_FILENAME: &str = "etebase.session";
const CLIENT_NAME: &str = "mindstream-notes";
const MANAGED_SERVER_URL: &str = "https://api.etebase.com/";

#[derive(Debug, Serialize, Deserialize)]
struct StoredSession {
    username: String,
    server_url: String,
    /// Output of `Account::save(Some(&key))`. Already encrypted.
    blob: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginArgs {
    /// "managed" | "self-hosted". Anything else is rejected.
    pub server_type: String,
    /// Required when `server_type == "self-hosted"`.
    pub server_url: Option<String>,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct SessionInfo {
    pub username: String,
    pub server_url: String,
}

fn session_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::InvalidArg(format!("app_data_dir: {e}")))?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join(SESSION_FILENAME))
}

fn keyring_entry() -> AppResult<Entry> {
    Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| AppError::InvalidArg(format!("keyring: {e}")))
}

fn resolve_server_url(args: &LoginArgs) -> AppResult<String> {
    match args.server_type.as_str() {
        "managed" => Ok(MANAGED_SERVER_URL.to_string()),
        "self-hosted" => args
            .server_url
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::InvalidArg("server URL is required for self-hosted".into())),
        other => Err(AppError::InvalidArg(format!(
            "unknown server type: {other}"
        ))),
    }
}

fn read_stored(path: &Path) -> AppResult<Option<StoredSession>> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read(path)?;
    let stored: StoredSession = serde_json::from_slice(&raw)
        .map_err(|e| AppError::InvalidArg(format!("session file corrupt: {e}")))?;
    Ok(Some(stored))
}

fn restore_account(stored: &StoredSession) -> AppResult<Account> {
    let key_b64 = keyring_entry()?
        .get_password()
        .map_err(|e| AppError::InvalidArg(format!("keyring read: {e}")))?;
    let key =
        from_base64(&key_b64).map_err(|e| AppError::InvalidArg(format!("keyring decode: {e}")))?;
    let client = Client::new(CLIENT_NAME, &stored.server_url)
        .map_err(|e| AppError::InvalidArg(format!("etebase client: {e}")))?;
    Account::restore(client, &stored.blob, Some(&key))
        .map_err(|e| AppError::InvalidArg(format!("etebase restore: {e}")))
}

fn clear_local_state(path: &Path) {
    let _ = fs::remove_file(path);
    if let Ok(entry) = keyring_entry() {
        let _ = entry.delete_credential();
    }
}

/// Re-hydrate the Etebase `Account` from the on-disk session blob and the
/// OS-keystore-held encryption key. Cheap (no Argon2id) — sync calls this
/// on every cycle rather than caching the live Account, which would
/// require a `Mutex<Option<Account>>` in app state.
///
/// `Ok(None)` means "user is signed out"; an `Err` means we *thought* there
/// was a session but couldn't unlock it (corrupt file, missing keychain
/// entry, server URL invalid, …).
pub fn try_restore(app: &AppHandle) -> AppResult<Option<Account>> {
    let path = session_path(app)?;
    let Some(stored) = read_stored(&path)? else {
        return Ok(None);
    };
    Ok(Some(restore_account(&stored)?))
}

#[tauri::command]
pub async fn etebase_login(args: LoginArgs, app: AppHandle) -> Result<SessionInfo, String> {
    let server_url = resolve_server_url(&args).map_err(String::from)?;
    let path = session_path(&app).map_err(String::from)?;

    let username = args.username.clone();
    let password = args.password;
    let server_for_login = server_url.clone();

    // Argon2id key derivation runs inside login — keep it off the async runtime.
    let account = tauri::async_runtime::spawn_blocking(move || {
        let client = Client::new(CLIENT_NAME, &server_for_login)
            .map_err(|e| format!("etebase client: {e}"))?;
        Account::login(client, &username, &password).map_err(|e| format!("login: {e}"))
    })
    .await
    .map_err(|e| format!("login task: {e}"))??;

    let key = randombytes(32);
    let blob = account
        .save(Some(&key))
        .map_err(|e| format!("save session: {e}"))?;
    let key_b64 = to_base64(&key).map_err(|e| format!("encode key: {e}"))?;

    keyring_entry()
        .map_err(String::from)?
        .set_password(&key_b64)
        .map_err(|e| format!("keyring write: {e}"))?;

    let stored = StoredSession {
        username: args.username.clone(),
        server_url: server_url.clone(),
        blob,
    };
    let bytes = serde_json::to_vec(&stored).map_err(|e| e.to_string())?;
    if let Err(e) = fs::write(&path, bytes) {
        // Roll back the keyring write so we don't leave half a session behind.
        if let Ok(entry) = keyring_entry() {
            let _ = entry.delete_credential();
        }
        return Err(format!("write session: {e}"));
    }

    Ok(SessionInfo {
        username: args.username,
        server_url,
    })
}

#[tauri::command]
pub async fn etebase_logout(app: AppHandle) -> Result<(), String> {
    let path = session_path(&app).map_err(String::from)?;
    let stored = read_stored(&path).map_err(String::from)?;

    if let Some(stored) = stored {
        // Best effort: notify the server so the auth token is revoked. If
        // restore or logout fails (offline, key missing, server gone) we
        // still wipe local state below — that's the user's clear intent.
        if let Ok(account) = restore_account(&stored) {
            let _ = tauri::async_runtime::spawn_blocking(move || account.logout()).await;
        }
    }

    clear_local_state(&path);
    Ok(())
}

#[tauri::command]
pub async fn etebase_session(app: AppHandle) -> Result<Option<SessionInfo>, String> {
    let path = session_path(&app).map_err(String::from)?;
    let Some(stored) = read_stored(&path).map_err(String::from)? else {
        return Ok(None);
    };
    Ok(Some(SessionInfo {
        username: stored.username,
        server_url: stored.server_url,
    }))
}
