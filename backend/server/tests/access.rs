//! Who can do what. These are the checks that keep one person's notes away
//! from another, so each rule the server enforces has a test that tries to
//! break it with the real client.

mod common;

use std::iter;

use common::{named, new_collection, share, signup, signup_at, COLLECTION_TYPE};
use etebase::error::Error;
use etebase::{CollectionAccessLevel, FetchOptions, PrefetchOption};

macro_rules! assert_refused {
    ($result:expr, $expected:pat) => {
        match $result {
            Err($expected) => {}
            Err(other) => panic!("refused, but with {other:?}"),
            Ok(_) => panic!("was allowed"),
        }
    };
}

#[test]
fn read_only_member_can_read_but_not_write() {
    let owner = signup("owner");
    let guest = signup("guest");
    let collection = new_collection(&owner, "shared");
    let owner_items = owner
        .collection_manager()
        .unwrap()
        .item_manager(&collection)
        .unwrap();
    let note = owner_items.create(&named("note"), b"body").unwrap();
    owner_items.batch(iter::once(&note), None).unwrap();

    let guest_view = share(&owner, &collection, &guest, CollectionAccessLevel::ReadOnly);
    let guest_collections = guest.collection_manager().unwrap();
    let guest_items = guest_collections.item_manager(&guest_view).unwrap();

    let listed = guest_items.list(None).unwrap();
    assert_eq!(listed.data().len(), 1);
    assert_eq!(listed.data()[0].content().unwrap(), b"body");

    let mut edited = guest_items.fetch(note.uid(), None).unwrap();
    edited.set_content(b"defaced").unwrap();
    assert_refused!(
        guest_items.batch(iter::once(&edited), None),
        Error::PermissionDenied(_)
    );
    assert_refused!(
        guest_items.transaction(iter::once(&edited), None),
        Error::PermissionDenied(_)
    );
    let fresh = guest_items.create(&named("mine"), b"new").unwrap();
    assert_refused!(
        guest_items.batch(iter::once(&fresh), None),
        Error::PermissionDenied(_)
    );
    assert_refused!(
        guest_items.upload_content(&fresh),
        Error::PermissionDenied(_)
    );

    // Renaming the collection is a write to its main item.
    let mut renamed = guest_collections.fetch(collection.uid(), None).unwrap();
    renamed.set_meta(&named("taken over")).unwrap();
    assert_refused!(
        guest_collections.upload(&renamed, None),
        Error::PermissionDenied(_)
    );

    let unchanged = owner_items.fetch(note.uid(), None).unwrap();
    assert_eq!(unchanged.content().unwrap(), b"body");
}

/// The collection's own item names it and, for a shared folder, says who
/// shared which folder. Write access to the collection's items is not
/// enough to change it. Deleting it ends the share for every member and
/// drops everything in it, which is for the owner alone.
#[test]
fn only_an_admin_renames_and_only_the_owner_deletes_the_collection() {
    let owner = signup("owner");
    let writer = signup("writer");
    let collection = new_collection(&owner, "shared");
    let writer_view = share(
        &owner,
        &collection,
        &writer,
        CollectionAccessLevel::ReadWrite,
    );
    let writer_collections = writer.collection_manager().unwrap();

    let mut renamed = writer_collections.fetch(collection.uid(), None).unwrap();
    renamed.set_meta(&named("taken over")).unwrap();
    assert_refused!(
        writer_collections.upload(&renamed, None),
        Error::PermissionDenied(_)
    );
    assert_refused!(
        writer_collections.transaction(&renamed, None),
        Error::PermissionDenied(_)
    );
    let mut deleted = writer_collections.fetch(collection.uid(), None).unwrap();
    deleted.delete().unwrap();
    assert_refused!(
        writer_collections.upload(&deleted, None),
        Error::PermissionDenied(_)
    );
    // The items are still theirs to write.
    let items = writer_collections.item_manager(&writer_view).unwrap();
    let note = items.create(&named("note"), b"body").unwrap();
    items.batch(iter::once(&note), None).unwrap();

    owner
        .collection_manager()
        .unwrap()
        .member_manager(&collection)
        .unwrap()
        .modify_access_level(&writer.name, CollectionAccessLevel::Admin)
        .unwrap();
    let mut renamed = writer_collections.fetch(collection.uid(), None).unwrap();
    renamed.set_meta(&named("renamed by an admin")).unwrap();
    writer_collections.upload(&renamed, None).unwrap();
    let mut deleted = writer_collections.fetch(collection.uid(), None).unwrap();
    deleted.delete().unwrap();
    assert_refused!(
        writer_collections.upload(&deleted, None),
        Error::PermissionDenied(_)
    );
    assert!(!owner
        .collection_manager()
        .unwrap()
        .fetch(collection.uid(), None)
        .unwrap()
        .is_deleted());
}

