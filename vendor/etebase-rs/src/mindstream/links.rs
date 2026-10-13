//! Invite links: an invitation addressed to whoever holds a secret.
//!
//! An ordinary invitation seals a collection's key to the public key of a
//! user the sender names. A link seals it to a key made up for the
//! occasion, derived from a secret that travels in the link itself, after
//! the `#`. Browsers do not send that part to a server and neither does
//! this library, so the server stores a sealed key it cannot open and
//! hands it to whoever can show they hold the secret.
//!
//! Two keys come out of the secret. One opens the sealed collection key.
//! The other signs every request about the link, and the server holds its
//! public half. A link's address without the secret therefore gets
//! nothing, which matters because addresses pass through logs, previews
//! and browser histories.

use std::convert::TryInto;
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_bytes::{ByteBuf, Bytes};
use url::Url;

use crate::crypto::{BoxCryptoManager, CryptoManager, LoginCryptoManager};
use crate::encrypted_models::{
    collection_item_name, AccountCryptoManager, CollectionAccessLevel, EncryptedItem,
    SignedInvitation, SignedInvitationContent,
};
use crate::error::{Error, Result};
use crate::http_client::Client;
use crate::utils::{buffer_unpad, from_base64, randombytes_array, to_base64, PUBLIC_KEY_SIZE};

use super::account::checked;

const LINK_SECRET_LEN: usize = 32;
/// The path a link's address has on its server, before the link's uid.
const JOIN_PATH: &str = "join/";

/// What tells the key a link's content is sealed to apart from anything
/// else derived from the secret. The hash it goes into takes a key of 16
/// bytes or more.
const SEAL_SALT: &[u8; 16] = b"InviteLinkSealer";

/// The version the keys of a link are derived under. It is fixed, because a
/// holder has to derive them before the server has said anything.
const LINK_VERSION: u8 = crate::CURRENT_VERSION;

/// The secret half of an invite link. Whoever holds it can join.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct LinkSecret([u8; LINK_SECRET_LEN]);

impl LinkSecret {
    fn generate() -> Self {
        Self(randombytes_array())
    }

    fn parse(text: &str) -> Option<Self> {
        let bytes = from_base64(text).ok()?;
        Some(Self(bytes.as_slice().try_into().ok()?))
    }

    fn crypto_manager(&self) -> Result<CryptoManager> {
        CryptoManager::new(&self.0, b"InvLink ", LINK_VERSION)
    }

    /// The key that signs requests about the link.
    fn signer(&self) -> Result<LoginCryptoManager> {
        LoginCryptoManager::keygen(&self.crypto_manager()?.asym_key_seed)
    }

    /// The key the collection key is sealed to.
    fn sealer(&self) -> Result<BoxCryptoManager> {
        BoxCryptoManager::keygen(Some(&self.crypto_manager()?.derive_subkey(SEAL_SALT)?))
    }
}

impl fmt::Debug for LinkSecret {
    // It lets its holder in. It has no business in a log.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LinkSecret(..)")
    }
}

/// An invite link: where it leads and the secret that opens it.
///
/// Its text form is the server's address, `join/`, the link's uid and,
/// after a `#`, the secret. Show it with `to_string` and read it back with
/// [`InviteLink::parse`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InviteLink {
    server: Url,
    uid: String,
    secret: LinkSecret,
}

impl InviteLink {
    /// Read a link from its text.
    pub fn parse(text: &str) -> Result<Self> {
        let not_one = || Error::Generic("That is not an invite link.".to_string());
        let mut url = Url::parse(text.trim()).map_err(|_| not_one())?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(not_one());
        }
        let secret = url
            .fragment()
            .and_then(LinkSecret::parse)
            .ok_or_else(not_one)?;
        url.set_fragment(None);
        url.set_query(None);

