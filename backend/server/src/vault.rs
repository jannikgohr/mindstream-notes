//! Encryption for the few secrets the server has to be able to read back.
//!
//! Nearly everything here is either ciphertext only clients can open or a
//! hash. A one-time-password secret is neither: the server needs the secret
//! itself to check a code. It is kept encrypted under a key that lives
//! outside the database, so a copy of the database alone does not give an
//! attacker everyone's second factor.
//!
//! Losing the key makes every enrolled second factor unreadable. Back it up
//! with the database.

use std::io;
use std::path::Path;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};

use crate::keys::random_bytes;

const NONCE_LEN: usize = 24;

#[derive(Clone)]
pub struct Vault {
    cipher: XChaCha20Poly1305,
}

impl Vault {
    pub fn from_key(key: &[u8; 32]) -> Self {
        Self {
            cipher: XChaCha20Poly1305::new(key.into()),
        }
    }

    /// The key from configuration when one is given there, otherwise from
    /// the key file, which is created with a fresh key on first start.
    pub async fn load(configured: Option<&str>, file: &Path) -> io::Result<Self> {
        let invalid = |what: &str| io::Error::new(io::ErrorKind::InvalidData, what.to_owned());
        let decode = |text: &str| -> io::Result<[u8; 32]> {
            URL_SAFE_NO_PAD
                .decode(text.trim().trim_end_matches('='))
                .ok()
                .and_then(|bytes| bytes.try_into().ok())
                .ok_or_else(|| invalid("the secret key must be 32 bytes of URL-safe base64"))
        };
        if let Some(configured) = configured.filter(|key| !key.is_empty()) {
            return Ok(Self::from_key(&decode(configured)?));
        }
        match tokio::fs::read_to_string(file).await {
            Ok(existing) => Ok(Self::from_key(&decode(&existing)?)),
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                let key = random_bytes::<32>();
                if let Some(parent) = file.parent() {
                    tokio::fs::create_dir_all(parent).await?;
                }
                tokio::fs::write(file, URL_SAFE_NO_PAD.encode(key)).await?;
                Ok(Self::from_key(&key))
            }
            Err(err) => Err(err),
        }
    }

    pub fn seal(&self, plain: &[u8]) -> Vec<u8> {
        let nonce = random_bytes::<NONCE_LEN>();
        let mut sealed = nonce.to_vec();
        sealed.extend(
            self.cipher
                .encrypt(XNonce::from_slice(&nonce), plain)
                .expect("encrypting in memory cannot fail"),
        );
        sealed
    }

    /// `None` when the data was sealed under another key or has been altered.
    pub fn open(&self, sealed: &[u8]) -> Option<Vec<u8>> {
        if sealed.len() < NONCE_LEN {
            return None;
        }
        let (nonce, ciphertext) = sealed.split_at(NONCE_LEN);
        self.cipher
            .decrypt(XNonce::from_slice(nonce), ciphertext)
            .ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_data_opens_only_under_its_key_and_unaltered() {
        let vault = Vault::from_key(&[7; 32]);
        let sealed = vault.seal(b"otp secret");
        assert_ne!(&sealed[NONCE_LEN..], b"otp secret");
        assert_eq!(vault.open(&sealed).as_deref(), Some(&b"otp secret"[..]));
        // Sealing twice gives different bytes, so equal secrets do not show.
        assert_ne!(vault.seal(b"otp secret"), sealed);

        assert_eq!(Vault::from_key(&[8; 32]).open(&sealed), None);
        let mut altered = sealed.clone();
        *altered.last_mut().unwrap() ^= 1;
        assert_eq!(vault.open(&altered), None);
        assert_eq!(vault.open(b"short"), None);
    }

    #[tokio::test]
    async fn key_file_is_created_once_and_then_reused() {
        let dir = std::env::temp_dir().join(format!(
            "mindstream-vault-test-{}",
            URL_SAFE_NO_PAD.encode(random_bytes::<8>())
        ));
        let file = dir.join("secret.key");
        let first = Vault::load(None, &file).await.unwrap();
        let sealed = first.seal(b"x");
        let second = Vault::load(None, &file).await.unwrap();
        assert_eq!(second.open(&sealed).as_deref(), Some(&b"x"[..]));

        // A configured key takes precedence over the file.
        let configured = URL_SAFE_NO_PAD.encode([9u8; 32]);
        let third = Vault::load(Some(&configured), &file).await.unwrap();
        assert_eq!(third.open(&sealed), None);
        assert!(Vault::load(Some("too-short"), &file).await.is_err());

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
