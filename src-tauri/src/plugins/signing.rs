//! Plugin signature verification (Ed25519).
//!
//! A signed plugin ships a `signature.json` next to its `manifest.json`:
//!
//! ```json
//! { "algorithm": "ed25519", "publicKey": "<base64 32-byte key>",
//!   "signature": "<base64 64-byte signature over the raw manifest.json bytes>" }
//! ```
//!
//! Verification is purely authorship: it proves the manifest bytes were signed
//! by the holder of `publicKey`. It does NOT by itself grant trust — the load
//! location still decides `builtin` vs `installed` (see [`super::discovery`]).
//! What a valid signature buys an *installed* plugin is that updates from the
//! **same signer** auto-approve instead of re-prompting (see `plugins::upsert`):
//! tampering breaks the signature, an unsigned edit has no signer to match, and
//! a signer change is treated as untrusted — all fall back to the gate.
//!
//! Manifest-only plugins have no executable files, so signing the manifest
//! covers everything a plugin can do today. Before any code runtime (JS/WASM)
//! lands, signing must also cover those files.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;

/// Result of verifying a plugin's signature against its manifest bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignatureStatus {
    /// No `signature.json` present.
    Unsigned,
    /// Signature present and verifies against the manifest bytes.
    Valid,
    /// Signature present but malformed or does not verify.
    Invalid,
}

impl SignatureStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unsigned => "unsigned",
            Self::Valid => "valid",
            Self::Invalid => "invalid",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignatureFile {
    algorithm: String,
    public_key: String,
    signature: String,
}

/// The outcome of [`verify`]: a status and, when valid, the signer fingerprint.
pub struct Verification {
    pub status: SignatureStatus,
    /// SHA-256 (hex) of the signer's public key — a stable id for the author,
    /// pinned on approval so only the same author's updates auto-approve.
    pub signer: Option<String>,
}

fn invalid() -> Verification {
    Verification {
        status: SignatureStatus::Invalid,
        signer: None,
    }
}

fn fingerprint(public_key: &[u8]) -> String {
    let digest = Sha256::digest(public_key);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Verify a plugin's signature over its raw manifest bytes. `sig_json` is the
/// contents of `signature.json`, or `None` when absent (→ [`SignatureStatus::Unsigned`]).
pub fn verify(manifest_bytes: &[u8], sig_json: Option<&[u8]>) -> Verification {
    let Some(raw) = sig_json else {
        return Verification {
            status: SignatureStatus::Unsigned,
            signer: None,
        };
    };
    let file: SignatureFile = match serde_json::from_slice(raw) {
        Ok(file) => file,
        Err(_) => return invalid(),
    };
    if file.algorithm != "ed25519" {
        return invalid();
    }
    let (Ok(public_key), Ok(signature_bytes)) = (
        BASE64.decode(&file.public_key),
        BASE64.decode(&file.signature),
    ) else {
        return invalid();
    };
    let Ok(key_arr) = <[u8; 32]>::try_from(public_key.as_slice()) else {
        return invalid();
    };
    let Ok(verifying_key) = VerifyingKey::from_bytes(&key_arr) else {
        return invalid();
    };
    let Ok(sig_arr) = <[u8; 64]>::try_from(signature_bytes.as_slice()) else {
        return invalid();
    };
    let signature = Signature::from_bytes(&sig_arr);
    // `verify_strict` rejects the small-order / malleable edge cases.
    match verifying_key.verify_strict(manifest_bytes, &signature) {
        Ok(()) => Verification {
            status: SignatureStatus::Valid,
            signer: Some(fingerprint(&key_arr)),
        },
        Err(_) => invalid(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    /// Sign `manifest` with a deterministic key; returns (signature.json, fingerprint).
    fn sign(seed: [u8; 32], manifest: &[u8]) -> (String, String) {
        let key = SigningKey::from_bytes(&seed);
        let signature = key.sign(manifest);
        let public_key = key.verifying_key().to_bytes();
        let json = format!(
            r#"{{"algorithm":"ed25519","publicKey":"{}","signature":"{}"}}"#,
            BASE64.encode(public_key),
            BASE64.encode(signature.to_bytes())
        );
        (json, fingerprint(&public_key))
    }

    #[test]
    fn absent_signature_is_unsigned() {
        assert_eq!(verify(b"anything", None).status, SignatureStatus::Unsigned);
    }

    #[test]
    fn valid_signature_verifies_and_reports_signer() {
        let manifest = br#"{"id":"com.a.plugin"}"#;
        let (sig_json, fp) = sign([7u8; 32], manifest);
        let v = verify(manifest, Some(sig_json.as_bytes()));
        assert_eq!(v.status, SignatureStatus::Valid);
        assert_eq!(v.signer, Some(fp));
    }

    #[test]
    fn tampered_manifest_fails_verification() {
        let (sig_json, _) = sign([7u8; 32], b"original manifest");
        let v = verify(b"tampered manifest", Some(sig_json.as_bytes()));
        assert_eq!(v.status, SignatureStatus::Invalid);
        assert_eq!(v.signer, None);
    }

    #[test]
    fn different_keys_produce_different_signer_fingerprints() {
        let manifest = b"m";
        let (_, fp_a) = sign([1u8; 32], manifest);
        let (_, fp_b) = sign([2u8; 32], manifest);
        assert_ne!(fp_a, fp_b);
    }

    #[test]
    fn malformed_signature_file_is_invalid() {
        assert_eq!(
            verify(b"m", Some(b"{ not json")).status,
            SignatureStatus::Invalid
        );
    }

    #[test]
    fn verifies_a_node_produced_signature() {
        // Cross-language regression vector: signature.json produced by
        // scripts/sign-plugin.mjs (Node crypto Ed25519) must verify here, so the
        // wire format (raw 32B key + 64B sig, base64) stays in lockstep.
        let manifest = br#"{"id":"com.vector.test"}"#;
        let json = r#"{"algorithm":"ed25519","publicKey":"xHD3gzq37esikrxNomLMrk4FfmB9EIUG0I56inynpoc=","signature":"uM8iLxZyUo0reLeQkceAYEIKBGK8fAOFty77YVxc6Hdru8VdI1AIvWyHwRQGuJsi1rB3MOZyrm0yVedCEDAFAQ=="}"#;
        assert_eq!(
            verify(manifest, Some(json.as_bytes())).status,
            SignatureStatus::Valid
        );
    }

    #[test]
    fn unknown_algorithm_is_invalid() {
        let json = r#"{"algorithm":"rsa","publicKey":"AA==","signature":"AA=="}"#;
        assert_eq!(
            verify(b"m", Some(json.as_bytes())).status,
            SignatureStatus::Invalid
        );
    }
}
