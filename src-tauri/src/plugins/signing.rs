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
//! The signed payload is the plugin's **package digest** (see [`package_digest`]),
//! not just `manifest.json`: it folds in a content hash of every file in the
//! plugin dir. So a valid signature covers the manifest AND the `.luau` code (and
//! any assets) — tampering with a script breaks the signature exactly as editing
//! the manifest does, which is what makes running a signed `luau` plugin safe.

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

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn fingerprint(public_key: &[u8]) -> String {
    sha256_hex(public_key)
}

/// Build the canonical **package digest document** a plugin's signature covers.
///
/// For every file (except `signature.json`, which can't sign itself) it emits
/// one record `"<relpath>\n<sha256-hex>\n"`, with records sorted by `relpath`.
/// Signing this document instead of just `manifest.json` means one signature
/// authenticates the manifest *and* every code/asset file together.
///
/// Paths use `/` separators and must be ASCII so this and the Node signer
/// (`scripts/sign-plugin.mjs`) produce byte-identical documents; the same
/// constraint the manifest already puts on plugin filenames. Pure — the caller
/// supplies `(relpath, bytes)` pairs read from disk.
pub fn package_digest(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut records: Vec<(&str, String)> = files
        .iter()
        .filter(|(path, _)| path != "signature.json")
        .map(|(path, bytes)| (path.as_str(), sha256_hex(bytes)))
        .collect();
    records.sort_by(|a, b| a.0.cmp(b.0));
    let mut doc = String::new();
    for (path, hex) in records {
        let _ = write!(doc, "{path}\n{hex}\n");
    }
    doc.into_bytes()
}

/// Verify a plugin's signature over its signed payload (the [`package_digest`]
/// document). `sig_json` is the contents of `signature.json`, or `None` when
/// absent (→ [`SignatureStatus::Unsigned`]).
pub fn verify(signed_payload: &[u8], sig_json: Option<&[u8]>) -> Verification {
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
    match verifying_key.verify_strict(signed_payload, &signature) {
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
    fn verifies_a_node_produced_package_signature() {
        // Cross-language regression vector: a signature.json produced by
        // scripts/sign-plugin.mjs over the *package digest* of these exact files
        // must verify here. Because the signature only checks out if Rust's
        // package_digest reproduces Node's byte-for-byte, this locks both the
        // digest format and the Ed25519 wire format in lockstep with the signer.
        let vector = files(&[
            ("manifest.json", br#"{"id":"com.vector.test"}"# as &[u8]),
            ("main.luau", b"return {}"),
        ]);
        let digest = package_digest(&vector);
        let json = r#"{"algorithm":"ed25519","publicKey":"yeBWzJ6K/6SqN7KGeco1huwxA7Ja0eYA1aviH+QWx6k=","signature":"/WWWW2hOoykmGqKuSeFDJuVL/cbfn3u5cBpvvWi7DkN4Of1DZvmd3bWTCNRN+2s+MCwXNECPreMTByVVkqTvDA=="}"#;
        assert_eq!(
            verify(&digest, Some(json.as_bytes())).status,
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

    fn files(pairs: &[(&str, &[u8])]) -> Vec<(String, Vec<u8>)> {
        pairs
            .iter()
            .map(|(p, b)| (p.to_string(), b.to_vec()))
            .collect()
    }

    #[test]
    fn package_digest_is_order_independent_and_skips_signature() {
        let a = package_digest(&files(&[
            ("manifest.json", b"{}"),
            ("main.luau", b"return {}"),
            ("signature.json", b"whatever"),
        ]));
        // Reordered input, and the signature file present or not, must not change it.
        let b = package_digest(&files(&[
            ("main.luau", b"return {}"),
            ("manifest.json", b"{}"),
        ]));
        assert_eq!(a, b);
    }

    #[test]
    fn package_digest_covers_code_files() {
        let base = package_digest(&files(&[
            ("manifest.json", b"{}"),
            ("main.luau", b"return 1"),
        ]));
        let edited = package_digest(&files(&[
            ("manifest.json", b"{}"),
            ("main.luau", b"return 2"),
        ]));
        assert_ne!(base, edited, "editing a .luau file must change the digest");
    }

    #[test]
    fn package_digest_has_the_documented_shape() {
        // "<relpath>\n<sha256-hex>\n" per file, sorted by path. Locks the exact
        // bytes the Node signer must reproduce.
        let doc = package_digest(&files(&[("b.luau", b"y"), ("a.json", b"x")]));
        let expected = format!(
            "a.json\n{}\nb.luau\n{}\n",
            sha256_hex(b"x"),
            sha256_hex(b"y")
        );
        assert_eq!(String::from_utf8(doc).unwrap(), expected);
    }
}