/// Deleting a shared collection is how its owner stops sharing it. It ends
/// every other membership just as a removal does, and with it every way in
/// that was still open: an invitation not yet answered, a link not yet used.
#[test]
fn deleting_a_collection_takes_everyone_else_out() {
    let owner = signup("owner");
    let writer = signup("writer");
    let admin = signup("coadmin");
    let invited = signup("invited");
    let collection = new_collection(&owner, "shared");
    let owner_collections = owner.collection_manager().unwrap();
    let writer_view = share(
        &owner,
        &collection,
        &writer,
        CollectionAccessLevel::ReadWrite,
    );
    share(&owner, &collection, &admin, CollectionAccessLevel::Admin);
    let writer_collections = writer.collection_manager().unwrap();
    let cursor = writer_collections
        .list(COLLECTION_TYPE, None)
        .unwrap()
        .stoken()
        .map(str::to_owned);
    let owner_invites = owner.invitation_manager().unwrap();
    let profile = owner_invites.fetch_user_profile(&invited.name).unwrap();
    owner_invites
        .invite(
            &collection,
            &invited.name,
            profile.pubkey(),
            CollectionAccessLevel::ReadOnly,
        )
        .unwrap();

    let mut deleted = owner_collections.fetch(collection.uid(), None).unwrap();
    deleted.delete().unwrap();
    owner_collections.upload(&deleted, None).unwrap();

    for (account, view) in [(&writer, Some(&writer_view)), (&admin, None)] {
        let collections = account.collection_manager().unwrap();
        assert_refused!(
            collections.fetch(collection.uid(), None),
            Error::NotFound(_)
        );
        if let Some(view) = view {
            let items = collections.item_manager(view).unwrap();
            assert_refused!(items.list(None), Error::NotFound(_));
            let note = items.create(&named("after"), b"too late").unwrap();
            assert_refused!(items.batch(iter::once(&note), None), Error::NotFound(_));
        }
    }
    let options = FetchOptions::new().stoken(cursor.as_deref());
    let listed = writer_collections
        .list(COLLECTION_TYPE, Some(&options))
        .unwrap();
    let removed = listed.removed_memberships().expect("a removal is reported");
    assert_eq!(removed[0].uid(), collection.uid());
    let incoming = invited
        .invitation_manager()
        .unwrap()
        .list_incoming(None)
        .unwrap();
    assert!(
        incoming.data().is_empty(),
        "the invitation outlived the share"
    );

    // The owner keeps the collection, deleted, as Etebase does.
    let kept = owner_collections.fetch(collection.uid(), None).unwrap();
    assert!(kept.is_deleted());
    let members = owner_collections
        .member_manager(&kept)
        .unwrap()
        .list(None)
        .unwrap();
    assert_eq!(members.data().len(), 1);
    // And nobody is let in again.
    assert_refused!(
        owner_invites.invite(
            &kept,
            &invited.name,
            profile.pubkey(),
            CollectionAccessLevel::ReadOnly,
        ),
        Error::PermissionDenied(_)
    );
}

