//! Accounts on a Mindstream server: signing in with a second factor, signing
//! up with a recovery key, getting back in with one, and what an account can
//! change about its own security.
//!
//! The Etebase calls, [`Account::login`] and the rest, still work against a
//! Mindstream server. They know nothing of codes or recovery keys, and they
//! report a refusal as prose. The calls here report it as
//! [`Error::Refused`], with the reason as a code a program can act on. The
//! codes are listed in [`refusal`].

use std::convert::TryInto;
use std::fmt;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_bytes::{ByteBuf, Bytes};

use crate::crypto::{derive_key, BoxCryptoManager, CryptoMac, CryptoManager, LoginCryptoManager};
use crate::error::{Error, Result};
use crate::http_client::{Client, Response};
use crate::online_managers::{LoginChallange, LoginResponse, User};
use crate::service::{Account, MainCryptoManager};
use crate::utils::{randombytes_array, SALT_SIZE, SYMMETRIC_KEY_SIZE};

/// The reasons a Mindstream server gives in [`Error::Refused`] that a client
/// is likely to treat differently from one another.
pub mod refusal {
    /// The password was right and the account has a second factor. Ask for a
    /// code and send the request again with it.
    pub const CODE_REQUIRED: &str = "totp_required";
    /// The code is wrong, or it was used before.
    pub const CODE_INVALID: &str = "totp_invalid";
    /// Too many wrong codes. The account's second factor is locked for a
    /// while.
    pub const CODE_THROTTLED: &str = "totp_throttled";
    /// Too many attempts from this address.
    pub const THROTTLED: &str = "throttled";
    /// There is no authenticator to turn off or to make backup codes for.
    pub const NO_AUTHENTICATOR: &str = "totp_not_enabled";
    /// A code was sent to finish setting up an authenticator, and no setup
    /// is under way.
    pub const SETUP_NOT_STARTED: &str = "totp_not_started";
    pub const WRONG_PASSWORD: &str = "login_bad_signature";
    /// Also what an account without a recovery key answers.
    pub const WRONG_RECOVERY_KEY: &str = "recovery_bad_signature";
    pub const UNKNOWN_USER: &str = "user_not_found";
    pub const USER_EXISTS: &str = "user_exists";
    pub const USER_DISABLED: &str = "user_inactive";
    /// The server takes no new accounts, or not without an invitation.
    pub const SIGNUP_CLOSED: &str = "signup_closed";
    /// The signup code or the invite link is used up, expired or made up.
    pub const SIGNUP_INVITATION_INVALID: &str = "signup_invitation_invalid";
    /// The second half of a recovery came too late.
    pub const RECOVERY_EXPIRED: &str = "recovery_expired";
    pub const RECOVERY_USED: &str = "recovery_used";
    /// The session token is not one the server knows.
    pub const SESSION_ENDED: &str = "authentication_failed";
}

/// Like [`Response::error_for_status`], keeping the server's reason.
fn checked(res: &Response) -> Result<()> {
    if (200..300).contains(&res.status()) {
        return Ok(());
    }

    #[derive(Deserialize)]
    struct Body {
        code: Option<String>,
        detail: Option<String>,
    }

    match rmp_serde::from_slice::<Body>(res.bytes()) {
        Ok(Body {
            code: Some(code),
            detail,
        }) => Err(Error::Refused {
            status: res.status(),
            code,
            detail: detail.unwrap_or_default(),
        }),
        // Not this server's way of saying no: a proxy, most likely.
        _ => res.error_for_status(),
    }
}

fn api_url(client: &Client, path: &str) -> Result<String> {
    Ok(client.api_base.join("api/v1/")?.join(path)?.into())
}

fn host(client: &Client) -> &str {
    let url = client.server_url();
    url.host_str().unwrap_or_else(|| url.as_str())
}

/// Ask the server for something to sign. The answer also carries the salt
/// the account's password is stretched with.
fn challenge_for(client: &Client, username: &str) -> Result<LoginChallange> {
    #[derive(Serialize)]
    struct Body<'a> {
        username: &'a str,
    }

    let body = rmp_serde::to_vec_named(&Body { username })?;
    let url = api_url(client, "authentication/login_challenge/")?;
    let res = client.post(&url, body)?;
    checked(&res)?;
    Ok(rmp_serde::from_slice(res.bytes())?)
}

