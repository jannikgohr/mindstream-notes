//! Invite links the way the app reaches them: through the client library,
//! with a real secret and the keys that come out of it.
//!
//! `links.rs` checks the server's rules with keys the tests make up and a
//! stand-in for the sealed collection key. This checks that what the client
//! seals for a link is what a holder of the link opens, and that the two
//! agree on what goes over the wire.

mod common;

use std::iter;

use common::{named, new_collection, signup, COLLECTION_TYPE};
use etebase::error::Error;
use etebase::{
    refusal, Account, Client, CollectionAccessLevel, InviteLink, LinkOptions, SignupWith, User,
};
use mindstream_server::admin;
use mindstream_server::config::SignupPolicy;

const PASSWORD: &str = "correct horse battery staple";

/// The reason a call was refused with.
fn reason<T>(result: Result<T, Error>) -> String {
    match result {
        Ok(_) => "accepted".to_owned(),
        Err(Error::Refused { code, .. }) => code,
        Err(other) => format!("{other:?}"),
    }
}

/// The same link with a secret somebody made up.
fn with_guessed_secret(link: &InviteLink) -> InviteLink {
    let text = link.to_string();
    let (address, _) = text.split_once('#').expect("a link has a secret");
    let guess = etebase::utils::to_base64(&[9; 32]).unwrap();
    InviteLink::parse(&format!("{address}#{guess}")).expect("still shaped like a link")
}

#[test]
fn link_shows_what_it_leads_to_and_lets_its_holder_in() {
    let owner = signup("owner");
    let guest = signup("guest");
    let collection = new_collection(&owner, "Trip plans");
    let items = owner
        .collection_manager()
        .unwrap()
        .item_manager(&collection)
        .unwrap();
    let note = items.create(&named("note"), b"what to pack").unwrap();
    items.batch(iter::once(&note), None).unwrap();

    let link = owner
        .create_invite_link(
            &collection,
            CollectionAccessLevel::ReadWrite,
            &LinkOptions::new(),
        )
        .expect("make a link");

    // A link travels as text and is read back on another device.
    let text = link.to_string();
    assert!(text.starts_with(common::server()), "{text}");
    let pasted = InviteLink::parse(&text).expect("the text is a link");
    assert_eq!(pasted, link);

    // Looking needs no account, only the link.
    let preview = pasted
        .open(&common::client(common::server()))
        .expect("open the link");
    assert_eq!(preview.collection_name(), Some("Trip plans"));
    assert_eq!(preview.collection_type(), COLLECTION_TYPE);
    assert_eq!(preview.collection_uid(), collection.uid());
    assert_eq!(preview.sender_username(), owner.name);
    assert_eq!(preview.access_level(), CollectionAccessLevel::ReadWrite);
    assert!(!preview.can_signup());

    guest.claim_invite_link(&pasted).expect("join by the link");

    // The key the link carried is the collection's: the guest reads what
    // was there and can write.
    let guest_collections = guest.collection_manager().unwrap();
    let joined = guest_collections.fetch(collection.uid(), None).unwrap();
    assert_eq!(joined.meta().unwrap().name(), Some("Trip plans"));
    assert_eq!(joined.access_level(), CollectionAccessLevel::ReadWrite);
    let guest_items = guest_collections.item_manager(&joined).unwrap();
    let fetched = guest_items.fetch(note.uid(), None).unwrap();
    assert_eq!(fetched.content().unwrap(), b"what to pack");
    let reply = guest_items.create(&named("reply"), b"sunscreen").unwrap();
    guest_items.batch(iter::once(&reply), None).unwrap();
    // And it is filed under its type, as an accepted invitation is.
    let listed = guest_collections.list(COLLECTION_TYPE, None).unwrap();
    assert_eq!(listed.data().len(), 1);

    // The link was for one person.
    let late = signup("late");
    assert_eq!(reason(late.claim_invite_link(&pasted)), refusal::LINK_USED);
    assert_eq!(
        reason(pasted.open(&common::client(common::server()))),
        refusal::LINK_USED
    );
}

#[test]
fn link_address_without_its_secret_gets_nothing() {
    let owner = signup("owner");
    let stranger = signup("stranger");
    let collection = new_collection(&owner, "Private");
    let link = owner
        .create_invite_link(
            &collection,
            CollectionAccessLevel::ReadOnly,
            &LinkOptions::new(),
        )
        .unwrap();

    // The address is the part that leaks: it passes through logs, chat
    // previews and browser histories. With a secret of one's own it opens
    // nothing and joins nothing.
    let guessed = with_guessed_secret(&link);
    assert_eq!(guessed.uid(), link.uid());
    let anonymous = common::client(common::server());
    assert!(matches!(
        guessed.open(&anonymous),
        Err(Error::Refused { status: 404, .. })
    ));
    assert!(matches!(
        stranger.claim_invite_link(&guessed),
        Err(Error::Refused { status: 404, .. })
    ));
    assert!(stranger
        .collection_manager()
        .unwrap()
        .fetch(collection.uid(), None)
        .is_err());

    // The real link still works afterwards: a wrong guess spends nothing.
    stranger.claim_invite_link(&link).expect("the real link");
    let joined = stranger
        .collection_manager()
        .unwrap()
        .fetch(collection.uid(), None)
        .unwrap();
    assert_eq!(joined.access_level(), CollectionAccessLevel::ReadOnly);
}

