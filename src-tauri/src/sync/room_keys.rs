//! Room keys kept on the device, sealed.
//!
//! Every note carries a key in what the server stores for it, and the key
//! of the note's live room is derived from that. The device used to fetch
//! the note from the server each time it was opened, only to read the key
//! out of it: a request for the collection and one for the item, before the
//! one for the ticket. Yet every sync brings the same key along with the
//! note and used to throw it away.
//!
//! Now a sync keeps it, in a table of its own, sealed. Opening a note reads
//! it there and asks the server for the ticket alone.
//! A push can reuse it too, when the sealed item uid and revision match
//! the server's current revision. Older entries without that binding still
//! open rooms, but a push fetches their content to learn the current key.
//!
//! **What seals it.** The system's keystore already holds one secret for
//! the signed-in session, the one the saved session is encrypted under. The
//! key that seals room keys is derived from it. So:
//!
//! - A copy of the database is not enough to read a room key. It takes the
//!   keystore of this device, unlocked for this user, as well.
//! - Signing out deletes the secret, and with it the means to open any of
//!   them. An older version of the app dropped the stored keys for exactly
//!   this: a signed-out device should not be able to enter a room. That
//!   holds again without the fetches. The rows are deleted too.
//! - Signing in makes a new secret. The full sync that follows brings the
//!   keys again.
//!
//! **What it is not.** The device holds the notes themselves in the clear,
//! as it always has. This does not hide a note from someone who has the
//! database. It keeps the one thing that was not there before from being
//! there in a usable form.
//!
//! A key that cannot be opened is treated as one that is not there, and the
//! caller goes back to asking the server.

use std::collections::HashMap;
use std::fmt;

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use etebase::utils::randombytes;
use hkdf::Hkdf;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::db::Db;
use crate::error::{AppError, AppResult};

/// Says what the derived key is for, so that the session's secret is never
/// used directly for two things.
const SEAL_KEY_INFO: &[u8] = b"mindstream-room-key-seal/v1";
const NONCE_BYTES: usize = 24;

/// Seals and opens room keys for the session that is signed in.
pub struct Seal {
    cipher: XChaCha20Poly1305,
}

impl fmt::Debug for Seal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Seal(..)")
    }
}

impl Seal {
    /// The seal of a session, from the secret the keystore holds for it.
    pub fn from_session_secret(secret: &[u8]) -> AppResult<Self> {
        let mut key = [0_u8; 32];
        Hkdf::<Sha256>::new(None, secret)
            .expand(SEAL_KEY_INFO, &mut key)
            .map_err(|e| AppError::InvalidArg(format!("derive the room key seal: {e}")))?;
        Ok(Self {
            cipher: XChaCha20Poly1305::new((&key).into()),
        })
    }

    /// Seal a note's key. The note's id is bound in, so a sealed key moved
    /// to another note's row does not open.
    fn seal(&self, note_id: &str, key: &[u8]) -> AppResult<Vec<u8>> {
        let nonce = randombytes(NONCE_BYTES);
        let sealed = self
            .cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: key,
                    aad: note_id.as_bytes(),
                },
            )
            .map_err(|_| AppError::InvalidArg("seal a room key".into()))?;
        let mut out = nonce;
        out.extend_from_slice(&sealed);
        Ok(out)
    }

    /// The key, or `None` when this seal does not open what is stored:
    /// sealed by an earlier session, for another note, or damaged.
    fn open(&self, note_id: &str, sealed: &[u8]) -> Option<Vec<u8>> {
        if sealed.len() <= NONCE_BYTES {
            return None;
        }
        let (nonce, body) = sealed.split_at(NONCE_BYTES);
        self.cipher
            .decrypt(
                XNonce::from_slice(nonce),
                Payload {
                    msg: body,
                    aad: note_id.as_bytes(),
                },
            )
            .ok()
    }
}

/// The keys a sync came across, by note id, until the sync is over and they
/// are sealed. In memory only, and never printed.
#[derive(Default)]
pub struct Learned(HashMap<String, RevisionKey>);

/// The revision is sealed together with the key. A key learned for an
/// older revision must not overwrite one another device has since changed.
#[derive(Serialize, Deserialize)]
struct RevisionKey {
    uid: String,
    etag: String,
    key: Vec<u8>,
}

