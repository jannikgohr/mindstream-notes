//! An account whose keys the test holds.
//!
//! The Etebase client derives its keys from a password and keeps them to
//! itself, and it knows nothing of second factors or recovery. These tests
//! sign their own requests with keys they make up. The server only ever sees
//! public keys and ciphertext, so made-up ones serve.

use std::time::{SystemTime, UNIX_EPOCH};

use ed25519_dalek::{Signer, SigningKey};
use mindstream_server::totp;
use reqwest::Method;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use serde_json::Value;

/// What stands in for the account keys wrapped under the password.
pub const ACCOUNT_KEYS: &[u8] = &[4; 64];
/// And for the copy wrapped under the recovery key.
pub const RECOVERY_COPY: &[u8] = &[5; 72];

pub fn new_key() -> SigningKey {
    SigningKey::from_bytes(&rand::random::<[u8; 32]>())
}

pub fn public(key: &SigningKey) -> Vec<u8> {
    key.verifying_key().to_bytes().to_vec()
}

/// A uid of the kind the client makes up for collections, items and links.
pub fn new_uid() -> String {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 18]>())
}

fn bytes(value: &[u8]) -> ByteBuf {
    ByteBuf::from(value.to_vec())
}

/// What the server answered.
pub struct Reply {
    pub status: u16,
    raw: Vec<u8>,
}

impl Reply {
    /// The body, for answers without binary fields. A JSON value cannot
    /// hold those; use `decode` for them.
    pub fn value(&self) -> Value {
        rmp_serde::from_slice(&self.raw).unwrap_or(Value::Null)
    }

    pub fn decode<T: DeserializeOwned>(&self) -> T {
        rmp_serde::from_slice(&self.raw).expect("the answer decodes")
    }

    /// The status with the error code, empty when there was no error.
    pub fn outcome(&self) -> (u16, String) {
        let code = self.value()["code"].as_str().unwrap_or("").to_owned();
        (self.status, code)
    }
}

/// A refusal, written the way `Reply::outcome` reports it.
pub fn refused(status: u16, code: &str) -> (u16, String) {
    (status, code.to_owned())
}

