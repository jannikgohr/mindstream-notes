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
use std::time::Duration;

use etebase::utils::{from_base64, randombytes, to_base64};
use etebase::{Account, Client};
use keyring_core::Entry;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::db::Db;
use crate::error::{AppError, AppResult};

const KEYRING_SERVICE: &str = "mindstream-notes";
const KEYRING_ACCOUNT: &str = "etebase-session-key";
const SESSION_FILENAME: &str = "etebase.session";
const CLIENT_NAME: &str = "mindstream-notes";
const MANAGED_SERVER_URL: &str = "https://api.etebase.com/";
/// Timeout for the pre-sync reachability probe. Short: it only proves the
/// connection can be opened, and a doomed sync shouldn't stall behind a
/// long connect timeout every scheduler tick while offline.
const REACHABILITY_TIMEOUT_SECS: u64 = 6;

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

#[derive(Debug, Serialize)]
pub struct ServerCheckResult {
    pub ok: bool,
    pub status: u16,
    pub url: String,
}

fn session_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = crate::paths::app_data_dir(app)?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join(SESSION_FILENAME))
}

/// Keyring account key for a profile. The `"default"` profile keeps the
/// historical un-namespaced key so an existing session survives the
/// upgrade to the profiles layout; every other profile namespaces with
/// its id so each has its own isolated Etebase credentials.
fn keyring_account_name(profile_id: &str) -> String {
    if profile_id == crate::profiles::DEFAULT_PROFILE_ID {
        KEYRING_ACCOUNT.to_string()
    } else {
        format!("{KEYRING_ACCOUNT}::{profile_id}")
    }
}

/// Resolve the keyring account key for the currently-active profile.
/// Falls back to the default (un-namespaced) key if profile state isn't
/// managed yet — matches the boot fallback in [`crate::paths`].
fn active_keyring_account(app: &AppHandle) -> String {
    let id = app
        .try_state::<crate::paths::ActiveProfile>()
        .map(|p| p.id.clone())
        .unwrap_or_else(|| crate::profiles::DEFAULT_PROFILE_ID.to_string());
    keyring_account_name(&id)
}

fn keyring_entry(account: &str) -> AppResult<Entry> {
    Entry::new(KEYRING_SERVICE, account).map_err(|e| AppError::InvalidArg(format!("keyring: {e}")))
}