#[test]
fn removed_member_loses_access_at_once() {
    let owner = signup("owner");
    let guest = signup("guest");
    let collection = new_collection(&owner, "shared");
    let owner_collections = owner.collection_manager().unwrap();
    let owner_items = owner_collections.item_manager(&collection).unwrap();
    let note = owner_items.create(&named("note"), b"body").unwrap();
    owner_items.batch(iter::once(&note), None).unwrap();

    let guest_view = share(
        &owner,
        &collection,
        &guest,
        CollectionAccessLevel::ReadWrite,
    );
    let guest_collections = guest.collection_manager().unwrap();
    let guest_items = guest_collections.item_manager(&guest_view).unwrap();
    let cursor = guest_collections
        .list(COLLECTION_TYPE, None)
        .unwrap()
        .stoken()
        .map(str::to_owned);

    owner_collections
        .member_manager(&collection)
        .unwrap()
        .remove(&guest.name)
        .unwrap();

    // To the removed member the collection no longer exists, whatever they
    // try, including with handles they obtained while they were a member.
    assert_refused!(
        guest_collections.fetch(collection.uid(), None),
        Error::NotFound(_)
    );
    assert_refused!(guest_items.list(None), Error::NotFound(_));
    assert_refused!(guest_items.fetch(note.uid(), None), Error::NotFound(_));
    let mut edited = note.clone();
    edited.set_content(b"parting shot").unwrap();
    assert_refused!(
        guest_items.batch(iter::once(&edited), None),
        Error::NotFound(_)
    );
    assert_refused!(
        guest_collections
            .member_manager(&guest_view)
            .unwrap()
            .leave(),
        Error::NotFound(_)
    );

    // And their next sync is told the membership is gone.
    let options = FetchOptions::new().stoken(cursor.as_deref());
    let listed = guest_collections
        .list(COLLECTION_TYPE, Some(&options))
        .unwrap();
    assert!(listed.data().is_empty());
    let removed = listed.removed_memberships().expect("a removal is reported");
    assert_eq!(removed.len(), 1);
    assert_eq!(removed[0].uid(), collection.uid());
}

#[test]
fn outsider_cannot_reach_a_collection_by_uid() {
    let owner = signup("owner");
    let outsider = signup("outsider");
    let collection = new_collection(&owner, "private");
    let owner_items = owner
        .collection_manager()
        .unwrap()
        .item_manager(&collection)
        .unwrap();
    let note = owner_items.create(&named("note"), b"secret").unwrap();
    owner_items.batch(iter::once(&note), None).unwrap();

    let outsider_collections = outsider.collection_manager().unwrap();
    assert_refused!(
        outsider_collections.fetch(collection.uid(), None),
        Error::NotFound(_)
    );
    assert!(outsider_collections
        .list(COLLECTION_TYPE, None)
        .unwrap()
        .data()
        .is_empty());

    // The outsider knows every uid and builds the requests by hand.
    let outsider_items = outsider_collections.item_manager(&collection).unwrap();
    assert_refused!(outsider_items.list(None), Error::NotFound(_));
    assert_refused!(outsider_items.fetch(note.uid(), None), Error::NotFound(_));
    assert_refused!(
        outsider_items.fetch_multi(iter::once(note.uid()), None),
        Error::NotFound(_)
    );
    assert_refused!(
        outsider_items.item_revisions(&note, None),
        Error::NotFound(_)
    );
    assert_refused!(
        outsider_items.batch(iter::once(&note), None),
        Error::NotFound(_)
    );
    // An item fetched without its content, as the owner may hand around,
    // does not let the outsider download the chunks either.
    let without_content = FetchOptions::new().prefetch(&PrefetchOption::Medium);
    let mut partial = owner_items
        .fetch(note.uid(), Some(&without_content))
        .unwrap();
    assert!(partial.is_missing_content());
    assert_refused!(
        outsider_items.download_content(&mut partial),
        Error::NotFound(_)
    );
    assert_refused!(
        outsider_collections
            .member_manager(&collection)
            .unwrap()
            .list(None),
        Error::NotFound(_)
    );
}

#[test]
fn only_an_admin_manages_members() {
    let owner = signup("owner");
    let writer = signup("writer");
    let third = signup("third");
    let collection = new_collection(&owner, "shared");
    let writer_view = share(
        &owner,
        &collection,
        &writer,
        CollectionAccessLevel::ReadWrite,
    );
    let writer_collections = writer.collection_manager().unwrap();
    let writer_members = writer_collections.member_manager(&writer_view).unwrap();
    let owner_name = owner.name.clone();
    let writer_name = writer.name.clone();

    assert_refused!(writer_members.list(None), Error::PermissionDenied(_));
    assert_refused!(
        writer_members.modify_access_level(&writer_name, CollectionAccessLevel::Admin),
        Error::PermissionDenied(_)
    );
    assert_refused!(
        writer_members.remove(&owner_name),
        Error::PermissionDenied(_)
    );
    let writer_invites = writer.invitation_manager().unwrap();
    let third_profile = writer_invites.fetch_user_profile(&third.name).unwrap();
    assert_refused!(
        writer_invites.invite(
            &writer_view,
            &third.name,
            third_profile.pubkey(),
            CollectionAccessLevel::ReadWrite
        ),
        Error::PermissionDenied(_)
    );

    // Even an admin cannot remove or demote the owner, who pays for it.
    let owner_members = owner
        .collection_manager()
        .unwrap()
        .member_manager(&collection)
        .unwrap();
    owner_members
        .modify_access_level(&writer_name, CollectionAccessLevel::Admin)
        .unwrap();
    assert_refused!(
        writer_members.remove(&owner_name),
        Error::PermissionDenied(_)
    );
    assert_refused!(
        writer_members.modify_access_level(&owner_name, CollectionAccessLevel::ReadOnly),
        Error::PermissionDenied(_)
    );
    assert_refused!(owner_members.leave(), Error::PermissionDenied(_));
}

