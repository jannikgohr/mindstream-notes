//! Remembering the public keys of the people a user shares with.
//!
//! Every public key comes from the server: a recipient's when a folder is
//! shared with them, a sender's with their invitation. A server that handed
//! out a key of its own could read what is shared with someone, or stand in
//! for a sender. Nothing proves a key the first time it is seen, so the
//! first key seen for a name is kept, and a different one later is refused
//! until the user has said to go on. The fingerprint is what two people
//! compare, over another channel, to be sure.
//!
//! An invite link needs none of this. Its content is sealed to a key that
//! only the link's holders can derive, so the server could not have made it.

use reqwest::Url;

use super::*;
use crate::error::CommandError;

/// A key that is not the one remembered for its owner.
pub(crate) const REASON_KEY_CHANGED: &str = "key_changed";

/// How a key stands against what this device remembers for its owner.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KeyStanding {
    /// No key is remembered for this name yet.
    New,
    /// The key is the one remembered.
    Known,
    /// Another key is remembered for this name.
    Changed,
}

/// A user's key, with what someone needs to check it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct UserKey {
    pub username: String,
    pub standing: KeyStanding,
    /// The key the server gives now, as digits two people can compare.
    pub fingerprint: String,
    /// The key remembered, when it is another one.
    pub known_fingerprint: Option<String>,
}

/// A server's address written one way. A name is only one person on one
/// server, so a key is remembered for a name on a server.
pub(super) fn server_id(server_url: &str) -> String {
    let text = server_url.trim();
    let Ok(url) = Url::parse(text) else {
        return text.to_ascii_lowercase();
    };
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    // `port()` is `None` for a scheme's own port, written out or not.
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    format!(
        "{}://{host}{port}{}",
        url.scheme(),
        url.path().trim_end_matches('/')
    )
}

/// Names are compared without regard to case, as the server compares them.
fn name_id(username: &str) -> String {
    username.trim().to_lowercase()
}

fn remembered(conn: &Connection, server_url: &str, username: &str) -> AppResult<Option<Vec<u8>>> {
    Ok(conn
        .query_row(
            "SELECT pubkey FROM known_keys WHERE server = ?1 AND username = ?2",
            params![server_id(server_url), name_id(username)],
            |row| row.get(0),
        )
        .optional()?)
}

pub(super) fn key_standing(
    conn: &Connection,
    server_url: &str,
    username: &str,
    pubkey: &[u8],
) -> AppResult<KeyStanding> {
    Ok(match remembered(conn, server_url, username)? {
        None => KeyStanding::New,
        Some(known) if known == pubkey => KeyStanding::Known,
        Some(_) => KeyStanding::Changed,
    })
}

/// Keep `pubkey` as the key of `username`, in place of any other. Called
/// once something was shared with or accepted from that key, which is the
/// moment the user relied on it.
pub(super) fn remember_key(
    conn: &Connection,
    server_url: &str,
    username: &str,
    pubkey: &[u8],
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO known_keys (server, username, pubkey, first_seen)
              VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(server, username) DO UPDATE
                SET pubkey = excluded.pubkey, first_seen = excluded.first_seen
              WHERE pubkey IS NOT excluded.pubkey",
        params![
            server_id(server_url),
            name_id(username),
            pubkey,
            Utc::now().to_rfc3339()
        ],
    )?;
    Ok(())
}

/// A key and how it stands, for showing to the user.
pub(super) fn user_key(
    conn: &Connection,
    server_url: &str,
    username: &str,
    pubkey: &[u8],
) -> AppResult<UserKey> {
    let known = remembered(conn, server_url, username)?;
    let standing = match &known {
        None => KeyStanding::New,
        Some(known) if known == pubkey => KeyStanding::Known,
        Some(_) => KeyStanding::Changed,
    };
    Ok(UserKey {
        username: username.trim().to_string(),
        standing,
        fingerprint: etebase::pretty_fingerprint(pubkey),
        known_fingerprint: known
            .filter(|_| standing == KeyStanding::Changed)
            .map(|known| etebase::pretty_fingerprint(&known)),
    })
}

/// Refuse a key that is not the one remembered, unless the user has seen
/// that it changed and said to go on.
pub(super) fn check_key(
    db: &Db,
    server_url: &str,
    username: &str,
    pubkey: &[u8],
    trust_changed: bool,
) -> Result<(), CommandError> {
    if trust_changed {
        return Ok(());
    }
    let standing = db.with_conn(|conn| key_standing(conn, server_url, username, pubkey))?;
    if standing != KeyStanding::Changed {
        return Ok(());
    }
    Err(CommandError::refused(
        REASON_KEY_CHANGED,
        format!(
            "the key of {} is not the one this device remembers",
            username.trim()
        ),
    ))
}