        // Everything before `join/<uid>` is the server, which may itself
        // live under a path.
        let path = url.path().trim_end_matches('/').to_string();
        let (base, uid) = path.rsplit_once('/').ok_or_else(not_one)?;
        let base = base
            .strip_suffix(JOIN_PATH.trim_end_matches('/'))
            .filter(|base| base.is_empty() || base.ends_with('/'))
            .ok_or_else(not_one)?;
        if !valid_uid(uid) {
            return Err(not_one());
        }
        let uid = uid.to_string();
        url.set_path(if base.is_empty() { "/" } else { base });
        Ok(Self {
            server: url,
            uid,
            secret,
        })
    }

    /// The server the link belongs to. Sign in or sign up there to use it.
    pub fn server_url(&self) -> &Url {
        &self.server
    }

    /// The link's uid, which is how the server and the link's maker refer
    /// to it. It is not a secret.
    pub fn uid(&self) -> &str {
        &self.uid
    }

    /// Look at what the link leads to. Needs no account, only the link.
    ///
    /// # Arguments:
    /// * `client` - a client for the link's server
    pub fn open(&self, client: &Client) -> Result<LinkPreview> {
        let opened = self.fetch(client)?;
        let content = opened.content(&self.secret)?;
        Ok(LinkPreview {
            collection_uid: opened.collection,
            // The name is a courtesy, as it is on an invitation.
            collection_name: collection_item_name(&opened.collection_item, &content.encryption_key)
                .unwrap_or(None),
            collection_type: content.collection_type,
            sender_username: opened.from_username,
            access_level: opened.access_level,
            signup: opened.signup,
        })
    }

    fn fetch(&self, client: &Client) -> Result<Opened> {
        #[derive(Serialize)]
        struct Body<'a> {
            signature: &'a Bytes,
        }

        let signature = self.proof("open", "")?;
        let body = rmp_serde::to_vec_named(&Body {
            signature: Bytes::new(&signature),
        })?;
        let url = link_url(client, &format!("{}/open/", self.uid))?;
        let res = client.post(&url, body)?;
        checked(&res)?;
        Ok(rmp_serde::from_slice(res.bytes())?)
    }

    /// The signature that shows the secret is held: over what is asked, of
    /// which link, as whom. The server compares usernames without regard to
    /// case, so the name is signed in lower case.
    pub(crate) fn proof(&self, action: &str, username: &str) -> Result<Vec<u8>> {
        let message = format!(
            "mindstream-link:{}:{}:{}",
            action,
            self.uid,
            username.to_ascii_lowercase()
        );
        self.secret.signer()?.sign_detached(message.as_bytes())
    }

    /// Join the collection the link leads to, as the account whose keys
    /// these are.
    pub(crate) fn claim(
        &self,
        client: &Client,
        account_crypto_manager: &AccountCryptoManager,
        username: &str,
    ) -> Result<()> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Body<'a> {
            signature: &'a Bytes,
            collection_type: &'a Bytes,
            encryption_key: &'a Bytes,
        }

        // The collection key, opened with the link's secret and wrapped
        // again under the account's own, exactly as accepting an invitation
        // does.
        let content = self.fetch(client)?.content(&self.secret)?;
        let collection_type = account_crypto_manager.collection_type_to_uid(&content.collection_type)?;
        let encryption_key = account_crypto_manager
            .0
            .encrypt(&content.encryption_key, Some(&collection_type))?;

        let signature = self.proof("claim", username)?;
        let body = rmp_serde::to_vec_named(&Body {
            signature: Bytes::new(&signature),
            collection_type: Bytes::new(&collection_type),
            encryption_key: Bytes::new(&encryption_key),
        })?;
        let url = link_url(client, &format!("{}/claim/", self.uid))?;
        let res = client.post(&url, body)?;
        checked(&res)
    }
}

impl fmt::Display for InviteLink {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let secret = to_base64(&self.secret.0).map_err(|_| fmt::Error)?;
        let mut server = self.server.to_string();
        if !server.ends_with('/') {
            server.push('/');
        }
        write!(f, "{}{}{}#{}", server, JOIN_PATH, self.uid, secret)
    }
}

/// A uid as the server accepts one.
fn valid_uid(uid: &str) -> bool {
    (1..=64).contains(&uid.len())
        && uid
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn link_url(client: &Client, path: &str) -> Result<String> {
    Ok(client
        .api_base
        .join("api/v1/mindstream/link/")?
        .join(path)?
        .into())
}

/// What a link's maker may set. The server's defaults are one person and a
/// week.
#[derive(Clone, Debug, Default)]
pub struct LinkOptions {
    max_uses: Option<u32>,
    expires_in: Option<u64>,
    allow_signup: bool,
}

impl LinkOptions {
    /// The server's defaults
    pub fn new() -> Self {
        Self::default()
    }

    /// How many people the link lets in
    pub fn max_uses(mut self, people: u32) -> Self {
        self.max_uses = Some(people);
        self
    }

    /// How long the link lasts, in seconds from now
    pub fn expires_in(mut self, seconds: u64) -> Self {
        self.expires_in = Some(seconds);
        self
    }

    /// Whether the link lets someone without an account create one on the
    /// server first. A server only allows this when its signup setting is
    /// `invite`.
    pub fn allow_signup(mut self, allow: bool) -> Self {
        self.allow_signup = allow;
        self
    }
}

/// A link as its maker and the other admins of the collection see it. It
/// does not hold the secret: that exists only in the link's text.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkInfo {
    uid: String,
    access_level: CollectionAccessLevel,
    max_uses: u32,
    uses: u32,
    allows_signup: bool,
    expires_at: i64,
    created_at: i64,
    from_username: String,
}

