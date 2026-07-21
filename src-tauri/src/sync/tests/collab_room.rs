//! Room/key derivation and writer-key authorization.

use super::fixtures::*;
use super::*;

/// The room id must never be the Etebase item UID: the server stores that
/// in plaintext, so naming the room after it hands the operator a join
/// credential for every personal note.
#[test]
fn derive_live_collab_room_never_names_the_room_after_the_item_uid() {
    let note_key = [3_u8; 32];

    let room = derive_live_collab_room("note_uid", &note_key, None).unwrap();

    assert_ne!(room.room_id, "note_uid");
    assert!(valid_collab_writer_public_key(&room.room_id));
    assert_eq!(room.collab_epoch, 0);
    assert!(room.writer_auth.is_none());
    assert!(!room.join_private_key_pkcs8_b64.is_empty());
}

/// Personal rooms used to put the Etebase item key straight on the wire,
/// so one key served both at-rest storage and AES-GCM transport.
#[test]
fn unscoped_rooms_do_not_reuse_the_item_key_on_the_wire() {
    let note_key = [3_u8; 32];

    let room = derive_live_collab_room("note_uid", &note_key, None).unwrap();

    assert_ne!(room.key_b64, etebase::utils::to_base64(&note_key).unwrap());
    // Still deterministic, or a second device couldn't join.
    let again = derive_live_collab_room("note_uid", &note_key, None).unwrap();
    assert_eq!(room.key_b64, again.key_b64);
    // And still bound to the note.
    let other = derive_live_collab_room("other_uid", &note_key, None).unwrap();
    assert_ne!(room.key_b64, other.key_b64);
}

/// The join keypair and the wire key both come off the same HKDF input,
/// so they must be separated by their info strings.
#[test]
fn join_key_and_wire_key_are_domain_separated() {
    let note_key = [3_u8; 32];

    let wire = derive_live_collab_key("note_uid", &note_key, None, 0).unwrap();
    let (_, join_priv) = derive_collab_join_keypair("note_uid", &note_key, None, 0).unwrap();

    let wire_b64 = BASE64_STANDARD.encode(wire);
    assert_ne!(wire_b64, join_priv);
    assert!(!join_priv.contains(&wire_b64));
}

#[test]
fn derive_collab_join_keypair_is_deterministic_and_separated() {
    let note_key = [3_u8; 32];
    let salt = [9_u8; 32];

    let (pub_a, priv_a) = derive_collab_join_keypair("note_uid", &note_key, None, 0).unwrap();
    let (pub_b, priv_b) = derive_collab_join_keypair("note_uid", &note_key, None, 0).unwrap();
    assert_eq!(pub_a, pub_b, "same inputs must yield the same room");
    assert_eq!(priv_a, priv_b);

    // Every input that scopes a room must change the keypair, or a
    // revoked member's derived key would still open the rotated room.
    let other_note = derive_collab_join_keypair("other_uid", &note_key, None, 0).unwrap();
    let other_epoch = derive_collab_join_keypair("note_uid", &note_key, Some(&salt), 1).unwrap();
    let other_salt = derive_collab_join_keypair("note_uid", &note_key, Some(&salt), 0).unwrap();
    assert_ne!(pub_a, other_note.0);
    assert_ne!(pub_a, other_salt.0);
    assert_ne!(other_salt.0, other_epoch.0);
}

/// The public half is the room id, so it has to be exactly the P-256 SPKI
/// shape the relay parses — the same validation writer keys go through.
#[test]
fn derive_collab_join_keypair_emits_p256_spki() {
    let (public_b64, private_b64) =
        derive_collab_join_keypair("note_uid", &[3_u8; 32], None, 0).unwrap();

    assert!(valid_collab_writer_public_key(&public_b64));
    let private_der = BASE64_STANDARD.decode(&private_b64).unwrap();
    assert!(p256::SecretKey::from_pkcs8_der(&private_der).is_ok());
}

#[test]
fn derive_live_collab_room_uses_scope_salt_and_epoch() {
    let note_key = [3_u8; 32];
    let epoch_one = collab_info(1, &[9_u8; 32]);
    let epoch_two = collab_info(2, &[9_u8; 32]);
    let different_salt = collab_info(1, &[8_u8; 32]);

    let scoped = derive_live_collab_room("note_uid", &note_key, Some(&epoch_one)).unwrap();
    let rotated_epoch = derive_live_collab_room("note_uid", &note_key, Some(&epoch_two)).unwrap();
    let rotated_salt =
        derive_live_collab_room("note_uid", &note_key, Some(&different_salt)).unwrap();

    assert_ne!(scoped.room_id, "note_uid");
    assert_ne!(
        scoped.key_b64,
        etebase::utils::to_base64(&note_key).unwrap()
    );
    assert_ne!(
        scoped.join_private_key_pkcs8_b64,
        rotated_epoch.join_private_key_pkcs8_b64
    );
    assert_eq!(scoped.collab_epoch, 1);
    assert!(scoped.writer_auth.is_none());
    assert_ne!(scoped.room_id, rotated_epoch.room_id);
    assert_ne!(scoped.key_b64, rotated_epoch.key_b64);
    assert_ne!(scoped.room_id, rotated_salt.room_id);
    assert_ne!(scoped.key_b64, rotated_salt.key_b64);
}

#[test]
fn live_collab_rooms_are_withheld_from_read_only_shared_members() {
    assert!(!can_receive_live_collab_room(
        CollectionAccessLevel::ReadOnly,
        true
    ));
    assert!(can_receive_live_collab_room(
        CollectionAccessLevel::ReadWrite,
        true
    ));
    assert!(can_receive_live_collab_room(
        CollectionAccessLevel::Admin,
        true
    ));
    assert!(can_receive_live_collab_room(
        CollectionAccessLevel::ReadOnly,
        false
    ));
}

#[test]
fn collab_writer_public_key_validation_requires_p256_spki_b64() {
    let mut der = P256_SPKI_DER_PREFIX.to_vec();
    der.extend(1_u8..=64);
    let key_b64 = BASE64_STANDARD.encode(&der);

    assert!(valid_collab_writer_public_key(&key_b64));
    assert!(!valid_collab_writer_public_key(""));
    assert!(!valid_collab_writer_public_key("not base64"));

    let mut wrong_prefix = der;
    wrong_prefix[0] = 0x31;
    assert!(!valid_collab_writer_public_key(
        &BASE64_STANDARD.encode(wrong_prefix)
    ));
}

#[test]
fn collab_writer_key_payload_round_trips_json() {
    let payload = CollabWriterKeyPayload {
        schema: 1,
        share_scope_id: "scope_1".into(),
        collab_epoch: 7,
        public_key_b64: "public".into(),
        username: Some("alice".into()),
    };

    let encoded = serde_json::to_vec(&payload).unwrap();
    let decoded: CollabWriterKeyPayload = serde_json::from_slice(&encoded).unwrap();

    assert_eq!(decoded, payload);
}

#[test]
fn writable_collab_writer_filter_drops_read_only_usernames() {
    let writers = vec![
        RoomAuthorizedWriter {
            username: "alice".into(),
            public_key_b64: "alice_key".into(),
        },
        RoomAuthorizedWriter {
            username: "bob".into(),
            public_key_b64: "bob_key".into(),
        },
    ];
    let writable_usernames = HashSet::from(["alice".to_string()]);

    assert_eq!(
        filter_writable_collab_writers(writers, &writable_usernames),
        vec![RoomAuthorizedWriter {
            username: "alice".into(),
            public_key_b64: "alice_key".into(),
        }]
    );
}
