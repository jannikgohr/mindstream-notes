//! What a Mindstream server offers beyond the Etebase protocol.
//!
//! Everything here needs a Mindstream server. A stock Etebase server answers
//! these calls with a not-found error.

use std::sync::Arc;

use serde::Deserialize;
use url::Url;

use super::encrypted_models::CollectionAccessLevel;
use super::error::{Error, Result};
use super::http_client::Client;

mod account;

pub use account::{
    refusal, AccountSecurity, AuthenticatorSetup, DeviceSession, Recovery, RecoveryKey,
    SecurityStatus, SignupWith,
};

/// A short-lived pass into the live room of one item.
///
/// The server hands one out to a member of the item's collection. Whoever
/// presents it on a room socket is let in as that member, so the socket
/// itself needs no session token. That is the point: the ticket can be given
/// to a part of the application that should never hold the session, such as
/// a web view.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RoomTicket {
    ticket: String,
    expires_in: u64,
    access_level: CollectionAccessLevel,
}

impl RoomTicket {
    /// The ticket itself, to send as the first frame on the room socket
    pub fn ticket(&self) -> &str {
        &self.ticket
    }

    /// Seconds until the server stops accepting the ticket
    pub fn expires_in(&self) -> u64 {
        self.expires_in
    }

    /// The access the member had when the ticket was issued. The server looks
    /// it up again when the socket opens, so this is for showing, not for
    /// deciding.
    pub fn access_level(&self) -> CollectionAccessLevel {
        self.access_level
    }
}

/// Where the change feed is, and what to present when connecting to it.
///
/// The feed is a socket on which the server says that something changed and
/// a sync is worth running. It carries no data. Unlike a room it is opened
/// with the session token itself, so it is for the part of an application
/// that already holds the session. Do not hand one of these to a web view.
#[derive(Clone)]
pub struct FeedEndpoint {
    url: String,
    authorization: String,
}

impl FeedEndpoint {
    /// The feed's address, a `ws` or `wss` URL
    pub fn url(&self) -> &str {
        &self.url
    }

    /// The value of the `Authorization` header to send with the request that
    /// opens the socket
    pub fn authorization(&self) -> &str {
        &self.authorization
    }
}

impl std::fmt::Debug for FeedEndpoint {
    // The header holds the session token, which has no business in a log.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FeedEndpoint")
            .field("url", &self.url)
            .finish_non_exhaustive()
    }
}

/// The Mindstream routes, for a signed-in account.
///
/// Get one from [`Account::mindstream`](crate::Account::mindstream).
pub struct Mindstream {
    client: Arc<Client>,
}

impl Mindstream {
    pub(crate) fn new(client: Arc<Client>) -> Self {
        Self { client }
    }

    /// Ask for a ticket into the live room of an item
    ///
    /// # Arguments:
    /// * `collection_uid` - the collection the item is in
    /// * `item_uid` - the item whose room to enter
    pub fn room_ticket(&self, collection_uid: &str, item_uid: &str) -> Result<RoomTicket> {
        let url = self.client.api_base.join(&format!(
            "api/v1/collection/{}/item/{}/room-ticket/",
            collection_uid, item_uid
        ))?;
        let res = self.client.post(url.as_str(), vec![])?;
        res.error_for_status()?;
        Ok(rmp_serde::from_slice(res.bytes())?)
    }

    /// The address room sockets connect to
    pub fn room_url(&self) -> Result<String> {
        socket_url(&self.client.api_base, "api/v1/room/")
    }

    /// Where to listen for the server saying that a sync is worth running
    pub fn feed_endpoint(&self) -> Result<FeedEndpoint> {
        let token = self.client.token().ok_or(Error::ProgrammingError(
            "the change feed needs a signed-in account",
        ))?;
        Ok(FeedEndpoint {
            url: socket_url(&self.client.api_base, "api/v1/mindstream/feed/")?,
            authorization: format!("Token {}", token),
        })
    }
}

/// The server's own address with a socket scheme: `wss` where the API is
/// reached over `https`, `ws` otherwise.
fn socket_url(api_base: &Url, path: &str) -> Result<String> {
    let mut url = api_base.join(path)?;
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(scheme)
        .map_err(|_| Error::UrlParse(format!("cannot make a socket address of {}", api_base)))?;
    Ok(url.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_address_follows_the_servers() {
        let at = |base: &str| socket_url(&Url::parse(base).unwrap(), "api/v1/room/").unwrap();
        assert_eq!(
            at("https://notes.example.com/"),
            "wss://notes.example.com/api/v1/room/"
        );
        assert_eq!(
            at("http://localhost:3735/"),
            "ws://localhost:3735/api/v1/room/"
        );
        // A server behind a path keeps it.
        assert_eq!(
            at("https://example.com/notes/"),
            "wss://example.com/notes/api/v1/room/"
        );
    }
}
