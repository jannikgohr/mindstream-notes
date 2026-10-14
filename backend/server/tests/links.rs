//! Invite links and signing up by invitation: what the secret in a link
//! gets its holder, and what everyone without it is refused.

mod common;

use std::sync::OnceLock;

use common::keyed::{
    link_proof, new_key, new_uid, post, public, refused, Person, Reply, SignupWith,
};
use common::raw::{ADMIN, READ_ONLY, READ_WRITE};
use ed25519_dalek::SigningKey;
use mindstream_server::admin;
use mindstream_server::config::SignupPolicy;
use mindstream_server::limits::Entitlements;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;

fn url() -> &'static str {
    common::server()
}

/// A server where an invite link may also create an account.
fn invite_server() -> &'static str {
    static URL: OnceLock<String> = OnceLock::new();
    URL.get_or_init(|| common::start_server(|config| config.signup = SignupPolicy::Invite))
}

fn closed_server() -> &'static str {
    static URL: OnceLock<String> = OnceLock::new();
    URL.get_or_init(|| common::start_server(common::closed_signup))
}

/// What stands in for the collection key encrypted to the link.
const SEALED_KEY: &[u8] = b"collection key, sealed to the link";

/// A link as the person who made it holds it: its uid and the signing key
/// derived from its secret.
struct Link {
    uid: String,
    key: SigningKey,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Create<'a> {
    uid: &'a str,
    version: u8,
    collection: &'a str,
    access_level: i16,
    signed_encryption_key: ByteBuf,
    claim_pubkey: ByteBuf,
    max_uses: Option<i32>,
    expires_in: Option<i64>,
    allow_signup: bool,
}

impl<'a> Create<'a> {
    fn new(link: &'a Link, collection: &'a str) -> Self {
        Self {
            uid: &link.uid,
            version: 1,
            collection,
            access_level: READ_WRITE,
            signed_encryption_key: ByteBuf::from(SEALED_KEY.to_vec()),
            claim_pubkey: ByteBuf::from(public(&link.key)),
            max_uses: None,
            expires_in: None,
            allow_signup: false,
        }
    }
}

fn new_link() -> Link {
    Link {
        uid: new_uid(),
        key: new_key(),
    }
}

/// Make a link into `collection` with the server's defaults: one use, write
/// access.
async fn share_by_link(owner: &Person, collection: &str) -> Link {
    let link = new_link();
    let reply = owner
        .post("/mindstream/link/", &Create::new(&link, collection))
        .await;
    assert_eq!(reply.outcome(), refused(201, ""), "create a link");
    link
}

#[derive(Serialize)]
struct Proof {
    signature: ByteBuf,
}

async fn open(server: &str, link: &Link) -> Reply {
    open_with(server, &link.uid, &link.key, "open").await
}