impl LinkInfo {
    /// The link's uid, for removing it
    pub fn uid(&self) -> &str {
        &self.uid
    }

    /// The access the link gives
    pub fn access_level(&self) -> CollectionAccessLevel {
        self.access_level
    }

    /// How many people the link lets in
    pub fn max_uses(&self) -> u32 {
        self.max_uses
    }

    /// How many it has let in so far
    pub fn uses(&self) -> u32 {
        self.uses
    }

    /// Whether the link lets its holder create an account
    pub fn allows_signup(&self) -> bool {
        self.allows_signup
    }

    /// When the link stops working, in seconds since 1970
    pub fn expires_at(&self) -> i64 {
        self.expires_at
    }

    /// When the link was made, in seconds since 1970
    pub fn created_at(&self) -> i64 {
        self.created_at
    }

    /// Who made it
    pub fn sender_username(&self) -> &str {
        &self.from_username
    }
}

/// What a link leads to, as far as its holder can see before joining.
#[derive(Clone, Debug, PartialEq)]
pub struct LinkPreview {
    collection_uid: String,
    collection_name: Option<String>,
    collection_type: String,
    sender_username: String,
    access_level: CollectionAccessLevel,
    signup: bool,
}

impl LinkPreview {
    /// The collection the link leads to
    pub fn collection_uid(&self) -> &str {
        &self.collection_uid
    }

    /// The collection's name, which the link's maker gave it
    pub fn collection_name(&self) -> Option<&str> {
        self.collection_name.as_deref()
    }

    /// The collection's type
    pub fn collection_type(&self) -> &str {
        &self.collection_type
    }

    /// Who made the link, as the server reports it
    pub fn sender_username(&self) -> &str {
        &self.sender_username
    }

    /// The access the link gives
    pub fn access_level(&self) -> CollectionAccessLevel {
        self.access_level
    }

    /// Whether the link can still be used to create an account on its
    /// server
    pub fn can_signup(&self) -> bool {
        self.signup
    }
}

/// The server's answer to opening a link.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Opened {
    collection: String,
    access_level: CollectionAccessLevel,
    signed_encryption_key: ByteBuf,
    from_username: String,
    from_pubkey: ByteBuf,
    collection_item: EncryptedItem,
    signup: bool,
}

impl Opened {
    /// What the link's maker sealed: the collection's key and type. Only
    /// someone who knew the public half of the link's sealing key could
    /// have made it, and the server never did.
    fn content(&self, secret: &LinkSecret) -> Result<SignedInvitationContent> {
        let from_pubkey: &[u8; PUBLIC_KEY_SIZE] = self.from_pubkey[..]
            .try_into()
            .map_err(|_| Error::Encryption("The link's sender key has the wrong length"))?;
        let raw = secret
            .sealer()?
            .decrypt(&self.signed_encryption_key, from_pubkey)?;
        Ok(rmp_serde::from_slice(&buffer_unpad(&raw)?)?)
    }
}

/// Make a link out of an invitation that was sealed to `secret`'s key, and
/// store it on the server.
pub(crate) fn create(
    client: &Client,
    secret: LinkSecret,
    sealed: &SignedInvitation,
    options: &LinkOptions,
) -> Result<InviteLink> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Body<'a> {
        uid: &'a str,
        version: u8,
        collection: &'a str,
        access_level: CollectionAccessLevel,
        signed_encryption_key: &'a Bytes,
        claim_pubkey: &'a Bytes,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_uses: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        expires_in: Option<u64>,
        allow_signup: bool,
    }

    let signer = secret.signer()?;
    // The invitation's uid is URL-safe base64 of 32 bytes, which is what
    // the server takes for a link's uid too.
    let uid = sealed.uid().to_string();
    let body = rmp_serde::to_vec_named(&Body {
        uid: &uid,
        version: LINK_VERSION,
        collection: sealed.collection(),
        access_level: sealed.access_level(),
        signed_encryption_key: Bytes::new(sealed.signed_encryption_key()),
        claim_pubkey: Bytes::new(signer.pubkey()),
        max_uses: options.max_uses,
        expires_in: options.expires_in,
        allow_signup: options.allow_signup,
    })?;
    let res = client.post(&link_url(client, "")?, body)?;
    checked(&res)?;
    Ok(InviteLink {
        server: client.server_url().clone(),
        uid,
        secret,
    })
}

/// A fresh secret and the public key to seal a collection's key to for it.
pub(crate) fn new_secret() -> Result<(LinkSecret, [u8; PUBLIC_KEY_SIZE])> {
    let secret = LinkSecret::generate();
    let pubkey = secret
        .sealer()?
        .pubkey()
        .try_into()
        .map_err(|_| Error::Encryption("The link's sealing key has the wrong length"))?;
    Ok((secret, pubkey))
}

