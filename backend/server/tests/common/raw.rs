//! A client that speaks the wire protocol by hand.
//!
//! Rooms and the change feed are not part of the Etebase client library, and
//! the server never looks inside what it stores, so these tests send
//! placeholder bytes where a real client would send ciphertext. That also
//! shows the server does not depend on the content being well formed.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

pub const READ_ONLY: i16 = 0;
pub const ADMIN: i16 = 1;
pub const READ_WRITE: i16 = 2;

pub const HELLO: u8 = 0x01;
pub const WELCOME: u8 = 0x02;
pub const JOINED: u8 = 0x03;
pub const LEFT: u8 = 0x04;
pub const ACCESS: u8 = 0x05;
pub const UPDATE: u8 = 0x10;
pub const SYNC: u8 = 0x11;
pub const REPLY: u8 = 0x12;
pub const PRESENCE: u8 = 0x20;

fn uid() -> String {
    etebase::utils::to_base64(&etebase::utils::randombytes(24)).expect("base64")
}

fn bytes(value: &[u8]) -> serde_bytes::ByteBuf {
    serde_bytes::ByteBuf::from(value.to_vec())
}

/// One signed-in device.
pub struct Device {
    pub url: String,
    pub name: String,
    pub token: String,
    http: reqwest::Client,
}

#[derive(Serialize)]
struct Chunkless {
    uid: String,
    meta: serde_bytes::ByteBuf,
    deleted: bool,
    chunks: Vec<()>,
}

#[derive(Serialize)]
struct WireItem {
    uid: String,
    version: u8,
    content: Chunkless,
}

fn item(uid: &str) -> WireItem {
    WireItem {
        uid: uid.to_owned(),
        version: 1,
        content: Chunkless {
            uid: self::uid()[..22].to_owned(),
            meta: bytes(b"meta"),
            deleted: false,
            chunks: Vec::new(),
        },
    }
}

impl Device {
    pub async fn signup(url: &str, role: &str) -> Self {
        let name = super::username(role);
        let http = reqwest::Client::new();
        let body = serde_json::json!({
            "user": { "username": name, "email": format!("{name}@test.local") },
        });
        // The key fields have to be msgpack binary, which a JSON value cannot
        // express, so the body is built as a struct.
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Signup {
            user: Value,
            salt: serde_bytes::ByteBuf,
            login_pubkey: serde_bytes::ByteBuf,
            pubkey: serde_bytes::ByteBuf,
            encrypted_content: serde_bytes::ByteBuf,
        }
        let signup = Signup {
            user: body["user"].clone(),
            salt: bytes(&[1; 32]),
            login_pubkey: bytes(&[2; 32]),
            pubkey: bytes(&[3; 32]),
            encrypted_content: bytes(&[4; 64]),
        };
        let response = http
            .post(format!("{url}/api/v1/authentication/signup/"))
            .body(rmp_serde::to_vec_named(&signup).unwrap())
            .send()
            .await
            .expect("signup request");
        assert_eq!(response.status(), 200, "signup");
        // The answer also carries the account keys, as binary, which a JSON
        // value cannot hold. Only the token is wanted.
        #[derive(serde::Deserialize)]
        struct Answer {
            token: String,
        }
        let answer: Answer = rmp_serde::from_slice(&response.bytes().await.unwrap()).unwrap();
        Self {
            url: url.to_owned(),
            name,
            token: answer.token,
            http,
        }
    }

    /// A session that already exists, signed in some other way.
    pub fn with_token(url: &str, name: &str, token: &str) -> Self {
        Self {
            url: url.to_owned(),
            name: name.to_owned(),
            token: token.to_owned(),
            http: reqwest::Client::new(),
        }
    }