impl RevisionKey {
    fn for_revision(&self, uid: &str, etag: &str) -> Option<&[u8]> {
        (self.uid == uid && self.etag == etag && !self.key.is_empty())
            .then_some(self.key.as_slice())
    }
}

impl fmt::Debug for Learned {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Learned({} keys)", self.0.len())
    }
}

impl Learned {
    /// Remember the key a note was pulled or pushed with. A note from
    /// before live sessions has none, and that is not remembered.
    pub(super) fn note(&mut self, note_id: &str, key: &[u8], uid: &str, etag: &str) {
        if !key.is_empty() {
            self.0.insert(
                note_id.to_string(),
                RevisionKey {
                    uid: uid.to_string(),
                    etag: etag.to_string(),
                    key: key.to_vec(),
                },
            );
        }
    }

    pub(super) fn for_revision(&self, note_id: &str, uid: &str, etag: &str) -> Option<&[u8]> {
        self.0.get(note_id)?.for_revision(uid, etag)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// Seal and keep what a sync learned. Later entries for the same note win,
/// which is the order a sync learns them in: pulled, then pushed.
///
/// Without a seal nothing is kept and nothing is lost: the keys are on the
/// server, and opening a note asks for them there.
pub fn keep(db: &Db, seal: Option<&Seal>, learned: Learned) -> AppResult<usize> {
    let Some(seal) = seal else {
        return Ok(0);
    };
    if learned.is_empty() {
        return Ok(0);
    }
    db.with_conn_mut(|conn| {
        let tx = conn.transaction()?;
        let mut kept = 0;
        for (note_id, key) in &learned.0 {
            let bytes = rmp_serde::to_vec_named(key)
                .map_err(|e| AppError::InvalidArg(format!("encode room key revision: {e}")))?;
            kept += store(&tx, seal, note_id, &bytes)?;
        }
        tx.commit()?;
        Ok(kept)
    })
}

/// Keep one note's key. Nothing is written for a note this device has no
/// row for, such as one a sync pulled and then left with another space.
pub fn store(conn: &Connection, seal: &Seal, note_id: &str, key: &[u8]) -> AppResult<usize> {
    if key.is_empty() {
        return Ok(0);
    }
    let sealed = seal.seal(note_id, key)?;
    Ok(conn.execute(
        "INSERT INTO room_keys(note_id, sealed)
         SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM notes WHERE id = ?1)
         ON CONFLICT(note_id) DO UPDATE SET sealed = excluded.sealed",
        params![note_id, sealed],
    )?)
}

/// The key kept for a note, if there is one and this session can open it.
pub fn load(conn: &Connection, seal: &Seal, note_id: &str) -> AppResult<Option<Vec<u8>>> {
    Ok(load_sealed(conn, seal, note_id)?.and_then(|bytes| {
        // Older caches and keys fetched just to open a room have no
        // revision. They still open rooms, but cannot shortcut a push.
        if bytes.len() == 32 {
            Some(bytes)
        } else {
            rmp_serde::from_slice::<RevisionKey>(&bytes)
                .ok()
                .map(|entry| entry.key)
        }
    }))
}

pub(super) fn load_revision(
    conn: &Connection,
    seal: &Seal,
    note_id: &str,
    uid: &str,
    etag: &str,
) -> AppResult<Option<Vec<u8>>> {
    Ok(load_sealed(conn, seal, note_id)?.and_then(|bytes| {
        let entry: RevisionKey = rmp_serde::from_slice(&bytes).ok()?;
        entry.for_revision(uid, etag).map(<[u8]>::to_vec)
    }))
}

fn load_sealed(conn: &Connection, seal: &Seal, note_id: &str) -> AppResult<Option<Vec<u8>>> {
    let sealed: Option<Vec<u8>> = conn
        .query_row(
            "SELECT sealed FROM room_keys WHERE note_id = ?1",
            params![note_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(sealed.and_then(|sealed| seal.open(note_id, &sealed)))
}

/// Delete every key that is kept. For signing out, when none of them can be
/// opened any more, and for a copy of the database that is to leave the
/// device.
pub fn forget_all(conn: &Connection) -> AppResult<()> {
    conn.execute("DELETE FROM room_keys", [])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory_for_tests;

    const KEY: [u8; 32] = [7; 32];

    fn seal_of(secret: u8) -> Seal {
        Seal::from_session_secret(&[secret; 32]).unwrap()
    }

    fn note(db: &Db, id: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO notes(id, title, body, position, created, modified)
                 VALUES (?1, 'N', '', 0, 't', 't')",
                params![id],
            )?;
            Ok(())
        })
        .unwrap();
    }

