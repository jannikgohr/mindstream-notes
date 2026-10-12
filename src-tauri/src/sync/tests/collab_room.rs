//! Room key derivation and what the room commands make of the server's
//! answers.

use super::fixtures::*;
use super::*;

/// The wire key must not be the Etebase item key. One key for storage at
/// rest and for frames on the wire would mean a compromise of either context
/// compromises both.
#[test]
fn room_key_is_separated_from_the_note_key_and_bound_to_the_note() {
    let note_key = [3_u8; 32];

    let key = room_key("note_uid", &note_key, None).unwrap();
    assert_ne!(key, note_key);
    // Deterministic: every member has to arrive at the same key.
    assert_eq!(key, room_key("note_uid", &note_key, None).unwrap());
    // Two notes that somehow share a key still get different rooms.
    assert_ne!(key, room_key("other_uid", &note_key, None).unwrap());
    assert_ne!(key, room_key("note_uid", &[4_u8; 32], None).unwrap());
}

#[test]
fn room_key_of_a_shared_note_uses_the_scope_salt_and_epoch() {
    let note_key = [3_u8; 32];
    let epoch_one = collab_info(1, &[9_u8; 32]);
    let epoch_two = collab_info(2, &[9_u8; 32]);
    let different_salt = collab_info(1, &[8_u8; 32]);

    let personal = room_key("note_uid", &note_key, None).unwrap();
    let scoped = room_key("note_uid", &note_key, Some(&epoch_one)).unwrap();
    assert_ne!(scoped, note_key);
    assert_ne!(scoped, personal);
    assert_ne!(
        scoped,
        room_key("note_uid", &note_key, Some(&epoch_two)).unwrap()
    );
    assert_ne!(
        scoped,
        room_key("note_uid", &note_key, Some(&different_salt)).unwrap()
    );
    assert_eq!(
        scoped,
        derive_live_collab_key("note_uid", &note_key, Some(&[9_u8; 32]), 1).unwrap()
    );
}

/// A manifest without a salt gives a shared note the key a personal note
/// would have, as it always has.
#[test]
fn scope_without_a_salt_derives_like_a_personal_note() {
    let note_key = [3_u8; 32];
    let unsalted = collab_info(7, &[]);
    assert_eq!(
        room_key("note_uid", &note_key, Some(&unsalted)).unwrap(),
        room_key("note_uid", &note_key, None).unwrap()
    );
}

/// "You may not enter" stops the editor asking. Anything else is worth
/// another try, so a server restart does not end live collab for the
/// session.
#[test]
fn only_a_refusal_ends_the_attempts_to_enter_a_room() {
    for refusal in [
        EtebaseError::NotFound("gone".into()),
        EtebaseError::Unauthorized("signed out".into()),
        EtebaseError::PermissionDenied("no".into()),
    ] {
        assert!(room_entry_refused(&refusal), "{refusal}");
    }
    for transient in [
        EtebaseError::Connection("refused".into()),
        EtebaseError::ServerError("500".into()),
        EtebaseError::TemporaryServerError("503".into()),
        EtebaseError::Http("429".into()),
    ] {
        assert!(!room_entry_refused(&transient), "{transient}");
    }
}