    /// Send a request and return its status and decoded body.
    pub async fn call<B: Serialize>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&B>,
    ) -> (u16, Value) {
        let mut request = self
            .http
            .request(method, format!("{}/api/v1{path}", self.url))
            .header("Authorization", format!("Token {}", self.token));
        if let Some(body) = body {
            request = request.body(rmp_serde::to_vec_named(body).unwrap());
        }
        let response = request.send().await.expect("request");
        let status = response.status().as_u16();
        let raw = response.bytes().await.unwrap();
        let value = rmp_serde::from_slice(&raw).unwrap_or(Value::Null);
        (status, value)
    }

    async fn post<B: Serialize>(&self, path: &str, body: &B) -> (u16, Value) {
        self.call(reqwest::Method::POST, path, Some(body)).await
    }

    pub async fn create_collection(&self) -> String {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Create {
            item: WireItem,
            collection_key: serde_bytes::ByteBuf,
            collection_type: serde_bytes::ByteBuf,
        }
        let collection = uid();
        let body = Create {
            item: item(&collection),
            collection_key: bytes(b"key"),
            collection_type: bytes(b"type"),
        };
        let (status, _) = self.post("/collection/", &body).await;
        assert_eq!(status, 201, "create collection");
        collection
    }

    /// Push one new item and return its uid.
    pub async fn add_item(&self, collection: &str) -> String {
        let (status, uid) = self.try_add_item(collection).await;
        assert_eq!(status, 200, "push an item");
        uid
    }

    pub async fn try_add_item(&self, collection: &str) -> (u16, String) {
        #[derive(Serialize)]
        struct Batch {
            items: Vec<WireItem>,
        }
        let uid = uid();
        let body = Batch {
            items: vec![item(&uid)],
        };
        let (status, _) = self
            .post(&format!("/collection/{collection}/item/batch/"), &body)
            .await;
        (status, uid)
    }

    /// Invite `guest` and have them accept.
    pub async fn share(&self, collection: &str, guest: &Device, access: i16) {
        let invitation = self.invite(collection, guest, access).await;
        guest.accept(&invitation).await;
    }

    pub async fn invite(&self, collection: &str, guest: &Device, access: i16) -> String {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Invite<'a> {
            uid: &'a str,
            version: u8,
            username: &'a str,
            collection: &'a str,
            access_level: i16,
            signed_encryption_key: serde_bytes::ByteBuf,
        }
        let invitation = uid();
        let body = Invite {
            uid: &invitation,
            version: 1,
            username: &guest.name,
            collection,
            access_level: access,
            signed_encryption_key: bytes(b"sealed key"),
        };
        let (status, _) = self.post("/invitation/outgoing/", &body).await;
        assert_eq!(status, 201, "invite");
        invitation
    }

    pub async fn accept(&self, invitation: &str) {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Accept {
            collection_type: serde_bytes::ByteBuf,
            encryption_key: serde_bytes::ByteBuf,
        }
        let body = Accept {
            collection_type: bytes(b"type"),
            encryption_key: bytes(b"my key"),
        };
        let (status, _) = self
            .post(&format!("/invitation/incoming/{invitation}/accept/"), &body)
            .await;
        assert_eq!(status, 201, "accept");
    }

    pub async fn remove_member(&self, collection: &str, member: &Device) {
        let (status, _) = self
            .call::<()>(
                reqwest::Method::DELETE,
                &format!("/collection/{collection}/member/{}/", member.name),
                None,
            )
            .await;
        assert_eq!(status, 204, "remove member");
    }

    pub async fn set_access(&self, collection: &str, member: &Device, access: i16) {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Patch {
            access_level: i16,
        }
        let body = Patch {
            access_level: access,
        };
        let (status, _) = self
            .call(
                reqwest::Method::PATCH,
                &format!("/collection/{collection}/member/{}/", member.name),
                Some(&body),
            )
            .await;
        assert_eq!(status, 204, "change access");
    }

    /// Ask for a room ticket. `Err` carries the status the server refused
    /// with.
    pub async fn ticket(&self, collection: &str, item: &str) -> Result<String, u16> {
        let (status, body) = self
            .call::<()>(
                reqwest::Method::POST,
                &format!("/collection/{collection}/item/{item}/room-ticket/"),
                None,
            )
            .await;
        if status == 200 {
            Ok(body["ticket"].as_str().expect("a ticket").to_owned())
        } else {
            Err(status)
        }
    }

    /// Enter the room of an item and return the socket and the welcome.
    pub async fn enter(&self, collection: &str, item: &str) -> (Socket, Value) {
        let ticket = self.ticket(collection, item).await.expect("a ticket");
        let mut socket = Socket::open(&self.url, "/api/v1/room/", None).await;
        socket.hello(&ticket).await;
        match socket.next().await {
            Frame::Control(WELCOME, welcome) => (socket, welcome),
            other => panic!("expected a welcome, got {other:?}"),
        }
    }

    pub async fn feed(&self) -> Socket {
        let mut socket =
            Socket::open(&self.url, "/api/v1/mindstream/feed/", Some(&self.token)).await;
        match socket.next_message().await {
            Some(Message::Binary(hello)) => {
                let hello: Value = rmp_serde::from_slice(&hello).unwrap();
                assert_eq!(hello["protocol"], 1);
            }
            other => panic!("expected the feed's hello, got {other:?}"),
        }
        socket
    }
}