/// The key the server gives for a user now, held against the one this
/// device remembers. For showing someone what changed before they decide.
#[tauri::command]
pub async fn user_key_info(app: AppHandle, username: String) -> CommandResult<UserKey> {
    tauri::async_runtime::spawn_blocking(move || -> CommandResult<UserKey> {
        let account = restore_required(&app)?;
        let server = session_server(&app)?;
        let name = username.trim();
        if name.is_empty() {
            return Err(AppError::InvalidArg("a username is required".into()).into());
        }
        let profile = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?
            .fetch_user_profile(name)
            .map_err(|e| profile_lookup_error(name, &e))?;
        let db = app.state::<Db>();
        Ok(db.with_conn(|conn| user_key(conn, &server, name, profile.pubkey()))?)
    })
    .await
    .map_err(|e| CommandError::task(format!("user key info task: {e}")))?
}

/// This account's own key as digits, for someone else to compare with what
/// their app shows for this account.
#[tauri::command]
pub async fn own_key_fingerprint(app: AppHandle) -> CommandResult<String> {
    tauri::async_runtime::spawn_blocking(move || -> CommandResult<String> {
        let account = restore_required(&app)?;
        let manager = account
            .invitation_manager()
            .map_err(|e| AppError::InvalidArg(format!("invitation_manager: {e}")))?;
        Ok(etebase::pretty_fingerprint(manager.pubkey()))
    })
    .await
    .map_err(|e| CommandError::task(format!("own key fingerprint task: {e}")))?
}