async fn request(
    url: &str,
    method: Method,
    path: &str,
    token: Option<&str>,
    device: &str,
    body: Option<Vec<u8>>,
) -> Reply {
    // A client per request. One shared between tests would hand a test a
    // connection whose other end lives on a finished test's runtime.
    let mut request = reqwest::Client::new()
        .request(method, format!("{url}/api/v1{path}"))
        .header("User-Agent", device);
    if let Some(token) = token {
        request = request.header("Authorization", format!("Token {token}"));
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    let response = request.send().await.expect("request");
    Reply {
        status: response.status().as_u16(),
        raw: response.bytes().await.expect("body").to_vec(),
    }
}

/// What a signed body may carry beyond who is asking and for what.
#[derive(Default, Clone)]
pub struct Extra {
    pub totp: Option<String>,
    pub login_pubkey: Option<Vec<u8>>,
    pub encrypted_content: Option<Vec<u8>>,
    pub recovery_pubkey: Option<Vec<u8>>,
    pub recovery_encrypted_content: Option<Vec<u8>>,
    pub grant: Option<String>,
}

impl Extra {
    pub fn none() -> Self {
        Self::default()
    }

    pub fn code(code: &str) -> Self {
        Self::default().with_code(code)
    }

    pub fn with_code(mut self, code: &str) -> Self {
        self.totp = Some(code.to_owned());
        self
    }

    /// A new password: the key it proves and the account keys under it.
    pub fn password(login: &SigningKey) -> Self {
        Self {
            login_pubkey: Some(public(login)),
            encrypted_content: Some(vec![9; 64]),
            ..Self::default()
        }
    }

    pub fn with_recovery(mut self, key: &SigningKey) -> Self {
        self.recovery_pubkey = Some(public(key));
        self.recovery_encrypted_content = Some(RECOVERY_COPY.to_vec());
        self
    }

    pub fn with_grant(mut self, grant: &str) -> Self {
        self.grant = Some(grant.to_owned());
        self
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignedBody<'a> {
    username: &'a str,
    challenge: ByteBuf,
    host: &'a str,
    action: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    totp: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    login_pubkey: Option<ByteBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    encrypted_content: Option<ByteBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    recovery_pubkey: Option<ByteBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    recovery_encrypted_content: Option<ByteBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    grant: Option<&'a str>,
}

/// Fetch a challenge and answer it: the body every signed route takes.
async fn sign(url: &str, name: &str, key: &SigningKey, action: &str, extra: &Extra) -> Vec<u8> {
    #[derive(Deserialize)]
    struct Challenge {
        challenge: ByteBuf,
    }
    #[derive(Serialize)]
    struct Outer {
        response: ByteBuf,
        signature: ByteBuf,
    }
    let asked = rmp_serde::to_vec_named(&serde_json::json!({ "username": name })).unwrap();
    let reply = request(
        url,
        Method::POST,
        "/authentication/login_challenge/",
        None,
        "test",
        Some(asked),
    )
    .await;
    assert_eq!(reply.status, 200, "login challenge");
    let wrap = |value: &Option<Vec<u8>>| value.as_deref().map(bytes);
    let body = SignedBody {
        username: name,
        challenge: reply.decode::<Challenge>().challenge,
        host: url.trim_start_matches("http://"),
        action,
        totp: extra.totp.as_deref(),
        login_pubkey: wrap(&extra.login_pubkey),
        encrypted_content: wrap(&extra.encrypted_content),
        recovery_pubkey: wrap(&extra.recovery_pubkey),
        recovery_encrypted_content: wrap(&extra.recovery_encrypted_content),
        grant: extra.grant.as_deref(),
    };
    let response = rmp_serde::to_vec_named(&body).unwrap();
    let signature = key.sign(&response).to_bytes();
    rmp_serde::to_vec_named(&Outer {
        response: ByteBuf::from(response),
        signature: bytes(&signature),
    })
    .unwrap()
}

/// A request from nobody at all.
pub async fn post<B: Serialize>(url: &str, path: &str, body: &B) -> Reply {
    let body = Some(rmp_serde::to_vec_named(body).unwrap());
    request(url, Method::POST, path, None, "test", body).await
}

/// A signed request from nobody in particular: signing in, or recovering.
pub async fn signed(
    url: &str,
    name: &str,
    key: &SigningKey,
    path: &str,
    action: &str,
    extra: &Extra,
) -> Reply {
    let body = sign(url, name, key, action, extra).await;
    request(url, Method::POST, path, None, "test", Some(body)).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUser {
    pub encrypted_content: ByteBuf,
}

/// The answer to signing in, signing up and completing a recovery.
#[derive(Deserialize)]
pub struct Session {
    pub token: String,
    pub user: SessionUser,
}

/// What a signup brings along beyond the account itself.
#[derive(Default)]
pub struct SignupWith<'a> {
    pub recovery: bool,
    /// A signup code from an administrator.
    pub code: Option<&'a str>,
    /// An invite link's uid and the key derived from its secret.
    pub link: Option<(&'a str, &'a SigningKey)>,
}

/// The signature that shows a caller holds an invite link's secret.
pub fn link_proof(key: &SigningKey, action: &str, link: &str, username: &str) -> Vec<u8> {
    let message = format!(
        "mindstream-link:{action}:{link}:{}",
        username.to_lowercase()
    );
    key.sign(message.as_bytes()).to_bytes().to_vec()
}

/// One device of one account.
pub struct Person {
    pub url: String,
    pub name: String,
    /// The key the password stands for.
    pub login: SigningKey,
    pub recovery: Option<SigningKey>,
    pub token: String,
    pub device: String,
}

impl Person {
    pub async fn signup(url: &str, role: &str, with_recovery: bool) -> Self {
        let with = SignupWith {
            recovery: with_recovery,
            ..SignupWith::default()
        };
        Self::signup_with(url, role, with).await.expect("signup")
    }

    /// Sign up, or report how the server refused.
    pub async fn signup_with(
        url: &str,
        role: &str,
        with: SignupWith<'_>,
    ) -> Result<Self, (u16, String)> {
        #[derive(Serialize)]
        struct User<'a> {
            username: &'a str,
            email: String,
        }
        #[derive(Serialize)]
        struct Link<'a> {
            uid: &'a str,
            signature: ByteBuf,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Signup<'a> {
            user: User<'a>,
            salt: ByteBuf,
            login_pubkey: ByteBuf,
            pubkey: ByteBuf,
            encrypted_content: ByteBuf,
            #[serde(skip_serializing_if = "Option::is_none")]
            recovery_pubkey: Option<ByteBuf>,
            #[serde(skip_serializing_if = "Option::is_none")]
            recovery_encrypted_content: Option<ByteBuf>,
            #[serde(skip_serializing_if = "Option::is_none")]
            signup_code: Option<&'a str>,
            #[serde(skip_serializing_if = "Option::is_none")]
            link: Option<Link<'a>>,
        }
        let name = super::username(role);
        let login = new_key();
        let recovery = with.recovery.then(new_key);
        let body = Signup {
            user: User {
                username: &name,
                email: format!("{name}@test.local"),
            },
            salt: bytes(&[1; 32]),
            login_pubkey: bytes(&public(&login)),
            pubkey: bytes(&[3; 32]),
            encrypted_content: bytes(ACCOUNT_KEYS),
            recovery_pubkey: recovery.as_ref().map(|key| bytes(&public(key))),
            recovery_encrypted_content: recovery.as_ref().map(|_| bytes(RECOVERY_COPY)),
            signup_code: with.code,
            link: with.link.map(|(uid, key)| Link {
                uid,
                signature: bytes(&link_proof(key, "signup", uid, &name)),
            }),
        };
        let reply = request(
            url,
            Method::POST,
            "/authentication/signup/",
            None,
            "Laptop",
            Some(rmp_serde::to_vec_named(&body).unwrap()),
        )
        .await;
        if reply.status != 200 {
            return Err(reply.outcome());
        }
        Ok(Self {
            url: url.to_owned(),
            token: reply.decode::<Session>().token,
            name,
            login,
            recovery,
            device: "Laptop".to_owned(),
        })
    }

    pub async fn get(&self, path: &str) -> Reply {
        let token = Some(self.token.as_str());
        request(&self.url, Method::GET, path, token, &self.device, None).await
    }

    pub async fn delete(&self, path: &str) -> Reply {
        let token = Some(self.token.as_str());
        request(&self.url, Method::DELETE, path, token, &self.device, None).await
    }

    pub async fn post<B: Serialize>(&self, path: &str, body: &B) -> Reply {
        let token = Some(self.token.as_str());
        let body = Some(rmp_serde::to_vec_named(body).unwrap());
        request(&self.url, Method::POST, path, token, &self.device, body).await
    }

    /// A request from this device, signed with `key`.
    pub async fn signed(
        &self,
        method: Method,
        path: &str,
        action: &str,
        key: &SigningKey,
        extra: &Extra,
    ) -> Reply {
        let body = sign(&self.url, &self.name, key, action, extra).await;
        let token = Some(self.token.as_str());
        request(&self.url, method, path, token, &self.device, Some(body)).await
    }

    /// Sign in from another device. Gives that device, or the refusal.
    pub async fn login(
        &self,
        key: &SigningKey,
        extra: &Extra,
        device: &str,
    ) -> Result<Person, (u16, String)> {
        let body = sign(&self.url, &self.name, key, "login", extra).await;
        let reply = request(
            &self.url,
            Method::POST,
            "/authentication/login/",
            None,
            device,
            Some(body),
        )
        .await;
        if reply.status != 200 {
            return Err(reply.outcome());
        }
        Ok(Person {
            url: self.url.clone(),
            name: self.name.clone(),
            login: key.clone(),
            recovery: self.recovery.clone(),
            token: reply.decode::<Session>().token,
            device: device.to_owned(),
        })
    }

    /// Whether this device's session still stands.
    pub async fn signed_in(&self) -> bool {
        self.get("/mindstream/security/").await.status == 200
    }

    /// The same session, for the tests' other hand-rolled client.
    pub fn device(&self) -> super::raw::Device {
        super::raw::Device::with_token(&self.url, &self.name, &self.token)
    }
}