/// What a room socket received.
#[derive(Debug, PartialEq)]
pub enum Frame {
    /// A frame from the server itself: its kind and decoded body.
    Control(u8, Value),
    /// A frame another member sent.
    Relayed {
        class: u8,
        sender: u64,
        payload: Vec<u8>,
    },
    Closed(u16),
    /// Nothing arrived in time.
    Nothing,
}

pub struct Socket {
    stream: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

const WAIT: Duration = Duration::from_secs(5);

impl Socket {
    pub async fn open(url: &str, path: &str, token: Option<&str>) -> Self {
        Self::try_open(url, path, token)
            .await
            .expect("the socket opens")
    }

    pub async fn try_open(url: &str, path: &str, token: Option<&str>) -> Result<Self, String> {
        let address = format!("{}{path}", url.replacen("http", "ws", 1));
        let mut request = address.into_client_request().unwrap();
        if let Some(token) = token {
            request
                .headers_mut()
                .insert("Authorization", format!("Token {token}").parse().unwrap());
        }
        match connect_async(request).await {
            Ok((stream, _)) => Ok(Self { stream }),
            Err(err) => Err(err.to_string()),
        }
    }

    pub async fn hello(&mut self, ticket: &str) {
        let mut frame = vec![HELLO];
        frame.extend_from_slice(ticket.as_bytes());
        self.stream
            .send(Message::Binary(frame.into()))
            .await
            .unwrap();
    }

    pub async fn send(&mut self, class: u8, payload: &[u8]) {
        let mut frame = vec![class];
        frame.extend_from_slice(payload);
        self.stream
            .send(Message::Binary(frame.into()))
            .await
            .unwrap();
    }

    pub async fn reply(&mut self, target: u64, payload: &[u8]) {
        let mut frame = vec![REPLY];
        frame.extend_from_slice(&(target as u32).to_be_bytes());
        frame.extend_from_slice(payload);
        self.stream
            .send(Message::Binary(frame.into()))
            .await
            .unwrap();
    }

    /// The next data message, skipping pings, or `None` when nothing came.
    pub async fn next_message(&mut self) -> Option<Message> {
        self.next_message_within(WAIT).await
    }

    async fn next_message_within(&mut self, wait: Duration) -> Option<Message> {
        loop {
            match tokio::time::timeout(wait, self.stream.next()).await {
                Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => continue,
                Ok(Some(Ok(message))) => return Some(message),
                Ok(Some(Err(_))) | Ok(None) => return Some(Message::Close(None)),
                Err(_) => return None,
            }
        }
    }

    pub async fn next(&mut self) -> Frame {
        self.next_within(WAIT).await
    }

    async fn next_within(&mut self, wait: Duration) -> Frame {
        match self.next_message_within(wait).await {
            None => Frame::Nothing,
            Some(Message::Close(frame)) => {
                Frame::Closed(frame.map_or(0, |frame| u16::from(frame.code)))
            }
            Some(Message::Binary(frame)) => {
                let kind = frame[0];
                if kind < 0x10 {
                    Frame::Control(kind, rmp_serde::from_slice(&frame[1..]).unwrap())
                } else {
                    Frame::Relayed {
                        class: kind,
                        sender: u64::from(u32::from_be_bytes(frame[1..5].try_into().unwrap())),
                        payload: frame[5..].to_vec(),
                    }
                }
            }
            Some(other) => panic!("unexpected message {other:?}"),
        }
    }

    /// The code the server closes the socket with, skipping whatever it
    /// sends first.
    pub async fn close_code(&mut self) -> Option<u16> {
        loop {
            match self.next_message().await? {
                Message::Close(frame) => return Some(frame.map_or(0, |f| u16::from(f.code))),
                _ => continue,
            }
        }
    }

    /// Assert that nothing arrives for a little while.
    pub async fn expect_quiet(&mut self) {
        let frame = self.next_within(Duration::from_millis(400)).await;
        assert_eq!(frame, Frame::Nothing);
    }

    /// The feed's next piece of news, as (changed, invitations).
    pub async fn news(&mut self) -> Option<(bool, bool)> {
        match self.next_message().await? {
            Message::Binary(news) => {
                let news: Value = rmp_serde::from_slice(&news).unwrap();
                Some((
                    news["changed"].as_bool().unwrap(),
                    news["invitations"].as_bool().unwrap(),
                ))
            }
            _ => None,
        }
    }

    pub async fn expect_no_news(&mut self) {
        let message = self.next_message_within(Duration::from_millis(600)).await;
        assert!(message.is_none(), "unexpected {message:?}");
    }
}