/// Best-effort removal of a profile's stored Etebase session key. Called
/// when a vault is deleted so its credential doesn't outlive its data.
/// Silent on any failure — the entry may simply not exist (the vault was
/// never signed in).
pub fn forget_profile_keyring(profile_id: &str) {
    if let Ok(entry) = keyring_entry(&keyring_account_name(profile_id)) {
        let _ = entry.delete_credential();
    }
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

fn health_url(server_url: &str) -> AppResult<Url> {
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
    url.join("healthz")
        .map_err(|e| AppError::InvalidArg(format!("health URL: {e}")))
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

fn restore_account(stored: &StoredSession, keyring_account: &str) -> AppResult<Account> {
    let key_b64 = keyring_entry(keyring_account)?
        .get_password()
        .map_err(|e| AppError::InvalidArg(format!("keyring read: {e}")))?;
    let key =
        from_base64(&key_b64).map_err(|e| AppError::InvalidArg(format!("keyring decode: {e}")))?;
    let client = Client::new(CLIENT_NAME, &stored.server_url)
        .map_err(|e| AppError::InvalidArg(format!("etebase client: {e}")))?;
    Account::restore(client, &stored.blob, Some(&key))
        .map_err(|e| AppError::InvalidArg(format!("etebase restore: {e}")))
}

fn clear_local_state(path: &Path, keyring_account: &str) {
    let _ = fs::remove_file(path);
    if let Ok(entry) = keyring_entry(keyring_account) {
        let _ = entry.delete_credential();
    }
}

/// Wipe **all** server-bound state so the next login starts from a
/// clean slate, regardless of whether the user signs back into the
/// same account or a different one.
///
/// What gets cleared:
///
///   * `sync_state` — per-kind stoken + cached collection UID. Tied
///     to whichever server we were just on. Surviving this across
///     logout produced the original `bad_stoken` error when signing
///     in to a different server.
///   * `tombstones` — queued server-side deletes. Reference UIDs on
///     the old server that don't exist on the new one.
///   * per-row `etebase_uid` / `etebase_etag` on notes, collections,
///     assets — point at items on the old server that aren't there
///     on the new one. Pushing dirty rows with stale UIDs is the
///     "fetch note <uid>: Server error" failure: push_notes tries to
///     update an item that doesn't exist.
///
/// Every row also gets `dirty = 1` so the next sync pushes a fresh
/// copy of everything to whatever server the user logs into. The
/// built-in `trash` collection stays clean — it's a local-only
/// construct that's never pushed.
///
/// Trade-off: if the user logs out and back in to the **same**
/// account, this re-pushes every note as a new item, producing
/// duplicates on the server. That's the lesser evil compared to the
/// alternative — silent "my notes vanished" on a server switch.
/// Recovery from duplicates is straightforward; recovery from
/// vanished notes is not.
fn reset_sync_cursors(db: &Db) -> AppResult<()> {
    db.with_conn_mut(|c| {
        let tx = c.transaction()?;
        tx.execute("DELETE FROM sync_state", [])?;
        tx.execute("DELETE FROM tombstones", [])?;
        // Strip server-side identifiers from every row so the next
        // sync treats them as freshly-created locally.
        tx.execute(
            "UPDATE notes SET etebase_uid = NULL, etebase_etag = NULL, dirty = 1",
            [],
        )?;
        tx.execute(
            "UPDATE collections SET etebase_uid = NULL, etebase_etag = NULL, dirty = 1
             WHERE id != 'trash'",
            [],
        )?;
        tx.execute(
            "UPDATE assets SET etebase_uid = NULL, etebase_etag = NULL, dirty = 1",
            [],
        )?;
        tx.commit()?;
        Ok(())
    })
}

/// Re-hydrate the Etebase `Account` from the on-disk session blob and the
/// OS-keystore-held encryption key. Cheap (no Argon2id) — sync calls this
/// on every cycle rather than caching the live Account, which would
/// require a `Mutex<Option<Account>>` in app state.
///
/// `Ok(None)` means "user is signed out"; an `Err` means we *thought* there
/// was a session but couldn't unlock it (corrupt file, missing keychain
/// entry, server URL invalid, …).
/// Friendly identifiers for the currently-signed-in account, read
/// from the on-disk session file without touching the keyring. Used by
/// the backup module to stamp username + server URL into the manifest
/// — we only need the bytes the JSON file already holds, no decrypted
/// `Account` and no Etebase round-trip. Returns `None` for signed-out
/// installs.
pub fn read_session_info(app: &AppHandle) -> AppResult<Option<SessionInfo>> {
    let path = session_path(app)?;
    let Some(stored) = read_stored(&path)? else {
        return Ok(None);
    };
    Ok(Some(SessionInfo {
        username: stored.username,
        server_url: stored.server_url,
    }))
}

pub fn try_restore(app: &AppHandle) -> AppResult<Option<Account>> {
    let path = session_path(app)?;
    let Some(stored) = read_stored(&path)? else {
        return Ok(None);
    };
    let account = active_keyring_account(app);
    Ok(Some(restore_account(&stored, &account)?))
}

/// Cheap presence check: true iff both halves of a session — the on-disk
/// session blob and the keyring-held wrapper key — exist. Does not
/// attempt to decrypt the blob (would require a network-capable
/// `Client::new`, which we want to avoid on hot paths like
/// `note_room_info`). Both pieces are required to actually unlock the
/// session, so their joint presence is the right gate for "is a user
/// signed in?".
pub fn has_session(app: &AppHandle) -> bool {
    let Ok(path) = session_path(app) else {
        return false;
    };
    if !path.exists() {
        return false;
    }
    let Ok(entry) = keyring_entry(&active_keyring_account(app)) else {
        return false;
    };
    entry.get_password().is_ok()
}

#[tauri::command]
pub async fn etebase_login(args: LoginArgs, app: AppHandle) -> Result<SessionInfo, String> {
    let server_url = resolve_server_url(&args).map_err(String::from)?;
    let path = session_path(&app).map_err(String::from)?;
    let keyring_account = active_keyring_account(&app);

    let username = args.username.clone();
    let password = args.password;
    let server_for_login = server_url.clone();

    // Argon2id key derivation runs inside login — and reqwest's blocking
    // HTTP path constructs a private tokio runtime per Account. Keep the
    // whole etebase dance (login + save + Account drop) inside one
    // spawn_blocking so the runtime is never dropped on an async worker,
    // which would panic with "Cannot drop a runtime in a context where
    // blocking is not allowed".
    let key = randombytes(32);
    let key_for_save = key.clone();
    let blob = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let client = Client::new(CLIENT_NAME, &server_for_login)
            .map_err(|e| format!("etebase client: {e}"))?;
        let account =
            Account::login(client, &username, &password).map_err(|e| format!("login: {e}"))?;
        account
            .save(Some(&key_for_save))
            .map_err(|e| format!("save session: {e}"))
    })
    .await
    .map_err(|e| format!("login task: {e}"))??;
    let key_b64 = to_base64(&key).map_err(|e| format!("encode key: {e}"))?;

    keyring_entry(&keyring_account)
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
        if let Ok(entry) = keyring_entry(&keyring_account) {
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
    let keyring_account = active_keyring_account(&app);

    if let Some(stored) = stored {
        // Both `restore_account` and `account.logout()` end up
        // constructing tokio runtimes inside reqwest's blocking client.
        // Dropping such a runtime from an async context panics — tokio
        // refuses to block-wait for its worker threads on an async
        // worker. Doing the whole etebase-side dance inside one
        // spawn_blocking keeps every runtime construction *and* drop
        // pinned to the blocking pool, where blocking is allowed.
        //
        // Best-effort: if restore or logout fails (offline, key missing,
        // server gone) we still wipe local state below — that's the
        // user's clear intent.
        let keyring_account = keyring_account.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let account = restore_account(&stored, &keyring_account)
                .map_err(|e| format!("restore session: {e}"))?;
            account.logout().map_err(|e| format!("logout: {e}"))?;
            Ok(())
        })
        .await;
    }

    // Nothing key-shaped needs wiping locally: the crypto_key column
    // was removed in migration v7. note_room_info now fetches the key
    // directly from etebase each time a note is opened, so logging out
    // (which deletes the keyring entry below) makes those fetches fail
    // immediately and the editor falls back to single-device mode.
    clear_local_state(&path, &keyring_account);

    // Drop sync cursors after the session file is gone, so a crash here
    // leaves the user in a "no session, no cursors" state rather than
    // "no session, stale cursors" (which is the bug we're fixing).
    // Best-effort: the user clearly intended to log out, so we don't
    // want a DB hiccup to turn into a logout failure they have to
    // retry. Worst case: pull_folders self-heals from bad_stoken on
    // the next login.
    if let Some(db) = app.try_state::<Db>() {
        if let Err(err) = reset_sync_cursors(db.inner()) {
            log::warn!("[auth] reset_sync_cursors on logout: {err}");
        }
    }

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