pub fn step_now() -> u64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_secs();
    totp::step_at(now)
}

fn unbase32(text: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let (mut buffer, mut bits) = (0u32, 0);
    for c in text.bytes() {
        let value = match c {
            b'A'..=b'Z' => c - b'A',
            b'2'..=b'7' => c - b'2' + 26,
            other => panic!("not base32: {}", other as char),
        };
        buffer = (buffer << 5) | u32::from(value);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    out
}

/// What an authenticator app does with the secret it was shown.
pub struct Authenticator {
    secret: Vec<u8>,
    last: u64,
}

impl Authenticator {
    pub fn new(shown: &str) -> Self {
        Self {
            secret: unbase32(shown),
            last: 0,
        }
    }

    pub fn code_at(&self, step: u64) -> String {
        totp::code_at(&self.secret, step)
    }

    /// A code the server has not seen yet. It accepts each time step once
    /// and looks one step ahead, so a test gets two of these in quick
    /// succession and has to use backup codes after that.
    pub fn code(&mut self) -> String {
        let now = step_now();
        let step = now.max(self.last + 1);
        assert!(
            step <= now + 1,
            "the authenticator has no further code the server would accept yet"
        );
        self.last = step;
        self.code_at(step)
    }

    /// The code handed out last, for trying it a second time.
    pub fn last_code(&self) -> String {
        self.code_at(self.last)
    }

    /// Six digits that are not a code for any step near now.
    pub fn wrong_code(&self) -> String {
        let now = step_now();
        let near: Vec<String> = (now - 3..=now + 3).map(|step| self.code_at(step)).collect();
        (0..)
            .map(|guess| format!("{guess:06}"))
            .find(|guess| !near.contains(guess))
            .expect("some code is wrong")
    }
}

/// Set up an authenticator for the account, from this device. Returns it
/// with the backup codes.
pub async fn enrol(person: &Person) -> (Authenticator, Vec<String>) {
    let started = person
        .signed(
            Method::POST,
            "/mindstream/totp/enroll/",
            "enrollTotp",
            &person.login,
            &Extra::none(),
        )
        .await;
    assert_eq!(started.outcome(), refused(200, ""), "start enrolling");
    let shown = started.value();
    let mut authenticator = Authenticator::new(shown["secret"].as_str().expect("a secret"));
    let codes = confirm(person, &mut authenticator).await;
    (authenticator, codes)
}

/// Finish an enrolment with a code from the authenticator.
pub async fn confirm(person: &Person, authenticator: &mut Authenticator) -> Vec<String> {
    let confirmed = person
        .post(
            "/mindstream/totp/confirm/",
            &serde_json::json!({ "code": authenticator.code() }),
        )
        .await;
    assert_eq!(confirmed.outcome(), refused(200, ""), "confirm enrolling");
    backup_codes(&confirmed)
}

pub fn backup_codes(reply: &Reply) -> Vec<String> {
    reply.value()["backupCodes"]
        .as_array()
        .expect("backup codes")
        .iter()
        .map(|code| code.as_str().expect("a code").to_owned())
        .collect()
}