/// The links into a collection that have not expired. One that is used up
/// stays listed until it expires, so that its maker can see it was used.
pub(crate) fn list(client: &Client, collection_uid: &str) -> Result<Vec<LinkInfo>> {
    #[derive(Deserialize)]
    struct Links {
        links: Vec<LinkInfo>,
    }

    let mut url = Url::parse(&link_url(client, "")?)?;
    url.query_pairs_mut().append_pair("collection", collection_uid);
    let res = client.get(url.as_str())?;
    checked(&res)?;
    Ok(rmp_serde::from_slice::<Links>(res.bytes())?.links)
}

/// Remove a link, so that it lets nobody else in.
pub(crate) fn revoke(client: &Client, uid: &str) -> Result<()> {
    if !valid_uid(uid) {
        return Err(Error::ProgrammingError("not a link uid"));
    }
    let res = client.delete(&link_url(client, &format!("{}/", uid))?)?;
    checked(&res)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(server: &str) -> InviteLink {
        InviteLink {
            server: Url::parse(server).unwrap(),
            uid: "AbC-123_xyz".to_string(),
            secret: LinkSecret([7; LINK_SECRET_LEN]),
        }
    }

    #[test]
    fn link_text_reads_back_as_the_same_link() {
        crate::init().unwrap();
        for server in [
            "https://notes.example.com/",
            "http://localhost:3735/",
            // A server behind a path keeps it.
            "https://example.com/notes/",
        ] {
            let link = link(server);
            let text = link.to_string();
            assert!(text.starts_with(server), "{text}");
            assert!(text.contains("join/AbC-123_xyz#"), "{text}");
            assert_eq!(InviteLink::parse(&text).unwrap(), link, "{text}");
            // Pasted with space around it, as links are.
            assert_eq!(InviteLink::parse(&format!("  {text}\n")).unwrap(), link);
        }
    }

    #[test]
    fn text_that_is_not_a_link_is_refused() {
        crate::init().unwrap();
        let good = link("https://notes.example.com/").to_string();
        let (address, secret) = good.split_once('#').unwrap();
        for text in [
            "",
            "hello",
            // No secret, or one of the wrong length.
            address,
            &format!("{address}#"),
            &format!("{address}#{}", &secret[..secret.len() - 4]),
            // Not under `join/`, or with no uid.
            &format!("https://notes.example.com/AbC-123_xyz#{secret}"),
            &format!("https://notes.example.com/join/#{secret}"),
            &format!("https://notes.example.com/rejoin/AbC-123_xyz#{secret}"),
            // Nothing a client should make a request to.
            &format!("mindstream://notes.example.com/join/AbC-123_xyz#{secret}"),
            &format!("javascript:join/AbC-123_xyz#{secret}"),
        ] {
            assert!(InviteLink::parse(text).is_err(), "{text:?}");
        }
    }

    #[test]
    fn the_two_keys_of_a_link_come_from_its_secret_alone() {
        crate::init().unwrap();
        let secret = LinkSecret([7; LINK_SECRET_LEN]);
        let again = LinkSecret([7; LINK_SECRET_LEN]);
        let other = LinkSecret([8; LINK_SECRET_LEN]);

        assert_eq!(
            secret.signer().unwrap().pubkey(),
            again.signer().unwrap().pubkey()
        );
        assert_eq!(
            secret.sealer().unwrap().pubkey(),
            again.sealer().unwrap().pubkey()
        );
        assert_ne!(
            secret.signer().unwrap().pubkey(),
            other.signer().unwrap().pubkey()
        );
        assert_ne!(
            secret.sealer().unwrap().pubkey(),
            other.sealer().unwrap().pubkey()
        );
        // The server holds the signing key's public half. It must say
        // nothing about the key that opens what the link carries.
        assert_ne!(
            secret.signer().unwrap().pubkey(),
            secret.sealer().unwrap().pubkey()
        );
    }

    #[test]
    fn proof_names_the_action_the_link_and_the_account() {
        crate::init().unwrap();
        let link = link("https://notes.example.com/");
        let claim = link.proof("claim", "Ann").unwrap();
        // The server compares usernames without regard to case.
        assert_eq!(claim, link.proof("claim", "ann").unwrap());
        assert_ne!(claim, link.proof("open", "ann").unwrap());
        assert_ne!(claim, link.proof("claim", "bob").unwrap());
        assert_eq!(claim.len(), 64);
    }

    #[test]
    fn secret_stays_out_of_debug_output() {
        let shown = format!("{:?}", link("https://notes.example.com/"));
        assert!(shown.contains("LinkSecret(..)"), "{shown}");
        assert!(!shown.contains("7, 7"), "{shown}");
    }
}