fn salt_of(challenge: &LoginChallange) -> Result<[u8; SALT_SIZE]> {
    // Signup makes 32 bytes of salt. Only the first 16 go into the key.
    Ok(challenge
        .salt
        .get(..SALT_SIZE)
        .ok_or(Error::Encryption(
            "Salt obtained from login challenge too short: expected at least 16 bytes",
        ))?
        .try_into()
        .unwrap())
}

/// What a signed request may carry beyond who is asking and for what.
#[derive(Default)]
struct Extra<'a> {
    totp: Option<&'a str>,
    login_pubkey: Option<&'a [u8]>,
    encrypted_content: Option<&'a [u8]>,
    recovery_pubkey: Option<&'a [u8]>,
    recovery_encrypted_content: Option<&'a [u8]>,
    grant: Option<&'a str>,
}

/// The body of every request the server wants proof of a key for: an answer
/// to its challenge, signed. Signing in is one of these, and so is anything
/// that asks for the password again.
fn signed(
    client: &Client,
    username: &str,
    challenge: &LoginChallange,
    action: &str,
    signer: &LoginCryptoManager,
    extra: &Extra,
) -> Result<Vec<u8>> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Body<'a> {
        username: &'a str,
        challenge: &'a Bytes,
        host: &'a str,
        action: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        totp: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        login_pubkey: Option<&'a Bytes>,
        #[serde(skip_serializing_if = "Option::is_none")]
        encrypted_content: Option<&'a Bytes>,
        #[serde(skip_serializing_if = "Option::is_none")]
        recovery_pubkey: Option<&'a Bytes>,
        #[serde(skip_serializing_if = "Option::is_none")]
        recovery_encrypted_content: Option<&'a Bytes>,
        #[serde(skip_serializing_if = "Option::is_none")]
        grant: Option<&'a str>,
    }

    #[derive(Serialize)]
    struct Outer<'a> {
        response: &'a Bytes,
        signature: &'a Bytes,
    }

    let response = rmp_serde::to_vec_named(&Body {
        username,
        challenge: Bytes::new(&challenge.challenge),
        host: host(client),
        action,
        totp: extra.totp,
        login_pubkey: extra.login_pubkey.map(Bytes::new),
        encrypted_content: extra.encrypted_content.map(Bytes::new),
        recovery_pubkey: extra.recovery_pubkey.map(Bytes::new),
        recovery_encrypted_content: extra.recovery_encrypted_content.map(Bytes::new),
        grant: extra.grant,
    })?;
    let signature = signer.sign_detached(&response)?;

    Ok(rmp_serde::to_vec_named(&Outer {
        response: Bytes::new(&response),
        signature: Bytes::new(&signature),
    })?)
}

/// The account key and the identity private key, as one run of bytes. This
/// is what the password wraps, and what the recovery key wraps a copy of.
fn account_keys(account: &Account) -> Result<Vec<u8>> {
    MainCryptoManager::new(&account.main_key, account.version)?
        .0
        .decrypt(&account.user.encrypted_content, None)
}

fn open(
    mut client: Client,
    main_key: [u8; SYMMETRIC_KEY_SIZE],
    version: u8,
    session: LoginResponse,
) -> Result<Account> {
    client.set_token(Some(&session.token));

    let main_crypto_manager = MainCryptoManager::new(&main_key, version)?;
    let content = main_crypto_manager
        .0
        .decrypt(&session.user.encrypted_content, None)?;
    let account_key = content
        .get(..SYMMETRIC_KEY_SIZE)
        .ok_or(Error::Encryption(
            "Server's login response too short to contain account key",
        ))?
        .try_into()
        .unwrap();
    let account_crypto_manager = main_crypto_manager.account_crypto_manager(account_key)?;

    Ok(Account {
        main_key,
        version,
        user: session.user,
        client: Arc::new(client),
        account_crypto_manager: Arc::new(account_crypto_manager),
    })
}