#[test]
fn invitation_belongs_to_its_recipient() {
    let owner = signup("owner");
    let invited = signup("invited");
    let thief = signup("thief");
    let collection = new_collection(&owner, "shared");

    let owner_invites = owner.invitation_manager().unwrap();
    let profile = owner_invites.fetch_user_profile(&invited.name).unwrap();
    owner_invites
        .invite(
            &collection,
            &invited.name,
            profile.pubkey(),
            CollectionAccessLevel::ReadWrite,
        )
        .unwrap();
    let invited_invites = invited.invitation_manager().unwrap();
    let incoming = invited_invites.list_incoming(None).unwrap();
    let invitation = incoming.data().first().expect("the invitation arrived");

    // Someone else who learns the invitation's uid can neither see it,
    // withdraw it nor turn it down on the recipient's behalf.
    let thief_invites = thief.invitation_manager().unwrap();
    assert!(thief_invites.list_incoming(None).unwrap().data().is_empty());
    assert!(thief_invites.list_outgoing(None).unwrap().data().is_empty());
    assert_refused!(thief_invites.reject(invitation), Error::NotFound(_));
    assert_refused!(thief_invites.disinvite(invitation), Error::NotFound(_));

    invited_invites.accept(invitation).unwrap();
    assert!(thief
        .collection_manager()
        .unwrap()
        .list(COLLECTION_TYPE, None)
        .unwrap()
        .data()
        .is_empty());
}

/// Someone invited can read what they are invited to before answering:
/// the server sends the collection's own item with the invitation, and the
/// key inside the invitation opens its name.
#[test]
fn invitation_names_the_collection_before_it_is_answered() {
    let owner = signup("owner");
    let invited = signup("invited");
    let collection = new_collection(&owner, "Trip plans");
    let owner_invites = owner.invitation_manager().unwrap();
    let profile = owner_invites.fetch_user_profile(&invited.name).unwrap();
    owner_invites
        .invite(
            &collection,
            &invited.name,
            profile.pubkey(),
            CollectionAccessLevel::ReadOnly,
        )
        .unwrap();

    let invited_invites = invited.invitation_manager().unwrap();
    let incoming = invited_invites.list_incoming(None).unwrap();
    assert_eq!(incoming.data().len(), 1);
    let preview = invited_invites.preview(&incoming.data()[0]).unwrap();
    assert_eq!(preview.collection_name(), Some("Trip plans"));
    assert_eq!(preview.collection_type(), COLLECTION_TYPE);

    // Reading the name took nothing: the invitation is still there, and the
    // collection is still out of reach.
    assert_eq!(invited_invites.list_incoming(None).unwrap().data().len(), 1);
    assert_refused!(
        invited
            .collection_manager()
            .unwrap()
            .fetch(collection.uid(), None),
        Error::NotFound(_) | Error::PermissionDenied(_)
    );

    // What the sender lists as sent carries no item, and its preview has no
    // name to show. Nothing breaks for it.
    let outgoing = owner_invites.list_outgoing(None).unwrap();
    assert_eq!(outgoing.data().len(), 1);
}

#[test]
fn logout_ends_the_session() {
    let account = signup("solo");
    let collection = new_collection(&account, "mine");
    let collections = account.collection_manager().unwrap();
    collections.fetch(collection.uid(), None).unwrap();

    account.logout().unwrap();
    assert_refused!(
        collections.fetch(collection.uid(), None),
        Error::Unauthorized(_)
    );
}

#[test]
fn closed_server_refuses_signup() {
    let url = common::start_server(common::closed_signup);
    etebase::init().unwrap();
    let name = common::username("late");
    let user = etebase::User::new(&name, "late@test.local");
    assert_refused!(
        etebase::Account::signup_key(common::client(&url), &user, &[7u8; 32]),
        Error::PermissionDenied(_)
    );
    // The same request is fine where signup is open.
    signup_at(common::server(), "early");
}