#[test]
fn maker_sees_a_link_being_used_and_can_remove_it() {
    let owner = signup("owner");
    let first = signup("first");
    let second = signup("second");
    let collection = new_collection(&owner, "Club");
    assert!(owner.invite_links(&collection).unwrap().is_empty());

    let link = owner
        .create_invite_link(
            &collection,
            CollectionAccessLevel::ReadOnly,
            &LinkOptions::new().max_uses(3).expires_in(3600),
        )
        .unwrap();

    let listed = owner.invite_links(&collection).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].uid(), link.uid());
    assert_eq!(listed[0].access_level(), CollectionAccessLevel::ReadOnly);
    assert_eq!((listed[0].uses(), listed[0].max_uses()), (0, 3));
    assert_eq!(listed[0].sender_username(), owner.name);
    assert!(!listed[0].allows_signup());
    let lasts = listed[0].expires_at() - listed[0].created_at();
    assert!((3590..=3610).contains(&lasts), "lasts {lasts} seconds");

    first.claim_invite_link(&link).unwrap();
    assert_eq!(owner.invite_links(&collection).unwrap()[0].uses(), 1);
    // Whoever is in already is told so, and takes nobody else's place.
    assert_eq!(
        reason(first.claim_invite_link(&link)),
        refusal::ALREADY_MEMBER
    );
    assert_eq!(owner.invite_links(&collection).unwrap()[0].uses(), 1);

    // Someone who only joined cannot see or remove the links.
    assert!(first
        .invite_links(
            &first
                .collection_manager()
                .unwrap()
                .fetch(collection.uid(), None)
                .unwrap()
        )
        .is_err());
    assert!(first.revoke_invite_link(link.uid()).is_err());

    owner
        .revoke_invite_link(link.uid())
        .expect("remove the link");
    assert!(owner.invite_links(&collection).unwrap().is_empty());
    assert!(matches!(
        second.claim_invite_link(&link),
        Err(Error::Refused { status: 404, .. })
    ));
    // Removing the link removes nobody it already let in.
    assert!(first
        .collection_manager()
        .unwrap()
        .fetch(collection.uid(), None)
        .is_ok());
}

#[test]
fn link_can_create_the_account_that_then_joins() {
    let url = common::start_server(|config| config.signup = SignupPolicy::Invite);
    let device = |name: &str| Client::new(name, &url).expect("client");
    let signup_with = |role: &str, with: &SignupWith| {
        let name = common::username(role);
        let user = User::new(&name, &format!("{name}@test.local"));
        Account::signup_with(device("Laptop"), &user, PASSWORD, with).map(|(account, _)| account)
    };
    assert_eq!(
        reason(signup_with("nobody", &SignupWith::new())),
        refusal::SIGNUP_CLOSED
    );

    // The first person on such a server comes in with a code.
    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    let code = runtime.block_on(async {
        let state = common::admin_state().await;
        admin::create_signup_code(&state, "the owner", 1)
            .await
            .expect("a signup code")
    });
    let owner = signup_with("owner", &SignupWith::new().signup_code(&code)).expect("the owner");
    let collection = new_collection(&owner, "Family");

    // An ordinary link invites people who have an account already.
    let plain = owner
        .create_invite_link(
            &collection,
            CollectionAccessLevel::ReadWrite,
            &LinkOptions::new(),
        )
        .unwrap();
    assert!(!plain.open(&device("Browser")).unwrap().can_signup());
    assert_eq!(
        reason(signup_with(
            "hopeful",
            &SignupWith::new().invite_link(&plain)
        )),
        refusal::SIGNUP_INVITATION_INVALID
    );

    // One made to bring a new person says so when it is opened.
    let welcoming = owner
        .create_invite_link(
            &collection,
            CollectionAccessLevel::ReadWrite,
            &LinkOptions::new().allow_signup(true),
        )
        .unwrap();
    let preview = welcoming.open(&device("Browser")).unwrap();
    assert!(preview.can_signup());
    assert_eq!(preview.collection_name(), Some("Family"));

    // The address alone creates no account either.
    assert_eq!(
        reason(signup_with(
            "forger",
            &SignupWith::new().invite_link(&with_guessed_secret(&welcoming))
        )),
        refusal::SIGNUP_INVITATION_INVALID
    );

    let guest = signup_with("guest", &SignupWith::new().invite_link(&welcoming))
        .expect("sign up by the link");
    // It was for one person, and that signup is spent.
    assert_eq!(
        reason(signup_with(
            "second",
            &SignupWith::new().invite_link(&welcoming)
        )),
        refusal::SIGNUP_INVITATION_INVALID
    );

    // Having an account is not yet being in the collection. Joining is the
    // same step as for anyone else, with the same link.
    let guest_collections = guest.collection_manager().unwrap();
    assert!(guest_collections.fetch(collection.uid(), None).is_err());
    guest.claim_invite_link(&welcoming).expect("join");
    let joined = guest_collections.fetch(collection.uid(), None).unwrap();
    assert_eq!(joined.meta().unwrap().name(), Some("Family"));
}