const RECOVERY_SECRET_LEN: usize = 32;
const RECOVERY_CHECK_LEN: usize = 3;
const RECOVERY_GROUP: usize = 4;
const BASE32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

fn base32_encode(bytes: &[u8]) -> String {
    let mut out = String::new();
    let (mut buffer, mut bits) = (0u32, 0u32);
    for byte in bytes {
        buffer = (buffer << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(BASE32[((buffer >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(BASE32[((buffer << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// `None` for anything that is not base32. Spaces and dashes are skipped and
/// case does not matter, because this is read off paper.
fn base32_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let (mut buffer, mut bits) = (0u32, 0u32);
    for c in text.chars() {
        let value = match c.to_ascii_uppercase() {
            ' ' | '-' | '\t' | '\r' | '\n' => continue,
            upper @ 'A'..='Z' => upper as u32 - 'A' as u32,
            digit @ '2'..='7' => digit as u32 - '2' as u32 + 26,
            _ => return None,
        };
        buffer = (buffer << 5) | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Some(out)
}

fn recovery_check(secret: &[u8; RECOVERY_SECRET_LEN]) -> Result<[u8; RECOVERY_CHECK_LEN]> {
    let mut mac = CryptoMac::new(None)?;
    mac.update(b"mindstream recovery key")?;
    mac.update(secret)?;
    let digest = mac.finalize()?;
    Ok(digest[..RECOVERY_CHECK_LEN].try_into().unwrap())
}

/// The way back into an account whose password is lost.
///
/// It is a random secret that wraps a second copy of the account's keys. The
/// server keeps the copy and can do nothing with it. The secret is shown to
/// the user once, as text to write down, and it is never sent anywhere.
///
/// The text is 56 letters and digits in groups of four. The last few carry a
/// checksum, so a typing mistake is caught by [`RecoveryKey::parse`] instead
/// of costing an attempt at the server.
#[derive(Clone, PartialEq, Eq)]
pub struct RecoveryKey([u8; RECOVERY_SECRET_LEN]);

impl RecoveryKey {
    /// Make up a new one
    pub fn generate() -> Self {
        Self(randombytes_array())
    }

    /// Read one back from the text it was shown as
    pub fn parse(text: &str) -> Result<Self> {
        let not_one = || Error::Generic("That is not a recovery key.".to_string());
        let bytes = base32_decode(text).ok_or_else(not_one)?;
        if bytes.len() != RECOVERY_SECRET_LEN + RECOVERY_CHECK_LEN {
            return Err(not_one());
        }
        let secret: [u8; RECOVERY_SECRET_LEN] = bytes[..RECOVERY_SECRET_LEN].try_into().unwrap();
        if bytes[RECOVERY_SECRET_LEN..] != recovery_check(&secret)? {
            return Err(not_one());
        }
        Ok(Self(secret))
    }

    fn crypto_manager(&self, version: u8) -> Result<CryptoManager> {
        CryptoManager::new(&self.0, b"Recovery", version)
    }

    /// The key that signs requests made with this recovery key
    fn signer(&self, version: u8) -> Result<LoginCryptoManager> {
        LoginCryptoManager::keygen(&self.crypto_manager(version)?.asym_key_seed)
    }

    /// What the server stores: the public half of the signing key, and the
    /// account's keys wrapped so that only this recovery key opens them
    fn sealed(&self, version: u8, account_keys: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
        let pubkey = self.signer(version)?.pubkey().to_vec();
        let copy = self.crypto_manager(version)?.encrypt(account_keys, None)?;
        Ok((pubkey, copy))
    }
}

impl fmt::Display for RecoveryKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let check = recovery_check(&self.0).map_err(|_| fmt::Error)?;
        let text = base32_encode(&[&self.0[..], &check[..]].concat());
        let groups: Vec<&str> = text
            .as_bytes()
            .chunks(RECOVERY_GROUP)
            // Base32 output is ASCII, so any split is on a boundary.
            .map(|group| std::str::from_utf8(group).unwrap())
            .collect();
        f.write_str(&groups.join("-"))
    }
}

impl fmt::Debug for RecoveryKey {
    // It opens the account. It has no business in a log.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RecoveryKey(..)")
    }
}

/// What a signup brings along beyond the account itself.
#[derive(Default, Clone, Debug)]
pub struct SignupWith {
    signup_code: Option<String>,
}

impl SignupWith {
    /// Nothing: enough for a server that takes anyone
    pub fn new() -> Self {
        Self::default()
    }

    /// A code from the server's administrator, good for one account
    pub fn signup_code(mut self, code: &str) -> Self {
        self.signup_code = Some(code.to_string());
        self
    }
}

/// A recovery that got through its first half.
///
/// Dropping it gives up the recovery. Nothing has changed for the account
/// until [`Recovery::complete`] succeeds.
pub struct Recovery {
    client: Client,
    username: String,
    key: RecoveryKey,
    version: u8,
    account_keys: Vec<u8>,
    grant: String,
}

impl Recovery {
    /// Set the new password. The account's keys stay the same, so its data
    /// stays readable. Every device is signed out, the one doing this gets a
    /// session, and the recovery key just used is replaced by the one
    /// returned. Show it to the user: the old one no longer works.
    pub fn complete(self, new_password: &str) -> Result<(Account, RecoveryKey)> {
        let challenge = challenge_for(&self.client, &self.username)?;

        let main_key = derive_key(&salt_of(&challenge)?, new_password)?;
        let main_crypto_manager = MainCryptoManager::new(&main_key, self.version)?;
        let login_crypto_manager = main_crypto_manager.login_crypto_manager()?;
        let encrypted_content = main_crypto_manager.0.encrypt(&self.account_keys, None)?;

        let new_key = RecoveryKey::generate();
        let (recovery_pubkey, recovery_copy) = new_key.sealed(self.version, &self.account_keys)?;

        let body = signed(
            &self.client,
            &self.username,
            &challenge,
            "recoverComplete",
            &self.key.signer(self.version)?,
            &Extra {
                grant: Some(&self.grant),
                login_pubkey: Some(login_crypto_manager.pubkey()),
                encrypted_content: Some(&encrypted_content),
                recovery_pubkey: Some(&recovery_pubkey),
                recovery_encrypted_content: Some(&recovery_copy),
                ..Extra::default()
            },
        )?;
        let url = api_url(&self.client, "authentication/recover/complete/")?;
        let res = self.client.post(&url, body)?;
        checked(&res)?;
        let session: LoginResponse = rmp_serde::from_slice(res.bytes())?;

        let account = open(self.client, main_key, self.version, session)?;
        Ok((account, new_key))
    }
}

/// What an account has set up to protect itself.
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecurityStatus {
    totp: bool,
    backup_codes: u32,
    recovery_key: bool,
    session_verified: bool,
}

impl SecurityStatus {
    /// Whether signing in takes a code from an authenticator
    pub fn authenticator(&self) -> bool {
        self.totp
    }

    /// How many backup codes are left
    pub fn backup_codes(&self) -> u32 {
        self.backup_codes
    }

    /// Whether the account has a recovery key
    pub fn recovery_key(&self) -> bool {
        self.recovery_key
    }

    /// Whether this device signed in with a second factor. One that did may
    /// replace the authenticator on the password alone.
    pub fn session_verified(&self) -> bool {
        self.session_verified
    }
}

/// An authenticator that is being set up. It protects nothing until a code
/// from it has been confirmed.
#[derive(Deserialize, Clone)]
pub struct AuthenticatorSetup {
    secret: String,
    url: String,
}

impl AuthenticatorSetup {
    /// The secret as an authenticator app takes it when typed in
    pub fn secret(&self) -> &str {
        &self.secret
    }

    /// The same secret as the `otpauth:` link a QR code carries
    pub fn url(&self) -> &str {
        &self.url
    }
}

impl fmt::Debug for AuthenticatorSetup {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AuthenticatorSetup(..)")
    }
}

/// A device that is signed in to the account.
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSession {
    id: i64,
    device_name: String,
    created_at: i64,
    last_used_at: i64,
    second_factor: bool,
    current: bool,
}

impl DeviceSession {
    /// What to name the session by when signing it out
    pub fn id(&self) -> i64 {
        self.id
    }

    /// What the device called itself when it signed in
    pub fn device_name(&self) -> &str {
        &self.device_name
    }

    /// When it signed in, in seconds since 1970
    pub fn created_at(&self) -> i64 {
        self.created_at
    }

    /// When it last talked to the server, in seconds since 1970 and accurate
    /// to a few minutes
    pub fn last_used_at(&self) -> i64 {
        self.last_used_at
    }

    /// Whether it signed in with a second factor
    pub fn second_factor(&self) -> bool {
        self.second_factor
    }

    /// Whether it is the device asking
    pub fn current(&self) -> bool {
        self.current
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupCodes {
    backup_codes: Vec<String>,
}

impl Account {
    /// Sign in to a Mindstream server.
    ///
    /// `code` is a code from the authenticator, or a backup code. Leave it
    /// out first: an account that needs one answers
    /// [`refusal::CODE_REQUIRED`], and only once the password has checked
    /// out, so the answer does not tell a stranger which accounts have a
    /// second factor.
    pub fn login_with_code(
        client: Client,
        username: &str,
        password: &str,
        code: Option<&str>,
    ) -> Result<Self> {
        crate::init()?;

        let challenge = challenge_for(&client, username)?;
        let version = challenge.version;

        let main_key = derive_key(&salt_of(&challenge)?, password)?;
        let login_crypto_manager =
            MainCryptoManager::new(&main_key, version)?.login_crypto_manager()?;

        let body = signed(
            &client,
            username,
            &challenge,
            "login",
            &login_crypto_manager,
            &Extra {
                totp: code,
                ..Extra::default()
            },
        )?;
        let url = api_url(&client, "authentication/login/")?;
        let res = client.post(&url, body)?;
        checked(&res)?;
        let session: LoginResponse = rmp_serde::from_slice(res.bytes())?;

        open(client, main_key, version, session)
    }

    /// Create an account on a Mindstream server, with a recovery key.
    ///
    /// The key is made here and goes up with the signup, so an account never
    /// exists without one. Show it to the user. It cannot be shown again,
    /// only replaced.
    pub fn signup_with(
        client: Client,
        user: &User,
        password: &str,
        with: &SignupWith,
    ) -> Result<(Self, RecoveryKey)> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Body<'a> {
            user: &'a User,
            salt: &'a Bytes,
            login_pubkey: &'a Bytes,
            pubkey: &'a Bytes,
            encrypted_content: &'a Bytes,
            recovery_pubkey: &'a Bytes,
            recovery_encrypted_content: &'a Bytes,
            #[serde(skip_serializing_if = "Option::is_none")]
            signup_code: Option<&'a str>,
        }

        crate::init()?;
        let version = crate::CURRENT_VERSION;

        // Only the first 16 bytes go into the key. Etebase clients have
        // always made 32, and so does this.
        let salt = randombytes_array::<32>();
        let main_key = derive_key(&salt[..SALT_SIZE].try_into().unwrap(), password)?;
        let main_crypto_manager = MainCryptoManager::new(&main_key, version)?;
        let login_crypto_manager = main_crypto_manager.login_crypto_manager()?;
        let identity_crypto_manager = BoxCryptoManager::keygen(None)?;

        let account_key = randombytes_array::<SYMMETRIC_KEY_SIZE>();
        let account_keys = [&account_key[..], identity_crypto_manager.privkey()].concat();
        let encrypted_content = main_crypto_manager.0.encrypt(&account_keys, None)?;

        let recovery_key = RecoveryKey::generate();
        let (recovery_pubkey, recovery_copy) = recovery_key.sealed(version, &account_keys)?;

        let body = rmp_serde::to_vec_named(&Body {
            user,
            salt: Bytes::new(&salt),
            login_pubkey: Bytes::new(login_crypto_manager.pubkey()),
            pubkey: Bytes::new(identity_crypto_manager.pubkey()),
            encrypted_content: Bytes::new(&encrypted_content),
            recovery_pubkey: Bytes::new(&recovery_pubkey),
            recovery_encrypted_content: Bytes::new(&recovery_copy),
            signup_code: with.signup_code.as_deref(),
        })?;
        let url = api_url(&client, "authentication/signup/")?;
        let res = client.post(&url, body)?;
        checked(&res)?;
        let session: LoginResponse = rmp_serde::from_slice(res.bytes())?;

        let account = open(client, main_key, version, session)?;
        Ok((account, recovery_key))
    }

    /// Start getting back into an account whose password is lost.
    ///
    /// This proves the recovery key, and the second factor if the account
    /// has one, and fetches the copy of the account's keys that the recovery
    /// key opens. Nothing changes until [`Recovery::complete`], which has to
    /// follow within ten minutes.
    pub fn recover(
        client: Client,
        username: &str,
        key: &RecoveryKey,
        code: Option<&str>,
    ) -> Result<Recovery> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Opened {
            recovery_encrypted_content: ByteBuf,
            grant: String,
        }

        crate::init()?;

        let challenge = challenge_for(&client, username)?;
        let version = challenge.version;

        let body = signed(
            &client,
            username,
            &challenge,
            "recover",
            &key.signer(version)?,
            &Extra {
                totp: code,
                ..Extra::default()
            },
        )?;
        let url = api_url(&client, "authentication/recover/")?;
        let res = client.post(&url, body)?;
        checked(&res)?;
        let opened: Opened = rmp_serde::from_slice(res.bytes())?;

        let account_keys = key
            .crypto_manager(version)?
            .decrypt(&opened.recovery_encrypted_content, None)?;

        Ok(Recovery {
            client,
            username: username.to_string(),
            key: key.clone(),
            version,
            account_keys,
            grant: opened.grant,
        })
    }

    /// Set a new password, with a code where the account has a second
    /// factor. Every other device is signed out.
    ///
    /// The old password is not asked for: a signed-in device is the way back
    /// for someone who has forgotten it.
    pub fn change_password_with_code(
        &mut self,
        new_password: &str,
        code: Option<&str>,
    ) -> Result<()> {
        let challenge = challenge_for(&self.client, &self.user.username)?;

        let account_keys = account_keys(self)?;
        let old_login_crypto_manager =
            MainCryptoManager::new(&self.main_key, self.version)?.login_crypto_manager()?;

        let main_key = derive_key(&salt_of(&challenge)?, new_password)?;
        let main_crypto_manager = MainCryptoManager::new(&main_key, self.version)?;
        let login_crypto_manager = main_crypto_manager.login_crypto_manager()?;
        let encrypted_content = main_crypto_manager.0.encrypt(&account_keys, None)?;

        let body = signed(
            &self.client,
            &self.user.username,
            &challenge,
            "changePassword",
            &old_login_crypto_manager,
            &Extra {
                totp: code,
                login_pubkey: Some(login_crypto_manager.pubkey()),
                encrypted_content: Some(&encrypted_content),
                ..Extra::default()
            },
        )?;
        let url = api_url(&self.client, "authentication/change_password/")?;
        let res = self.client.post(&url, body)?;
        checked(&res)?;

        self.main_key = main_key;
        self.user.encrypted_content = encrypted_content;
        Ok(())
    }

    /// What this account can see and change about its own security
    pub fn security(&self) -> AccountSecurity<'_> {
        AccountSecurity { account: self }
    }
}

/// An account's security settings on a Mindstream server.
///
/// Get one from [`Account::security`]. The calls that take a password sign
/// their request with the key derived from it, the way a sign-in does, so a
/// wrong one is refused by the server with [`refusal::WRONG_PASSWORD`].
pub struct AccountSecurity<'a> {
    account: &'a Account,
}

impl AccountSecurity<'_> {
    fn client(&self) -> &Client {
        &self.account.client
    }

    fn get(&self, path: &str) -> Result<Response> {
        let res = self.client().get(&api_url(self.client(), path)?)?;
        checked(&res)?;
        Ok(res)
    }

    fn post(&self, path: &str, body: Vec<u8>) -> Result<Response> {
        let res = self.client().post(&api_url(self.client(), path)?, body)?;
        checked(&res)?;
        Ok(res)
    }

    /// What the account has set up
    pub fn status(&self) -> Result<SecurityStatus> {
        let res = self.get("mindstream/security/")?;
        Ok(rmp_serde::from_slice(res.bytes())?)
    }

    /// Start setting up an authenticator, or replacing the one there is.
    ///
    /// Replacing asks for a `code` from the old one, unless this device
    /// signed in with it. See [`SecurityStatus::session_verified`].
    pub fn begin_authenticator(
        &self,
        password: &str,
        code: Option<&str>,
    ) -> Result<AuthenticatorSetup> {
        let body = self.proving(password, "enrollTotp", code, None)?;
        let res = self.post("mindstream/totp/enroll/", body)?;
        Ok(rmp_serde::from_slice(res.bytes())?)
    }

    /// Finish setting up an authenticator with a code from it. From here on
    /// the account needs one to sign in, and every other device is signed
    /// out. Returns the backup codes, which are shown once.
    pub fn confirm_authenticator(&self, code: &str) -> Result<Vec<String>> {
        #[derive(Serialize)]
        struct Body<'a> {
            code: &'a str,
        }

        let body = rmp_serde::to_vec_named(&Body { code })?;
        let res = self.post("mindstream/totp/confirm/", body)?;
        Ok(rmp_serde::from_slice::<BackupCodes>(res.bytes())?.backup_codes)
    }

    /// Turn the second factor off
    pub fn remove_authenticator(&self, password: &str, code: &str) -> Result<()> {
        let body = self.proving(password, "disableTotp", Some(code), None)?;
        self.post("mindstream/totp/disable/", body)?;
        Ok(())
    }

    /// Replace the backup codes. The old ones stop working.
    pub fn new_backup_codes(&self, password: &str, code: &str) -> Result<Vec<String>> {
        let body = self.proving(password, "newBackupCodes", Some(code), None)?;
        let res = self.post("mindstream/backup-codes/", body)?;
        Ok(rmp_serde::from_slice::<BackupCodes>(res.bytes())?.backup_codes)
    }

    /// Give the account a recovery key, replacing the one it has. Show the
    /// result to the user: the old key no longer works.
    pub fn new_recovery_key(&self, password: &str, code: Option<&str>) -> Result<RecoveryKey> {
        let key = RecoveryKey::generate();
        let sealed = key.sealed(self.account.version, &account_keys(self.account)?)?;
        let body = self.proving(password, "setRecovery", code, Some(&sealed))?;

        let url = api_url(self.client(), "mindstream/recovery/")?;
        let res = self.client().put(&url, body)?;
        checked(&res)?;
        Ok(key)
    }

    /// The devices signed in to the account, most recently used first
    pub fn sessions(&self) -> Result<Vec<DeviceSession>> {
        #[derive(Deserialize)]
        struct Sessions {
            sessions: Vec<DeviceSession>,
        }

        let res = self.get("mindstream/sessions/")?;
        Ok(rmp_serde::from_slice::<Sessions>(res.bytes())?.sessions)
    }

    /// Sign one device out
    pub fn end_session(&self, id: i64) -> Result<()> {
        let url = api_url(self.client(), &format!("mindstream/sessions/{}/", id))?;
        let res = self.client().delete(&url)?;
        checked(&res)
    }

    /// Sign every device out except this one
    pub fn end_other_sessions(&self) -> Result<()> {
        self.post("mindstream/sessions/revoke-others/", vec![])?;
        Ok(())
    }

    /// A signed body made with the key `password` stands for. One request
    /// for a challenge gets the salt that key is derived with as well.
    fn proving(
        &self,
        password: &str,
        action: &str,
        code: Option<&str>,
        recovery: Option<&(Vec<u8>, Vec<u8>)>,
    ) -> Result<Vec<u8>> {
        let account = self.account;
        let challenge = challenge_for(self.client(), &account.user.username)?;

        let typed_key = derive_key(&salt_of(&challenge)?, password)?;
        let signer = MainCryptoManager::new(&typed_key, account.version)?.login_crypto_manager()?;

        signed(
            self.client(),
            &account.user.username,
            &challenge,
            action,
            &signer,
            &Extra {
                totp: code,
                recovery_pubkey: recovery.map(|(pubkey, _)| &pubkey[..]),
                recovery_encrypted_content: recovery.map(|(_, copy)| &copy[..]),
                ..Extra::default()
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base32_round_trips_every_length() {
        for len in 0..40usize {
            let bytes: Vec<u8> = (0..len).map(|i| (i * 37 + 11) as u8).collect();
            assert_eq!(base32_decode(&base32_encode(&bytes)).unwrap(), bytes);
        }
        // The vectors of RFC 4648, without its padding.
        assert_eq!(base32_encode(b"foobar"), "MZXW6YTBOI");
        assert_eq!(base32_encode(b"fo"), "MZXQ");
        assert_eq!(base32_decode("mzxw-6ytb oi").unwrap(), b"foobar");
        assert!(base32_decode("MZXW1").is_none());
    }

    #[test]
    fn recovery_key_reads_back_from_its_text() {
        let key = RecoveryKey::generate();
        let text = key.to_string();
        assert_eq!(text.len(), 56 + 13);
        assert!(text
            .split('-')
            .all(|group| group.len() == 4 && group.bytes().all(|b| BASE32.contains(&b))));
        assert!(RecoveryKey::parse(&text).unwrap() == key);
        // As someone would type it from paper.
        let typed = text.to_lowercase().replace('-', " ");
        assert!(RecoveryKey::parse(&format!("  {}\n", typed)).unwrap() == key);
    }

    #[test]
    fn recovery_key_with_a_typing_mistake_is_caught() {
        let text = RecoveryKey::generate().to_string();
        let swapped: String = text
            .chars()
            .enumerate()
            .map(|(i, c)| match (i, c) {
                (0, 'A') => 'B',
                (0, _) => 'A',
                (_, c) => c,
            })
            .collect();
        assert!(RecoveryKey::parse(&swapped).is_err());
        assert!(RecoveryKey::parse(&text[..text.len() - 5]).is_err());
        assert!(RecoveryKey::parse("").is_err());
        assert!(RecoveryKey::parse("not a recovery key at all").is_err());
    }

    #[test]
    fn recovery_key_stays_out_of_debug_output() {
        let key = RecoveryKey::generate();
        assert_eq!(format!("{:?}", key), "RecoveryKey(..)");
    }

    #[test]
    fn recovery_key_opens_what_it_sealed_and_nothing_else_does() {
        let key = RecoveryKey::generate();
        let (pubkey, copy) = key.sealed(1, b"the account's keys").unwrap();
        assert_eq!(pubkey.len(), 32);
        let opened = key.crypto_manager(1).unwrap().decrypt(&copy, None).unwrap();
        assert_eq!(opened, b"the account's keys");
        // The same key signs the same way each time, or the server could
        // not check a recovery against what signup stored.
        assert_eq!(key.signer(1).unwrap().pubkey(), &pubkey[..]);

        let other = RecoveryKey::generate();
        assert!(other
            .crypto_manager(1)
            .unwrap()
            .decrypt(&copy, None)
            .is_err());
    }

    #[test]
    fn refusal_keeps_the_servers_reason() {
        #[derive(Serialize)]
        struct Body<'a> {
            code: &'a str,
            detail: &'a str,
        }
        let body = rmp_serde::to_vec_named(&Body {
            code: refusal::CODE_REQUIRED,
            detail: "Enter the code from your authenticator app.",
        })
        .unwrap();
        assert_eq!(
            checked(&Response::new(body, 401)),
            Err(Error::Refused {
                status: 401,
                code: refusal::CODE_REQUIRED.to_string(),
                detail: "Enter the code from your authenticator app.".to_string(),
            })
        );
        assert!(checked(&Response::new(vec![], 204)).is_ok());
        // An answer that is not this server's falls back to the status.
        assert_eq!(
            checked(&Response::new(b"<html>".to_vec(), 404)),
            Err(Error::NotFound("NotFound".to_string()))
        );
    }
}
