//! Room key derivation and what the room commands make of the server's
//! answers.

use super::*;

/// The wire key must not be the key the note carries. One key for storage
/// at rest and for frames on the wire would mean a compromise of either
/// context compromises both.
#[test]
fn room_key_is_separated_from_the_note_key_and_bound_to_the_note() {
    let note_key = [3_u8; 32];

    let key = room_key("note_uid", &note_key).unwrap();
    assert_ne!(key, note_key);
    // Deterministic: every member has to arrive at the same key.
    assert_eq!(key, room_key("note_uid", &note_key).unwrap());
    // Two notes that somehow share a key still get different rooms.
    assert_ne!(key, room_key("other_uid", &note_key).unwrap());
    assert_ne!(key, room_key("note_uid", &[4_u8; 32]).unwrap());
}

/// Every device has to derive the same key from the same note, on every
/// build that speaks this version of the protocol. A change to the
/// derivation changes this value, and then two builds cannot share a room.
#[test]
fn room_key_is_hkdf_sha256_of_the_note_key_over_the_label_and_uid() {
    let note_key = [3_u8; 32];
    let hkdf = Hkdf::<Sha256>::new(None, &note_key);
    let mut expected = [0_u8; 32];
    hkdf.expand(b"mindstream-live-collab-key/v2note_uid", &mut expected)
        .unwrap();
    assert_eq!(room_key("note_uid", &note_key).unwrap(), expected);
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
