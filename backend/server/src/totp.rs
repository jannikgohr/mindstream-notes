//! Time-based one-time passwords, RFC 6238.
//!
//! Fixed to the parameters every authenticator app honours: SHA-1, six
//! digits, a 30 second step. Several popular apps ignore any others an
//! enrolment asks for and would then show codes the server rejects.

use hmac::{Hmac, Mac};
use sha1::Sha1;

pub const STEP_SECS: u64 = 30;
pub const SECRET_LEN: usize = 20;
const DIGITS: u32 = 6;
/// Steps either side of the current one that are still accepted, for clocks
/// that disagree and codes typed slowly.
const WINDOW: u64 = 1;

pub fn step_at(unix_secs: u64) -> u64 {
    unix_secs / STEP_SECS
}

pub fn code_at(secret: &[u8], step: u64) -> u32 {
    let mut mac = Hmac::<Sha1>::new_from_slice(secret).expect("any key length works");
    mac.update(&step.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[19] & 0x0f) as usize;
    let binary = u32::from_be_bytes([
        digest[offset] & 0x7f,
        digest[offset + 1],
        digest[offset + 2],
        digest[offset + 3],
    ]);
    binary % 10u32.pow(DIGITS)
}

/// The time step a code is valid for, if it is valid around `now` and newer
/// than `last_step`, the step of the last code this account used. Refusing
/// an already-used step is what stops a code read over a shoulder, or off
/// the wire, from being used a second time.
pub fn verify(secret: &[u8], code: &str, now_secs: u64, last_step: u64) -> Option<u64> {
    let code = code.trim();
    if code.len() != DIGITS as usize || !code.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let code: u32 = code.parse().ok()?;
    let current = step_at(now_secs);
    (current.saturating_sub(WINDOW)..=current + WINDOW)
        .filter(|step| *step > last_step)
        // Compare every candidate so timing says nothing about which matched.
        .fold(None, |found, step| {
            if code_at(secret, step) == code {
                Some(step)
            } else {
                found
            }
        })
}

const BASE32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// RFC 4648 base32 without padding, the form authenticator apps expect a
/// secret in.
pub fn base32(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let mut buffer = 0u32;
    let mut bits = 0;
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

/// The link an authenticator app reads, usually from a QR code.
pub fn provisioning_url(issuer: &str, account: &str, secret: &[u8]) -> String {
    let escape = |text: &str| -> String {
        text.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                    (b as char).to_string()
                }
                other => format!("%{other:02X}"),
            })
            .collect()
    };
    format!(
        "otpauth://totp/{}:{}?secret={}&issuer={}&algorithm=SHA1&digits={DIGITS}&period={STEP_SECS}",
        escape(issuer),
        escape(account),
        base32(secret),
        escape(issuer),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const RFC_SECRET: &[u8] = b"12345678901234567890";

    #[test]
    fn codes_match_the_rfc_test_vectors() {
        // RFC 6238 appendix B lists eight-digit codes; these are their last
        // six digits.
        for (time, code) in [
            (59u64, 287082u32),
            (1111111109, 81804),
            (1111111111, 50471),
            (1234567890, 5924),
            (2000000000, 279037),
            (20000000000, 353130),
        ] {
            assert_eq!(code_at(RFC_SECRET, step_at(time)), code, "at {time}");
        }
    }

    #[test]
    fn code_is_accepted_around_its_step_and_only_once() {
        let now = 1_700_000_000;
        let step = step_at(now);
        let code = format!("{:06}", code_at(RFC_SECRET, step));
        assert_eq!(verify(RFC_SECRET, &code, now, 0), Some(step));
        // A step late or early is still fine.
        assert_eq!(verify(RFC_SECRET, &code, now + STEP_SECS, 0), Some(step));
        assert_eq!(verify(RFC_SECRET, &code, now - STEP_SECS, 0), Some(step));
        // Two steps late is not.
        assert_eq!(verify(RFC_SECRET, &code, now + 2 * STEP_SECS, 0), None);
        // Nor is a code whose step was already used.
        assert_eq!(verify(RFC_SECRET, &code, now, step), None);
        // The next code is.
        let next = format!("{:06}", code_at(RFC_SECRET, step + 1));
        assert_eq!(verify(RFC_SECRET, &next, now, step), Some(step + 1));
    }

    #[test]
    fn malformed_codes_are_refused() {
        let now = 1_700_000_000;
        for code in ["", "12345", "1234567", "12a456", "１２３４５６"] {
            assert_eq!(verify(RFC_SECRET, code, now, 0), None, "{code}");
        }
        // Leading zeros are part of the code.
        let step = (0..)
            .map(|i| step_at(now) + i)
            .find(|step| code_at(RFC_SECRET, *step) < 100_000)
            .unwrap();
        let code = format!("{:06}", code_at(RFC_SECRET, step));
        assert!(code.starts_with('0'));
        assert_eq!(verify(RFC_SECRET, &code, step * STEP_SECS, 0), Some(step));
    }

    #[test]
    fn base32_matches_the_rfc_examples() {
        for (plain, encoded) in [
            ("", ""),
            ("f", "MY"),
            ("fo", "MZXQ"),
            ("foo", "MZXW6"),
            ("foob", "MZXW6YQ"),
            ("fooba", "MZXW6YTB"),
            ("foobar", "MZXW6YTBOI"),
        ] {
            assert_eq!(base32(plain.as_bytes()), encoded);
        }
    }

    #[test]
    fn provisioning_url_is_what_an_authenticator_reads() {
        let url = provisioning_url("Mindstream Notes", "ann@home", RFC_SECRET);
        assert_eq!(
            url,
            "otpauth://totp/Mindstream%20Notes:ann%40home\
             ?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Mindstream%20Notes\
             &algorithm=SHA1&digits=6&period=30"
        );
    }
}
