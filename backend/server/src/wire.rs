//! The msgpack bodies the client sends and expects.
//!
//! Field names and shapes follow what the etebase-rs client serialises and
//! deserialises. Requests tolerate fields this server does not use, since the
//! Rust and JavaScript clients do not send exactly the same set.

use axum::body::Bytes;
use axum::extract::{FromRequest, Request};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;

use crate::error::ApiError;

pub const ACCESS_READ_ONLY: i16 = 0;
pub const ACCESS_ADMIN: i16 = 1;
pub const ACCESS_READ_WRITE: i16 = 2;

pub fn valid_access_level(level: i16) -> bool {
    matches!(level, ACCESS_READ_ONLY | ACCESS_ADMIN | ACCESS_READ_WRITE)
}

/// Uids arrive from the client and end up in SQL parameters, URLs and blob
/// paths. They are URL-safe base64 everywhere the client generates them, so
/// anything else is refused outright.
pub fn valid_uid(uid: &str) -> bool {
    (1..=64).contains(&uid.len())
        && uid
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn check_uid(uid: &str) -> Result<(), ApiError> {
    if valid_uid(uid) {
        Ok(())
    } else {
        Err(ApiError::bad_request("Malformed uid"))
    }
}

pub fn msgpack_response<T: Serialize>(status: StatusCode, body: &T) -> Response {
    match rmp_serde::to_vec_named(body) {
        Ok(bytes) => (
            status,
            [(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/msgpack"),
            )],
            bytes,
        )
            .into_response(),
        Err(err) => {
            tracing::error!("failed to encode a response: {err}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// A msgpack request body, and a 200 msgpack response.
pub struct Msgpack<T>(pub T);

impl<S, T> FromRequest<S> for Msgpack<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let bytes = Bytes::from_request(req, state)
            .await
            .map_err(|err| ApiError::new(err.status(), "bad_request", err.body_text()))?;
        rmp_serde::from_slice(&bytes)
            .map(Msgpack)
            .map_err(|err| ApiError::bad_request(format!("Malformed request body: {err}")))
    }
}

impl<T: Serialize> IntoResponse for Msgpack<T> {
    fn into_response(self) -> Response {
        msgpack_response(StatusCode::OK, &self.0)
    }
}

/// `[uid, content]`. The content is absent when the client expects the server
/// to hold the chunk already, and when the server leaves it for the client to
/// download separately.
#[derive(Serialize, Deserialize, Debug)]
pub struct Chunk(pub String, #[serde(default)] pub Option<ByteBuf>);

#[derive(Serialize, Deserialize, Debug)]
pub struct Revision {
    pub uid: String,
    pub meta: ByteBuf,
    pub deleted: bool,
    pub chunks: Vec<Chunk>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub uid: String,
    pub version: u8,
    #[serde(default)]
    pub encryption_key: Option<ByteBuf>,
    pub content: Revision,
    /// The revision the client last saw. Sent on upload so a transaction can
    /// detect a concurrent change; never sent back.
    #[serde(default, skip_serializing)]
    pub etag: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub item: Item,
    pub access_level: i16,
    pub collection_key: ByteBuf,
    pub collection_type: ByteBuf,
    pub stoken: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CollectionCreate {
    pub item: Item,
    pub collection_key: ByteBuf,
    pub collection_type: ByteBuf,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ListMulti {
    pub collection_types: Vec<ByteBuf>,
}

#[derive(Serialize, Debug)]
pub struct RemovedCollection {
    pub uid: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CollectionList {
    pub data: Vec<Collection>,
    pub stoken: Option<String>,
    pub done: bool,
    /// Absent, not empty, when there are none: the client tells the two
    /// apart.
    pub removed_memberships: Option<Vec<RemovedCollection>>,
}

#[derive(Serialize, Debug)]
pub struct ItemList {
    pub data: Vec<Item>,
    pub stoken: Option<String>,
    pub done: bool,
}

#[derive(Serialize, Debug)]
pub struct IteratorList<T> {
    pub data: Vec<T>,
    pub iterator: Option<String>,
    pub done: bool,
}

#[derive(Deserialize, Debug)]
pub struct ItemRef {
    pub uid: String,
    #[serde(default)]
    pub etag: Option<String>,
}

#[derive(Deserialize, Debug)]
pub struct ItemBatch {
    pub items: Vec<Item>,
    #[serde(default)]
    pub deps: Option<Vec<ItemRef>>,
}

/// The query options the client appends to list and fetch requests.
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct FetchQuery {
    pub stoken: Option<String>,
    pub limit: Option<i64>,
    pub iterator: Option<String>,
    pub prefetch: Option<String>,
    pub with_collection: Option<String>,
}

impl FetchQuery {
    pub const DEFAULT_LIMIT: i64 = 50;
    pub const MAX_LIMIT: i64 = 1000;

    pub fn limit(&self) -> i64 {
        self.limit
            .unwrap_or(Self::DEFAULT_LIMIT)
            .clamp(1, Self::MAX_LIMIT)
    }

    /// `prefetch=medium` asks for items without their content.
    pub fn with_content(&self) -> bool {
        self.prefetch.as_deref() != Some("medium")
    }

    pub fn with_collection(&self) -> bool {
        matches!(self.with_collection.as_deref(), Some("true" | "True" | "1"))
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct User {
    pub username: String,
    pub email: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Signup {
    pub user: User,
    pub salt: ByteBuf,
    pub login_pubkey: ByteBuf,
    pub pubkey: ByteBuf,
    pub encrypted_content: ByteBuf,
    /// A recovery key set up along with the account.
    #[serde(default)]
    pub recovery_pubkey: Option<ByteBuf>,
    #[serde(default)]
    pub recovery_encrypted_content: Option<ByteBuf>,
}

#[derive(Deserialize, Debug)]
pub struct LoginChallengeRequest {
    pub username: String,
}

#[derive(Serialize, Debug)]
pub struct LoginChallenge {
    pub salt: ByteBuf,
    pub challenge: ByteBuf,
    pub version: i16,
}

/// The outer login body. `response` is itself msgpack, kept as bytes because
/// the signature is over exactly those bytes.
#[derive(Deserialize, Debug)]
pub struct SignedRequest {
    pub response: ByteBuf,
    pub signature: ByteBuf,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SignedBody {
    pub username: String,
    pub challenge: ByteBuf,
    pub host: String,
    pub action: String,
    /// Only when the password changes.
    #[serde(default)]
    pub login_pubkey: Option<ByteBuf>,
    #[serde(default)]
    pub encrypted_content: Option<ByteBuf>,
    /// A code from the authenticator, or a backup code, when the account has
    /// a second factor.
    #[serde(default)]
    pub totp: Option<String>,
    /// Only when the recovery key is set or replaced.
    #[serde(default)]
    pub recovery_pubkey: Option<ByteBuf>,
    #[serde(default)]
    pub recovery_encrypted_content: Option<ByteBuf>,
    /// Only on the second half of a recovery.
    #[serde(default)]
    pub grant: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LoginUser {
    pub username: String,
    pub email: String,
    pub pubkey: ByteBuf,
    pub encrypted_content: ByteBuf,
}

#[derive(Serialize, Debug)]
pub struct LoginResponse {
    pub token: String,
    pub user: LoginUser,
}

#[derive(Serialize, Debug)]
pub struct UserProfile {
    pub pubkey: ByteBuf,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InvitationCreate {
    pub uid: String,
    pub version: u8,
    pub username: String,
    pub collection: String,
    pub access_level: i16,
    pub signed_encryption_key: ByteBuf,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Invitation {
    pub uid: String,
    pub version: i16,
    pub access_level: i16,
    pub username: String,
    pub collection: String,
    pub signed_encryption_key: ByteBuf,
    pub from_username: String,
    pub from_pubkey: ByteBuf,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InvitationAccept {
    pub collection_type: ByteBuf,
    pub encryption_key: ByteBuf,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub username: String,
    pub access_level: i16,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MemberPatch {
    pub access_level: i16,
}