/// Probe whether `server_url` accepts connections at all. Any HTTP
/// response — even a 4xx/5xx — counts as reachable; only a transport
/// failure (DNS, connect, TLS, timeout) returns `Err`. Used as a
/// pre-sync guard so an unreachable self-hosted / VPN-gated server
/// surfaces as one clear "offline" signal instead of a storm of failed
/// sync requests. Hits the same `/healthz` path as
/// [`check_etebase_server_url`], unauthenticated, with a short timeout.
pub async fn probe_server_reachable(server_url: &str) -> Result<(), String> {
    let url = health_url(server_url).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REACHABILITY_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("reachability client: {e}"))?;
    client
        .get(url)
        .send()
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_etebase_server_url(server_url: String) -> Result<ServerCheckResult, String> {
    let url = health_url(&server_url).map_err(String::from)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("server check client: {e}"))?;
    let response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|e| format!("server check failed: {e}"))?;
    let status = response.status();
    Ok(ServerCheckResult {
        ok: status.is_success(),
        status: status.as_u16(),
        url: url.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory_for_tests;
    use rusqlite::params;

    /// Seed the DB to look like a device that successfully synced
    /// against a previous server: stoken rows, tombstones, and per-row
    /// etebase_uid/etag on a note, a collection, and an asset.
    fn seed_synced_state(db: &Db) {
        db.with_conn_mut(|c| {
            let tx = c.transaction().unwrap();
            tx.execute(
                "INSERT INTO sync_state (kind, etebase_collection_uid, stoken)
                 VALUES ('notes', 'old-col-notes', 'old-stoken-notes'),
                        ('folders', 'old-col-folders', 'old-stoken-folders')",
                [],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO tombstones (kind, etebase_uid, queued_at)
                 VALUES ('note', 'old-dead-note', '2025-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO notes (id, title, body, created, modified,
                                    etebase_uid, etebase_etag, dirty)
                 VALUES ('n1', 'Note', '', '2025-01-01', '2025-01-01',
                         'old-note-uid', 'old-note-etag', 0)",
                [],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO collections (id, name, parent_collection_id,
                                         created, modified,
                                         etebase_uid, etebase_etag, dirty)
                 VALUES ('c1', 'Folder', NULL, '2025-01-01', '2025-01-01',
                         'old-col-uid', 'old-col-etag', 0)",
                [],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO assets (id, owning_note_id, mime_type, bytes, size,
                                    created, modified,
                                    etebase_uid, etebase_etag, dirty)
                 VALUES ('a1', 'n1', 'image/png', X'89504E47', 4,
                         '2025-01-01', '2025-01-01',
                         'old-asset-uid', 'old-asset-etag', 0)",
                [],
            )
            .unwrap();
            tx.commit().unwrap();
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn reset_sync_cursors_wipes_server_side_state_and_re_dirties_rows() {
        let db = open_memory_for_tests();
        seed_synced_state(&db);

        reset_sync_cursors(&db).unwrap();

        db.with_conn(|c| {
            // Cursor tables emptied
            let sync_state_count: i64 = c
                .query_row("SELECT COUNT(*) FROM sync_state", [], |r| r.get(0))
                .unwrap();
            let tombstone_count: i64 = c
                .query_row("SELECT COUNT(*) FROM tombstones", [], |r| r.get(0))
                .unwrap();
            assert_eq!(sync_state_count, 0);
            assert_eq!(tombstone_count, 0);

            // Per-row server identifiers cleared, rows marked dirty.
            for (table, id) in [("notes", "n1"), ("collections", "c1"), ("assets", "a1")] {
                let (uid, etag, dirty): (Option<String>, Option<String>, i64) = c
                    .query_row(
                        &format!(
                            "SELECT etebase_uid, etebase_etag, dirty
                             FROM {table} WHERE id = ?1"
                        ),
                        params![id],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .unwrap();
                assert_eq!(uid, None, "{table}.{id} etebase_uid should be NULL");
                assert_eq!(etag, None, "{table}.{id} etebase_etag should be NULL");
                assert_eq!(dirty, 1, "{table}.{id} should be marked dirty");
            }
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn default_profile_keeps_unnamespaced_keyring_key() {
        // Back-compat: a migrated single-vault install must keep finding
        // its existing keyring entry, so the default profile maps to the
        // historical un-namespaced account key.
        assert_eq!(keyring_account_name("default"), KEYRING_ACCOUNT);
    }

    #[test]
    fn non_default_profiles_namespace_the_keyring_key() {
        assert_eq!(
            keyring_account_name("work"),
            format!("{KEYRING_ACCOUNT}::work")
        );
        assert_ne!(keyring_account_name("work"), keyring_account_name("home"));
    }

    #[test]
    fn reset_sync_cursors_leaves_trash_collection_alone() {
        let db = open_memory_for_tests();
        // The trash row is inserted by migration v2; its dirty bit is
        // explicitly cleared by migration v4. We want to confirm
        // reset_sync_cursors doesn't disturb that — the trash
        // collection is a local-only construct and must never be
        // pushed to a server.
        reset_sync_cursors(&db).unwrap();
        db.with_conn(|c| {
            let dirty: i64 = c
                .query_row(
                    "SELECT dirty FROM collections WHERE id = 'trash'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(dirty, 0, "trash collection must stay clean after reset");
            Ok(())
        })
        .unwrap();
    }
}