async fn open_with(server: &str, uid: &str, key: &SigningKey, action: &str) -> Reply {
    let body = Proof {
        signature: ByteBuf::from(link_proof(key, action, uid, "")),
    };
    post(server, &format!("/mindstream/link/{uid}/open/"), &body).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Claim {
    signature: ByteBuf,
    collection_type: ByteBuf,
    encryption_key: ByteBuf,
}

async fn claim(person: &Person, link: &Link) -> Reply {
    claim_as(person, &link.uid, &link.key, &person.name).await
}

/// Claim with a proof made by `key` in the name of `signed_for`.
async fn claim_as(person: &Person, uid: &str, key: &SigningKey, signed_for: &str) -> Reply {
    let body = Claim {
        signature: ByteBuf::from(link_proof(key, "claim", uid, signed_for)),
        collection_type: ByteBuf::from(b"type".to_vec()),
        encryption_key: ByteBuf::from(b"my copy of the key".to_vec()),
    };
    person
        .post(&format!("/mindstream/link/{uid}/claim/"), &body)
        .await
}

async fn is_member(person: &Person, collection: &str) -> bool {
    person
        .get(&format!("/collection/{collection}/"))
        .await
        .status
        == 200
}

/// The links the owner sees for a collection, as (uid, uses, max uses).
async fn links_of(owner: &Person, collection: &str) -> Vec<(String, i64, i64)> {
    let reply = owner
        .get(&format!("/mindstream/link/?collection={collection}"))
        .await;
    assert_eq!(reply.status, 200, "list links");
    reply.value()["links"]
        .as_array()
        .expect("links")
        .iter()
        .map(|link| {
            (
                link["uid"].as_str().unwrap().to_owned(),
                link["uses"].as_i64().unwrap(),
                link["maxUses"].as_i64().unwrap(),
            )
        })
        .collect()
}

#[derive(Deserialize)]
struct Revision {
    meta: ByteBuf,
}

#[derive(Deserialize)]
struct Item {
    uid: String,
    content: Revision,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Opened {
    collection: String,
    access_level: i16,
    signed_encryption_key: ByteBuf,
    from_username: String,
    from_pubkey: ByteBuf,
    collection_item: Item,
    signup: bool,
}

#[tokio::test]
async fn link_shows_the_space_and_lets_one_person_in() {
    let owner = Person::signup(url(), "owner", false).await;
    let collection = owner.device().create_collection().await;
    let link = share_by_link(&owner, &collection).await;

    // Before joining, and before even having an account, the holder sees
    // who is inviting them and to what.
    let reply = open(url(), &link).await;
    assert_eq!(reply.status, 200);
    let opened: Opened = reply.decode();
    assert_eq!(opened.collection, collection);
    assert_eq!(opened.access_level, READ_WRITE);
    assert_eq!(&opened.signed_encryption_key[..], SEALED_KEY);
    assert_eq!(opened.from_username, owner.name);
    assert_eq!(&opened.from_pubkey[..], &[3u8; 32][..]);
    assert_eq!(opened.collection_item.uid, collection);
    assert_eq!(&opened.collection_item.content.meta[..], b"meta");
    assert!(!opened.signup);

    let guest = Person::signup(url(), "guest", false).await;
    assert!(!is_member(&guest, &collection).await);
    assert_eq!(claim(&guest, &link).await.outcome(), refused(201, ""));
    assert!(is_member(&guest, &collection).await);
    // With the access the link named.
    let (status, _) = guest.device().try_add_item(&collection).await;
    assert_eq!(status, 200);
    assert_eq!(
        links_of(&owner, &collection).await,
        vec![(link.uid.clone(), 1, 1)]
    );

    // It was good for one person.
    let late = Person::signup(url(), "late", false).await;
    assert_eq!(
        claim(&late, &link).await.outcome(),
        refused(410, "link_used")
    );
    assert_eq!(
        open(url(), &link).await.outcome(),
        refused(410, "link_used")
    );
    assert!(!is_member(&late, &collection).await);
    // The one who joined is told so, not that the link ran out.
    assert_eq!(
        claim(&guest, &link).await.outcome(),
        refused(409, "already_member")
    );
}

#[tokio::test]
async fn uid_without_the_secret_gets_nothing() {
    let owner = Person::signup(url(), "owner", false).await;
    let collection = owner.device().create_collection().await;
    let link = share_by_link(&owner, &collection).await;
    let guest = Person::signup(url(), "guest", false).await;
    let unknown = refused(404, "does_not_exist");

    // Someone who saw the address, without the part after the `#`, cannot
    // tell this link from one that was never made.
    let guess = new_key();
    assert_eq!(
        open_with(url(), &link.uid, &guess, "open").await.outcome(),
        unknown
    );
    assert_eq!(
        open_with(url(), &new_uid(), &guess, "open").await.outcome(),
        unknown
    );
    assert_eq!(
        claim_as(&guest, &link.uid, &guess, &guest.name)
            .await
            .outcome(),
        unknown
    );

    // A proof says what it is for. One made to look is not one to join, and
    // one made for another account is no use to this one.
    assert_eq!(
        open_with(url(), &link.uid, &link.key, "claim")
            .await
            .outcome(),
        unknown
    );
    assert_eq!(
        claim_as(&guest, &link.uid, &link.key, &owner.name)
            .await
            .outcome(),
        unknown
    );
    assert_eq!(
        claim_as(&guest, &link.uid, &link.key, "").await.outcome(),
        unknown
    );

    // None of that used the link up.
    assert!(!is_member(&guest, &collection).await);
    assert_eq!(
        links_of(&owner, &collection).await,
        vec![(link.uid.clone(), 0, 1)]
    );
    assert_eq!(claim(&guest, &link).await.outcome(), refused(201, ""));
}

#[tokio::test]
async fn only_admins_make_see_and_remove_links() {
    let owner = Person::signup(url(), "owner", false).await;
    let writer = Person::signup(url(), "writer", false).await;
    let outsider = Person::signup(url(), "outsider", false).await;
    let collection = owner.device().create_collection().await;
    owner
        .device()
        .share(&collection, &writer.device(), READ_WRITE)
        .await;
    let listing = format!("/mindstream/link/?collection={collection}");

    let link = new_link();
    let body = Create::new(&link, &collection);
    assert_eq!(
        writer.post("/mindstream/link/", &body).await.outcome(),
        refused(403, "admin_access_required")
    );
    assert_eq!(writer.get(&listing).await.status, 403);
    // To someone outside, the collection does not exist.
    assert_eq!(outsider.post("/mindstream/link/", &body).await.status, 404);
    assert_eq!(outsider.get(&listing).await.status, 404);

    // What a link may not be.
    let refused_shapes = [
        Create {
            access_level: ADMIN,
            ..Create::new(&link, &collection)
        },
        Create {
            max_uses: Some(0),
            ..Create::new(&link, &collection)
        },
        Create {
            max_uses: Some(101),
            ..Create::new(&link, &collection)
        },
        Create {
            expires_in: Some(10),
            ..Create::new(&link, &collection)
        },
        Create {
            expires_in: Some(91 * 24 * 3600),
            ..Create::new(&link, &collection)
        },
        Create {
            claim_pubkey: ByteBuf::from(vec![1; 31]),
            ..Create::new(&link, &collection)
        },
        Create {
            signed_encryption_key: ByteBuf::new(),
            ..Create::new(&link, &collection)
        },
    ];
    for shape in &refused_shapes {
        assert_eq!(owner.post("/mindstream/link/", shape).await.status, 400);
    }
    assert!(links_of(&owner, &collection).await.is_empty());

    // What it may be: read-only, for several people, for a set time.
    let several = Create {
        access_level: READ_ONLY,
        max_uses: Some(3),
        expires_in: Some(3600),
        ..Create::new(&link, &collection)
    };
    let reply = owner.post("/mindstream/link/", &several).await;
    assert_eq!(reply.status, 201);
    let made = reply.value();
    assert_eq!(made["maxUses"], 3);
    assert_eq!(made["fromUsername"], owner.name.as_str());
    let lifetime = made["expiresAt"].as_i64().unwrap() - made["createdAt"].as_i64().unwrap();
    assert_eq!(lifetime, 3600);
    // The same uid again is refused.
    assert_eq!(owner.post("/mindstream/link/", &several).await.status, 409);

    let reader = Person::signup(url(), "reader", false).await;
    assert_eq!(claim(&reader, &link).await.status, 201);
    let (status, _) = reader.device().try_add_item(&collection).await;
    assert_eq!(status, 403, "a read-only link gave write access");

    // A member who is not an admin cannot remove it. The owner can, and
    // then it is gone for everyone.
    let path = format!("/mindstream/link/{}/", link.uid);
    assert_eq!(writer.delete(&path).await.status, 404);
    assert_eq!(owner.delete(&path).await.outcome(), refused(204, ""));
    assert_eq!(owner.delete(&path).await.status, 404);
    assert_eq!(open(url(), &link).await.status, 404);
    assert_eq!(claim(&outsider, &link).await.status, 404);
    // Whoever already joined stays.
    assert!(is_member(&reader, &collection).await);
}

#[tokio::test]
async fn link_stands_only_while_its_maker_is_an_admin() {
    let owner = Person::signup(url(), "owner", false).await;
    let helper = Person::signup(url(), "helper", false).await;
    let collection = owner.device().create_collection().await;
    owner
        .device()
        .share(&collection, &helper.device(), ADMIN)
        .await;
    let link = share_by_link(&helper, &collection).await;
    assert_eq!(open(url(), &link).await.status, 200);

    // It carried the helper's authority, and that is gone.
    owner
        .device()
        .set_access(&collection, &helper.device(), READ_WRITE)
        .await;
    assert_eq!(open(url(), &link).await.status, 404);
    let guest = Person::signup(url(), "guest", false).await;
    assert_eq!(claim(&guest, &link).await.status, 404);
    assert!(!is_member(&guest, &collection).await);

    owner
        .device()
        .remove_member(&collection, &helper.device())
        .await;
    assert_eq!(open(url(), &link).await.status, 404);
}

/// A claim that arrives while the link's maker is being removed waits for
/// the collection, and when its turn comes the link no longer stands.
#[tokio::test]
async fn claim_that_waited_out_its_makers_removal_grants_nothing() {
    let owner = Person::signup(url(), "owner", false).await;
    let helper = Person::signup(url(), "helper", false).await;
    let collection = owner.device().create_collection().await;
    owner
        .device()
        .share(&collection, &helper.device(), ADMIN)
        .await;
    let link = share_by_link(&helper, &collection).await;
    let guest = Person::signup(url(), "guest", false).await;

    // The helper's removal, held open while the guest claims.
    let pool = sqlx::PgPool::connect(&common::database_url())
        .await
        .unwrap();
    let mut removal = pool.begin().await.unwrap();
    sqlx::query(
        "DELETE FROM members m USING collections c, accounts a
         WHERE c.uid = $1 AND a.username = $2
           AND m.collection_id = c.id AND m.account_id = a.id",
    )
    .bind(&collection)
    .bind(&helper.name)
    .execute(&mut *removal)
    .await
    .unwrap();
    sqlx::query("SELECT 1 FROM collections WHERE uid = $1 FOR UPDATE")
        .bind(&collection)
        .execute(&mut *removal)
        .await
        .unwrap();
    let remove = async {
        common::wait_until_blocked(&pool, "FOR UPDATE").await;
        removal.commit().await.unwrap();
    };
    let (claimed, ()) = tokio::join!(claim(&guest, &link), remove);
    assert_eq!(claimed.status, 404);
    assert!(!is_member(&guest, &collection).await);
}

/// Deleting the collection, which is how a share is stopped, withdraws the
/// links into it, and no new one can be made.
#[tokio::test]
async fn stopping_a_share_withdraws_its_links() {
    let owner = Person::signup(url(), "owner", false).await;
    let collection = owner.device().create_collection().await;
    let link = share_by_link(&owner, &collection).await;
    owner.device().delete_item(&collection, &collection).await;
    assert_eq!(open(url(), &link).await.status, 404);
    let guest = Person::signup(url(), "guest", false).await;
    assert_eq!(claim(&guest, &link).await.status, 404);
    assert!(!is_member(&guest, &collection).await);
    let reply = owner
        .post("/mindstream/link/", &Create::new(&new_link(), &collection))
        .await;
    assert_eq!(reply.outcome(), refused(403, "collection_deleted"));
}

#[tokio::test]
async fn expired_link_is_refused() {
    let owner = Person::signup(url(), "owner", false).await;
    let collection = owner.device().create_collection().await;
    let link = share_by_link(&owner, &collection).await;
    assert_eq!(links_of(&owner, &collection).await.len(), 1);

    // Nobody waits a week in a test. Move the expiry instead.
    let pool = sqlx::PgPool::connect(&common::database_url())
        .await
        .unwrap();
    sqlx::query("UPDATE invite_links SET expires_at = now() - interval '1 second' WHERE uid = $1")
        .bind(&link.uid)
        .execute(&pool)
        .await
        .unwrap();

    assert_eq!(
        open(url(), &link).await.outcome(),
        refused(410, "link_expired")
    );
    let guest = Person::signup(url(), "guest", false).await;
    assert_eq!(
        claim(&guest, &link).await.outcome(),
        refused(410, "link_expired")
    );
    assert!(!is_member(&guest, &collection).await);
    assert!(links_of(&owner, &collection).await.is_empty());
}

#[tokio::test]
async fn link_cannot_take_a_space_past_its_owners_member_limit() {
    let owner = Person::signup(url(), "owner", false).await;
    let collection = owner.device().create_collection().await;
    let state = common::admin_state().await;
    let plan = Entitlements {
        plan: "small".into(),
        storage_limit_bytes: None,
        max_spaces: None,
        max_members_per_space: Some(2),
        max_item_bytes: None,
        read_only: false,
    };
    assert!(admin::set_entitlements(&state, &owner.name, Some(&plan))
        .await
        .unwrap());

    let link = new_link();
    let roomy = Create {
        max_uses: Some(5),
        ..Create::new(&link, &collection)
    };
    assert_eq!(owner.post("/mindstream/link/", &roomy).await.status, 201);

    let first = Person::signup(url(), "first", false).await;
    assert_eq!(claim(&first, &link).await.status, 201);
    // The link has uses left. The space does not have room.
    let second = Person::signup(url(), "second", false).await;
    assert_eq!(
        claim(&second, &link).await.outcome(),
        refused(402, "member_limit")
    );
    assert!(!is_member(&second, &collection).await);
    assert_eq!(
        links_of(&owner, &collection).await,
        vec![(link.uid.clone(), 1, 5)]
    );
    // And no further link is handed out for a full space.
    let another = new_link();
    assert_eq!(
        owner
            .post("/mindstream/link/", &Create::new(&another, &collection))
            .await
            .outcome(),
        refused(402, "member_limit")
    );
}

#[tokio::test]
async fn joining_by_link_reaches_the_devices_already_there() {
    let owner = Person::signup(url(), "owner", false).await;
    let collection = owner.device().create_collection().await;
    let link = share_by_link(&owner, &collection).await;
    let guest = Person::signup(url(), "guest", false).await;
    let tablet = guest
        .login(&guest.login, &common::keyed::Extra::none(), "Tablet")
        .await
        .unwrap();
    let mut owner_feed = owner.device().feed().await;
    let mut tablet_feed = tablet.device().feed().await;

    assert_eq!(claim(&guest, &link).await.status, 201);

    // The owner has a new member to show and a link whose count moved.
    assert_eq!(owner_feed.news().await, Some((true, true)));
    // The guest's other device has a new space to fetch.
    assert_eq!(tablet_feed.news().await, Some((true, false)));
}

#[tokio::test]
async fn invitation_shows_the_space_before_it_is_accepted() {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Invitation {
        uid: String,
        collection: String,
        collection_item: Option<Item>,
    }
    #[derive(Deserialize)]
    struct List {
        data: Vec<Invitation>,
    }

    let owner = Person::signup(url(), "owner", false).await;
    let guest = Person::signup(url(), "guest", false).await;
    let collection = owner.device().create_collection().await;
    let invitation = owner
        .device()
        .invite(&collection, &guest.device(), READ_WRITE)
        .await;

    let incoming: List = guest.get("/invitation/incoming/").await.decode();
    assert_eq!(incoming.data.len(), 1);
    let received = &incoming.data[0];
    assert_eq!(received.uid, invitation);
    assert_eq!(received.collection, collection);
    let item = received.collection_item.as_ref().expect("the space's item");
    assert_eq!(item.uid, collection);
    assert_eq!(&item.content.meta[..], b"meta");

    let single: Invitation = guest
        .get(&format!("/invitation/incoming/{invitation}/"))
        .await
        .decode();
    assert!(single.collection_item.is_some());

    // The sender has the collection and is not sent it again.
    let outgoing: List = owner.get("/invitation/outgoing/").await.decode();
    assert_eq!(outgoing.data.len(), 1);
    assert!(outgoing.data[0].collection_item.is_none());
}

#[tokio::test]
async fn signup_code_lets_one_person_onto_a_closed_server() {
    let server = closed_server();
    let refused_plain = Person::signup_with(server, "nobody", SignupWith::default()).await;
    assert_eq!(refused_plain.err(), Some(refused(403, "signup_closed")));

    let state = common::admin_state().await;
    let code = admin::create_signup_code(&state, "for Ann", 7)
        .await
        .unwrap();
    let wrong = SignupWith {
        code: Some("AAAAA-AAAAA-AAAAA-AAAAA"),
        ..SignupWith::default()
    };
    assert_eq!(
        Person::signup_with(server, "guesser", wrong).await.err(),
        Some(refused(403, "signup_invitation_invalid"))
    );

    // Typed the way a person would, not the way it was printed.
    let typed = code.to_lowercase().replace('-', " ");
    let with_code = || SignupWith {
        code: Some(&typed),
        ..SignupWith::default()
    };
    let ann = Person::signup_with(server, "ann", with_code())
        .await
        .expect("signup with a code");
    assert!(ann.signed_in().await);
    assert_eq!(
        Person::signup_with(server, "second", with_code())
            .await
            .err(),
        Some(refused(403, "signup_invitation_invalid"))
    );

    let listed = admin::list_signup_codes(&state).await.unwrap();
    let row = listed
        .iter()
        .find(|row| row.used_by.as_deref() == Some(ann.name.as_str()))
        .expect("the code is listed as used");
    assert_eq!(row.note, "for Ann");
    assert!(row.used && !row.expired);
    // A used code stays on record. An unused one can be withdrawn.
    assert!(!admin::revoke_signup_code(&state, row.id).await.unwrap());
    let spare = admin::create_signup_code(&state, "spare", 7).await.unwrap();
    let listed = admin::list_signup_codes(&state).await.unwrap();
    let spare_id = listed.iter().map(|row| row.id).max().unwrap();
    assert!(admin::revoke_signup_code(&state, spare_id).await.unwrap());
    let withdrawn = SignupWith {
        code: Some(&spare),
        ..SignupWith::default()
    };
    assert_eq!(
        Person::signup_with(server, "late", withdrawn).await.err(),
        Some(refused(403, "signup_invitation_invalid"))
    );

    // Here a link cannot create accounts, and none can be made that claims
    // to.
    let collection = ann.device().create_collection().await;
    let link = new_link();
    let hopeful = Create {
        allow_signup: true,
        ..Create::new(&link, &collection)
    };
    assert_eq!(
        ann.post("/mindstream/link/", &hopeful).await.outcome(),
        refused(403, "signup_closed")
    );
    let plain = share_by_link(&ann, &collection).await;
    let by_link = SignupWith {
        link: Some((&plain.uid, &plain.key)),
        ..SignupWith::default()
    };
    assert_eq!(
        Person::signup_with(server, "by-link", by_link).await.err(),
        Some(refused(403, "signup_closed"))
    );
}

#[tokio::test]
async fn link_can_bring_someone_without_an_account() {
    let server = invite_server();
    let info: serde_json::Value = reqwest::get(format!("{server}/api/v1/mindstream/info/"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(info["signup"], "invite");
    assert_eq!(
        Person::signup_with(server, "nobody", SignupWith::default())
            .await
            .err(),
        Some(refused(403, "signup_closed"))
    );

    let state = common::admin_state().await;
    let code = admin::create_signup_code(&state, "the owner", 1)
        .await
        .unwrap();
    let owner = Person::signup_with(
        server,
        "owner",
        SignupWith {
            code: Some(&code),
            ..SignupWith::default()
        },
    )
    .await
    .expect("the owner signs up with a code");
    let collection = owner.device().create_collection().await;

    // An ordinary link invites people who have an account already.
    let plain = share_by_link(&owner, &collection).await;
    let opened: Opened = open(server, &plain).await.decode();
    assert!(!opened.signup);
    let by = |link: &'static Link| SignupWith {
        link: Some((&link.uid, &link.key)),
        ..SignupWith::default()
    };
    let plain: &'static Link = Box::leak(Box::new(plain));
    assert_eq!(
        Person::signup_with(server, "hopeful", by(plain))
            .await
            .err(),
        Some(refused(403, "signup_invitation_invalid"))
    );

    // One made to bring a new person says so when opened.
    let welcoming: &'static Link = Box::leak(Box::new(new_link()));
    let body = Create {
        allow_signup: true,
        ..Create::new(welcoming, &collection)
    };
    assert_eq!(owner.post("/mindstream/link/", &body).await.status, 201);
    let opened: Opened = open(server, welcoming).await.decode();
    assert!(opened.signup);

    // The proof names the account being created, so it cannot be lifted
    // onto another signup. `signup_with` signs for the name it makes up; a
    // key that is not the link's stands for any other forgery.
    let forged = Link {
        uid: welcoming.uid.clone(),
        key: new_key(),
    };
    let forged: &'static Link = Box::leak(Box::new(forged));
    assert_eq!(
        Person::signup_with(server, "forger", by(forged))
            .await
            .err(),
        Some(refused(403, "signup_invitation_invalid"))
    );

    let guest = Person::signup_with(server, "guest", by(welcoming))
        .await
        .expect("signup by link");
    // The link was for one person, and that signup is spent.
    assert_eq!(
        Person::signup_with(server, "second", by(welcoming))
            .await
            .err(),
        Some(refused(403, "signup_invitation_invalid"))
    );
    let opened: Opened = open(server, welcoming).await.decode();
    assert!(!opened.signup);

    // Having an account is not yet being a member. Joining is the same
    // step as for anyone else.
    assert!(!is_member(&guest, &collection).await);
    assert_eq!(claim(&guest, welcoming).await.status, 201);
    assert!(is_member(&guest, &collection).await);
}

/// Make a link into `collection` that also lets one new person sign up.
async fn welcoming_link(owner: &Person, collection: &str) -> Link {
    let link = new_link();
    let body = Create {
        allow_signup: true,
        ..Create::new(&link, collection)
    };
    assert_eq!(owner.post("/mindstream/link/", &body).await.status, 201);
    link
}

/// One use means one person in, however the signup and the claim interleave:
/// a claim spends the link's place, and a signup on a spent link is refused.
/// (A signup alone is not membership: the account it creates still joins
/// with the same link, which is why the budgets are separate.)
#[tokio::test]
async fn one_use_signup_link_admits_one_person_either_way_round() {
    let server = invite_server();
    let state = common::admin_state().await;
    let code = admin::create_signup_code(&state, "the owner", 1)
        .await
        .unwrap();
    let owner = Person::signup_with(
        server,
        "owner",
        SignupWith {
            code: Some(&code),
            ..SignupWith::default()
        },
    )
    .await
    .expect("the owner signs up with a code");
    let collection = owner.device().create_collection().await;
    let by = |link: &'static Link| SignupWith {
        link: Some((&link.uid, &link.key)),
        ..SignupWith::default()
    };

    // Claim first: the place is taken, so signing up on the link is refused.
    // (Plain accounts come from the open server; every test server shares
    // the database, so the link is the same one.)
    let spent: &'static Link = Box::leak(Box::new(welcoming_link(&owner, &collection).await));
    let first = Person::signup(url(), "first", false).await;
    assert_eq!(claim(&first, spent).await.outcome(), refused(201, ""));
    assert_eq!(
        Person::signup_with(server, "late", by(spent)).await.err(),
        Some(refused(403, "signup_invitation_invalid"))
    );
    assert_eq!(
        open(server, spent).await.outcome(),
        refused(410, "link_used")
    );

    // Signup first: the new account still joins on the same link, and then
    // the link is spent for everyone else.
    let welcoming: &'static Link =
        Box::leak(Box::new(welcoming_link(&owner, &collection).await));
    let guest = Person::signup_with(server, "guest", by(welcoming))
        .await
        .expect("signup by link");
    assert_eq!(claim(&guest, welcoming).await.outcome(), refused(201, ""));
    assert!(is_member(&guest, &collection).await);
    assert_eq!(
        Person::signup_with(server, "second", by(welcoming))
            .await
            .err(),
        Some(refused(403, "signup_invitation_invalid"))
    );
    let late = Person::signup(url(), "late", false).await;
    assert_eq!(
        claim(&late, welcoming).await.outcome(),
        refused(410, "link_used")
    );
}

#[tokio::test]
async fn landing_page_tells_a_browser_what_to_do_with_a_link() {
    let http = reqwest::Client::new();
    let address = format!("{}/join/some-link-uid", url());
    let response = http.get(&address).send().await.unwrap();
    assert_eq!(response.status(), 200);
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .map(|value| value.to_str().unwrap().to_owned())
            .unwrap_or_default()
    };
    assert!(header("content-type").starts_with("text/html"));
    let policy = header("content-security-policy");
    assert!(policy.starts_with("default-src 'none'"), "{policy}");
    assert_eq!(header("referrer-policy"), "no-referrer");
    assert_eq!(header("cache-control"), "no-store");
    let page = response.text().await.unwrap();
    assert!(page.contains("Join shared folder…"));
    assert!(page.contains("data-scheme=\"mindstream-notes\""));
    assert!(page.contains("https://example.com/app"));
    // The page is the same for every link and says nothing about this one.
    assert!(!page.contains("some-link-uid"));

    let german = http
        .get(&address)
        .header("Accept-Language", "de-DE,de;q=0.9,en;q=0.5")
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(german.contains("Geteiltem Ordner beitreten…"));
}
