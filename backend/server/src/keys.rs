//! Tokens the server issues and later has to recognise: sync cursors, login
//! challenges and session tokens.
//!
//! All of them are authenticated with keys derived from one secret that lives
//! in the database. A cursor or challenge from another database, or from this
//! one before it was wiped, therefore fails to verify, which is what tells a
//! client to start over instead of silently skipping changes.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;

const STOKEN_TAG_LEN: usize = 16;
const CHALLENGE_NONCE_LEN: usize = 16;
const CHALLENGE_TAG_LEN: usize = 32;
/// How long a client has to answer a login challenge.
const CHALLENGE_TTL_SECS: u64 = 300;

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes
}

pub fn to_base64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[derive(Clone)]
pub struct Keys {
    stoken: [u8; 32],
    challenge: [u8; 32],
}

impl Keys {
    /// Load the server secret, creating it on first start.
    pub async fn load(pool: &PgPool) -> Result<Self, sqlx::Error> {
        let fresh = random_bytes::<32>();
        sqlx::query(
            "INSERT INTO server_meta (key, value) VALUES ('secret', $1) ON CONFLICT DO NOTHING",
        )
        .bind(&fresh[..])
        .execute(pool)
        .await?;
        let secret: Vec<u8> =
            sqlx::query_scalar("SELECT value FROM server_meta WHERE key = 'secret'")
                .fetch_one(pool)
                .await?;
        Ok(Self::from_secret(&secret))
    }

    pub fn from_secret(secret: &[u8]) -> Self {
        let derive = |label: &[u8]| -> [u8; 32] {
            let mut mac = HmacSha256::new_from_slice(secret).expect("any key length works");
            mac.update(label);
            mac.finalize().into_bytes().into()
        };
        Self {
            stoken: derive(b"mindstream-server/stoken/v1"),
            challenge: derive(b"mindstream-server/login-challenge/v1"),
        }
    }

    /// A cursor: a change number the client hands back to ask for everything
    /// after it.
    pub fn stoken(&self, seq: i64) -> String {
        let seq = seq.to_be_bytes();
        let mut mac = HmacSha256::new_from_slice(&self.stoken).expect("any key length works");
        mac.update(&seq);
        let tag = mac.finalize().into_bytes();
        let mut token = [0u8; 8 + STOKEN_TAG_LEN];
        token[..8].copy_from_slice(&seq);
        token[8..].copy_from_slice(&tag[..STOKEN_TAG_LEN]);
        to_base64(&token)
    }

    pub fn parse_stoken(&self, token: &str) -> Option<i64> {
        let bytes = URL_SAFE_NO_PAD.decode(token).ok()?;
        if bytes.len() != 8 + STOKEN_TAG_LEN {
            return None;
        }
        let seq = i64::from_be_bytes(bytes[..8].try_into().ok()?);
        let expected = self.stoken(seq);
        bool::from(expected.as_bytes().ct_eq(token.as_bytes())).then_some(seq)
    }

    /// A login challenge: the account it was issued for, when, and a nonce,
    /// authenticated so the server need not remember it.
    pub fn challenge(&self, account_id: i64) -> Vec<u8> {
        let mut out = Vec::with_capacity(16 + CHALLENGE_NONCE_LEN + CHALLENGE_TAG_LEN);
        out.extend_from_slice(&now_secs().to_be_bytes());
        out.extend_from_slice(&account_id.to_be_bytes());
        out.extend_from_slice(&random_bytes::<CHALLENGE_NONCE_LEN>());
        let mut mac = HmacSha256::new_from_slice(&self.challenge).expect("any key length works");
        mac.update(&out);
        out.extend_from_slice(&mac.finalize().into_bytes());
        out
    }

    pub fn verify_challenge(&self, challenge: &[u8], account_id: i64) -> ChallengeCheck {
        let body_len = 16 + CHALLENGE_NONCE_LEN;
        if challenge.len() != body_len + CHALLENGE_TAG_LEN {
            return ChallengeCheck::Invalid;
        }
        let (body, tag) = challenge.split_at(body_len);
        let mut mac = HmacSha256::new_from_slice(&self.challenge).expect("any key length works");
        mac.update(body);
        if mac.verify_slice(tag).is_err() {
            return ChallengeCheck::Invalid;
        }
        let issued = u64::from_be_bytes(body[..8].try_into().expect("8 bytes"));
        let issued_for = i64::from_be_bytes(body[8..16].try_into().expect("8 bytes"));
        if issued_for != account_id {
            return ChallengeCheck::Invalid;
        }
        if now_secs().saturating_sub(issued) > CHALLENGE_TTL_SECS {
            return ChallengeCheck::Expired;
        }
        ChallengeCheck::Valid
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ChallengeCheck {
    Valid,
    Expired,
    Invalid,
}

/// A fresh session token and the hash the server keeps of it.
pub fn new_session_token() -> (String, [u8; 32]) {
    let token = to_base64(&random_bytes::<32>());
    let hash = hash_session_token(&token);
    (token, hash)
}

pub fn hash_session_token(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stoken_round_trips_and_rejects_foreign_tokens() {
        let keys = Keys::from_secret(b"one");
        let token = keys.stoken(42);
        assert_eq!(keys.parse_stoken(&token), Some(42));
        assert_eq!(token.len(), 32);

        let other = Keys::from_secret(b"two");
        assert_eq!(other.parse_stoken(&token), None);
        assert_eq!(keys.parse_stoken("not-a-stoken"), None);
        // An etag has the alphabet of a stoken but not its length.
        assert_eq!(keys.parse_stoken("ukw7n0Fo0Snv0V-q5cSvHw"), None);
    }

    #[test]
    fn challenge_is_bound_to_the_account() {
        let keys = Keys::from_secret(b"one");
        let challenge = keys.challenge(7);
        assert_eq!(keys.verify_challenge(&challenge, 7), ChallengeCheck::Valid);
        assert_eq!(
            keys.verify_challenge(&challenge, 8),
            ChallengeCheck::Invalid
        );

        let mut tampered = challenge.clone();
        tampered[20] ^= 1;
        assert_eq!(keys.verify_challenge(&tampered, 7), ChallengeCheck::Invalid);
        assert_eq!(
            Keys::from_secret(b"two").verify_challenge(&challenge, 7),
            ChallengeCheck::Invalid
        );
    }

    #[test]
    fn stale_challenge_expires() {
        let keys = Keys::from_secret(b"one");
        let mut body = Vec::new();
        body.extend_from_slice(&(now_secs() - CHALLENGE_TTL_SECS - 5).to_be_bytes());
        body.extend_from_slice(&7i64.to_be_bytes());
        body.extend_from_slice(&[0u8; CHALLENGE_NONCE_LEN]);
        let mut mac = HmacSha256::new_from_slice(&keys.challenge).unwrap();
        mac.update(&body);
        body.extend_from_slice(&mac.finalize().into_bytes());
        assert_eq!(keys.verify_challenge(&body, 7), ChallengeCheck::Expired);
    }
}