    fn stored(db: &Db, id: &str) -> Option<Vec<u8>> {
        db.with_conn(|conn| {
            Ok(conn
                .query_row(
                    "SELECT sealed FROM room_keys WHERE note_id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .optional()?)
        })
        .unwrap()
    }

    #[test]
    fn sealed_key_opens_for_the_same_session_and_note_only() {
        let seal = seal_of(1);
        let sealed = seal.seal("note_a", &KEY).unwrap();

        assert_eq!(seal.open("note_a", &sealed).as_deref(), Some(&KEY[..]));
        // Not the key itself, and not the same bytes twice.
        assert!(!sealed.windows(KEY.len()).any(|window| window == KEY));
        assert_ne!(sealed, seal.seal("note_a", &KEY).unwrap());

        // Another session's seal, which is what signing in again gives.
        assert_eq!(seal_of(2).open("note_a", &sealed), None);
        // Moved to another note's row.
        assert_eq!(seal.open("note_b", &sealed), None);
        // Damaged, cut short, or not there.
        let mut damaged = sealed.clone();
        *damaged.last_mut().unwrap() ^= 1;
        assert_eq!(seal.open("note_a", &damaged), None);
        assert_eq!(seal.open("note_a", &sealed[..NONCE_BYTES]), None);
        assert_eq!(seal.open("note_a", &[]), None);
    }

    #[test]
    fn seal_key_is_not_the_session_secret_and_follows_from_it() {
        // The same secret gives the same seal, or a restart would lose every
        // key. Shown by one opening what the other sealed.
        let sealed = seal_of(1).seal("n", &KEY).unwrap();
        assert_eq!(seal_of(1).open("n", &sealed).as_deref(), Some(&KEY[..]));

        // Using the secret itself as the cipher's key opens nothing.
        let direct = Seal {
            cipher: XChaCha20Poly1305::new((&[1_u8; 32]).into()),
        };
        assert_eq!(direct.open("n", &sealed), None);
        assert_eq!(format!("{:?}", seal_of(1)), "Seal(..)");
    }

    #[test]
    fn key_is_kept_sealed_and_read_back() {
        let db = open_memory_for_tests();
        let seal = seal_of(1);
        note(&db, "note_a");

        db.with_conn(|conn| {
            assert_eq!(load(conn, &seal, "note_a")?, None);
            assert_eq!(store(conn, &seal, "note_a", &KEY)?, 1);
            assert_eq!(load(conn, &seal, "note_a")?.as_deref(), Some(&KEY[..]));
            Ok(())
        })
        .unwrap();
        // What is on disk is not the key.
        let on_disk = stored(&db, "note_a").unwrap();
        assert!(!on_disk.windows(KEY.len()).any(|window| window == KEY));

        // A newer key takes the older one's place.
        db.with_conn(|conn| {
            store(conn, &seal, "note_a", &[9; 32])?;
            assert_eq!(
                load(conn, &seal, "note_a")?.as_deref(),
                Some(&[9_u8; 32][..])
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn key_another_session_sealed_reads_as_none() {
        let db = open_memory_for_tests();
        note(&db, "note_a");
        db.with_conn(|conn| {
            store(conn, &seal_of(1), "note_a", &KEY)?;
            assert_eq!(load(conn, &seal_of(2), "note_a")?, None);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn nothing_is_kept_for_a_note_that_is_not_here_or_has_no_key() {
        let db = open_memory_for_tests();
        let seal = seal_of(1);
        note(&db, "note_a");
        db.with_conn(|conn| {
            assert_eq!(store(conn, &seal, "elsewhere", &KEY)?, 0);
            assert_eq!(store(conn, &seal, "note_a", &[])?, 0);
            Ok(())
        })
        .unwrap();
        assert_eq!(stored(&db, "elsewhere"), None);
        assert_eq!(stored(&db, "note_a"), None);
    }

    #[test]
    fn what_a_sync_learned_is_kept_in_one_go_and_the_last_word_wins() {
        let db = open_memory_for_tests();
        let seal = seal_of(1);
        note(&db, "note_a");
        note(&db, "note_b");

        let mut learned = Learned::default();
        learned.note("note_a", &[1; 32], "uid", "etag");
        learned.note("note_b", &[2; 32], "uid", "etag");
        learned.note("old_note", &[], "uid", "etag");
        learned.note("gone", &[3; 32], "uid", "etag");
        // Pushed after it was pulled, with the key the push carried.
        learned.note("note_a", &[4; 32], "uid", "etag");
        assert_eq!(format!("{learned:?}"), "Learned(3 keys)");

        assert_eq!(keep(&db, Some(&seal), learned).unwrap(), 2);
        db.with_conn(|conn| {
            assert_eq!(
                load(conn, &seal, "note_a")?.as_deref(),
                Some(&[4_u8; 32][..])
            );
            assert_eq!(
                load(conn, &seal, "note_b")?.as_deref(),
                Some(&[2_u8; 32][..])
            );
            assert_eq!(load(conn, &seal, "gone")?, None);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn without_a_seal_nothing_is_kept() {
        let db = open_memory_for_tests();
        note(&db, "note_a");
        let mut learned = Learned::default();
        learned.note("note_a", &KEY, "uid", "etag");
        assert_eq!(keep(&db, None, learned).unwrap(), 0);
        assert_eq!(stored(&db, "note_a"), None);
    }

    #[test]
    fn push_cache_requires_the_same_item_revision_and_session() {
        let db = open_memory_for_tests();
        let seal = seal_of(1);
        note(&db, "note_a");
        let mut learned = Learned::default();
        learned.note("note_a", &KEY, "item", "revision");
        assert_eq!(
            learned.for_revision("note_a", "item", "revision"),
            Some(&KEY[..])
        );
        assert_eq!(
            learned.for_revision("note_a", "moved_item", "revision"),
            None
        );
        assert_eq!(learned.for_revision("note_a", "item", "new_revision"), None);
        keep(&db, Some(&seal), learned).unwrap();

        db.with_conn(|conn| {
            assert_eq!(
                load_revision(conn, &seal, "note_a", "item", "revision")?,
                Some(KEY.to_vec())
            );
            assert_eq!(
                load_revision(conn, &seal, "note_a", "moved_item", "revision")?,
                None
            );
            assert_eq!(
                load_revision(conn, &seal, "note_a", "item", "new_revision")?,
                None
            );
            assert_eq!(
                load_revision(conn, &seal_of(2), "note_a", "item", "revision")?,
                None
            );
            assert_eq!(load(conn, &seal, "note_a")?, Some(KEY.to_vec()));

            // A legacy key still opens a room, but has no proof of which
            // revision it came from and must not be used to replace content.
            store(conn, &seal, "note_a", &KEY)?;
            assert_eq!(load(conn, &seal, "note_a")?, Some(KEY.to_vec()));
            assert_eq!(
                load_revision(conn, &seal, "note_a", "item", "revision")?,
                None
            );
            conn.execute(
                "UPDATE room_keys SET sealed = X'010203' WHERE note_id = 'note_a'",
                [],
            )?;
            assert_eq!(
                load_revision(conn, &seal, "note_a", "item", "revision")?,
                None
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn key_goes_with_its_note_and_all_go_at_sign_out() {
        let db = open_memory_for_tests();
        let seal = seal_of(1);
        note(&db, "note_a");
        note(&db, "note_b");
        db.with_conn(|conn| {
            store(conn, &seal, "note_a", &KEY)?;
            store(conn, &seal, "note_b", &KEY)?;
            conn.execute("DELETE FROM notes WHERE id = 'note_a'", [])?;
            Ok(())
        })
        .unwrap();
        assert_eq!(stored(&db, "note_a"), None);
        assert!(stored(&db, "note_b").is_some());

        db.with_conn(forget_all).unwrap();
        assert_eq!(stored(&db, "note_b"), None);
    }
}