/// Test-only: make this device remember another key for a user, as it would
/// if the server had handed out a different one before. The suite uses it
/// to reach the changed-key path without making an account twice.
#[cfg(feature = "e2e-data-dir")]
#[tauri::command]
pub async fn e2e_remember_other_key(app: AppHandle, username: String) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || -> CommandResult<()> {
        let server = session_server(&app)?;
        let db = app.state::<Db>();
        db.with_conn(|conn| remember_key(conn, &server, &username, &[0xE2; 32]))?;
        Ok(())
    })
    .await
    .map_err(|e| CommandError::task(format!("remember other key task: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVER: &str = "https://notes.example.com/";
    const KEY_ONE: &[u8] = &[1; 32];
    const KEY_TWO: &[u8] = &[2; 32];

    #[test]
    fn first_key_seen_is_new_then_known() {
        let db = crate::db::open_memory_for_tests();
        db.with_conn(|conn| {
            assert_eq!(
                key_standing(conn, SERVER, "ann", KEY_ONE)?,
                KeyStanding::New
            );
            // Looking at a key does not keep it. Relying on it does.
            assert_eq!(
                key_standing(conn, SERVER, "ann", KEY_ONE)?,
                KeyStanding::New
            );

            remember_key(conn, SERVER, "ann", KEY_ONE)?;
            assert_eq!(
                key_standing(conn, SERVER, "ann", KEY_ONE)?,
                KeyStanding::Known
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn another_key_for_the_same_name_has_changed() {
        let db = crate::db::open_memory_for_tests();
        db.with_conn(|conn| {
            remember_key(conn, SERVER, "ann", KEY_ONE)?;

            assert_eq!(
                key_standing(conn, SERVER, "ann", KEY_TWO)?,
                KeyStanding::Changed
            );
            // Seeing the other key changes nothing about what is remembered.
            assert_eq!(
                key_standing(conn, SERVER, "ann", KEY_ONE)?,
                KeyStanding::Known
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn name_is_one_person_whatever_its_case() {
        let db = crate::db::open_memory_for_tests();
        db.with_conn(|conn| {
            remember_key(conn, SERVER, "Ann", KEY_ONE)?;

            assert_eq!(
                key_standing(conn, SERVER, " ann ", KEY_ONE)?,
                KeyStanding::Known
            );
            assert_eq!(
                key_standing(conn, SERVER, "ANN", KEY_TWO)?,
                KeyStanding::Changed
            );
            assert_eq!(
                key_standing(conn, SERVER, "anna", KEY_TWO)?,
                KeyStanding::New
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn same_name_on_another_server_is_someone_else() {
        let db = crate::db::open_memory_for_tests();
        db.with_conn(|conn| {
            remember_key(conn, SERVER, "ann", KEY_ONE)?;

            assert_eq!(
                key_standing(conn, "https://other.example.com/", "ann", KEY_TWO)?,
                KeyStanding::New
            );
            // One server, written three ways.
            for same in [
                "https://notes.example.com",
                "https://Notes.Example.com/",
                "https://notes.example.com:443/",
            ] {
                assert_eq!(
                    key_standing(conn, same, "ann", KEY_TWO)?,
                    KeyStanding::Changed,
                    "{same}"
                );
            }
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn server_is_written_one_way() {
        for (written, id) in [
            ("https://notes.example.com", "https://notes.example.com"),
            ("https://Notes.Example.com/", "https://notes.example.com"),
            (
                "https://notes.example.com:443/",
                "https://notes.example.com",
            ),
            ("http://localhost:3735/", "http://localhost:3735"),
            ("https://example.com/notes/", "https://example.com/notes"),
            (" Not A Url ", "not a url"),
        ] {
            assert_eq!(server_id(written), id, "{written}");
        }
        assert_ne!(
            server_id("https://notes.example.com/"),
            server_id("http://notes.example.com/")
        );
    }

    #[test]
    fn trusting_a_changed_key_replaces_the_old_one() {
        let db = crate::db::open_memory_for_tests();
        db.with_conn(|conn| {
            remember_key(conn, SERVER, "ann", KEY_ONE)?;
            remember_key(conn, SERVER, "ann", KEY_TWO)?;

            assert_eq!(
                key_standing(conn, SERVER, "ann", KEY_TWO)?,
                KeyStanding::Known
            );
            assert_eq!(
                key_standing(conn, SERVER, "ann", KEY_ONE)?,
                KeyStanding::Changed
            );
            let rows: i64 =
                conn.query_row("SELECT COUNT(*) FROM known_keys", [], |row| row.get(0))?;
            assert_eq!(rows, 1);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn remembering_the_same_key_again_keeps_when_it_was_first_seen() {
        let db = crate::db::open_memory_for_tests();
        db.with_conn(|conn| {
            remember_key(conn, SERVER, "ann", KEY_ONE)?;
            conn.execute("UPDATE known_keys SET first_seen = 'then'", [])?;

            remember_key(conn, SERVER, "ann", KEY_ONE)?;

            let seen: String =
                conn.query_row("SELECT first_seen FROM known_keys", [], |row| row.get(0))?;
            assert_eq!(seen, "then");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn changed_key_is_refused_until_it_is_trusted() {
        let db = crate::db::open_memory_for_tests();
        // Nothing remembered, and the key remembered, both pass.
        assert!(check_key(&db, SERVER, "ann", KEY_ONE, false).is_ok());
        db.with_conn(|conn| remember_key(conn, SERVER, "ann", KEY_ONE))
            .unwrap();
        assert!(check_key(&db, SERVER, "ann", KEY_ONE, false).is_ok());

        let refused = check_key(&db, SERVER, "ann", KEY_TWO, false).unwrap_err();
        assert_eq!(refused.reason.as_deref(), Some(REASON_KEY_CHANGED));
        assert!(refused.message.contains("ann"));

        assert!(check_key(&db, SERVER, "ann", KEY_TWO, true).is_ok());
        // Being let through keeps nothing by itself.
        let standing = db
            .with_conn(|conn| key_standing(conn, SERVER, "ann", KEY_TWO))
            .unwrap();
        assert_eq!(standing, KeyStanding::Changed);
    }

    #[test]
    fn user_key_shows_both_fingerprints_only_when_they_differ() {
        let db = crate::db::open_memory_for_tests();
        db.with_conn(|conn| {
            let new = user_key(conn, SERVER, " ann ", KEY_ONE)?;
            assert_eq!(new.username, "ann");
            assert_eq!(new.standing, KeyStanding::New);
            assert_eq!(new.fingerprint, etebase::pretty_fingerprint(KEY_ONE));
            assert_eq!(new.known_fingerprint, None);

            remember_key(conn, SERVER, "ann", KEY_ONE)?;
            let known = user_key(conn, SERVER, "ann", KEY_ONE)?;
            assert_eq!(known.standing, KeyStanding::Known);
            assert_eq!(known.known_fingerprint, None);

            let changed = user_key(conn, SERVER, "ann", KEY_TWO)?;
            assert_eq!(changed.standing, KeyStanding::Changed);
            assert_eq!(changed.fingerprint, etebase::pretty_fingerprint(KEY_TWO));
            assert_eq!(
                changed.known_fingerprint,
                Some(etebase::pretty_fingerprint(KEY_ONE))
            );
            assert_ne!(changed.fingerprint, changed.known_fingerprint.unwrap());
            Ok(())
        })
        .unwrap();
    }
}
