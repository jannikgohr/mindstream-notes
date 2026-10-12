//! Time-based one-time passwords, RFC 6238.
//!
//! The arithmetic, the base32 and the link an authenticator reads are
//! `totp-rs`. What is decided here is the parameters, and that a time step
//! is accepted once.
//!
//! The parameters are the ones every authenticator app honours: SHA-1, six
//! digits, a 30 second step. Several popular apps ignore any others an
//! enrolment asks for and would then show codes the server rejects.

use totp_rs::{Algorithm, Builder, TotpError};

pub const STEP_SECS: u64 = 30;
pub const SECRET_LEN: usize = 20;
const DIGITS: u8 = 6;
/// Steps either side of the current one that are still accepted, for clocks
/// that disagree and codes typed slowly.
const WINDOW: u16 = 1;

fn authenticator(secret: &[u8]) -> Builder {
    Builder::new()
        .with_algorithm(Algorithm::SHA1)
        .with_digits(DIGITS)
        .with_step_duration(STEP_SECS)
        .with_skew(WINDOW)
        .with_secret(secret)
}

pub fn step_at(unix_secs: u64) -> u64 {
    unix_secs / STEP_SECS
}

/// The code an authenticator shows during a time step.
pub fn code_at(secret: &[u8], step: u64) -> String {
    authenticator(secret)
        .build_noncompliant()
        .generate(step * STEP_SECS)
        .to_string()
}

/// The time step a code is valid for, if it is valid around `now` and newer
/// than `last_step`, the step of the last code this account used. Refusing
/// an already-used step is what stops a code read over a shoulder, or off
/// the wire, from being used a second time. The caller stores the step it
/// gets back, in the same statement that checks nobody stored it first.
pub fn verify(secret: &[u8], code: &str, now_secs: u64, last_step: u64) -> Option<u64> {
    let step = authenticator(secret)
        .build()
        .ok()?
        .check(code.trim(), now_secs)?;
    (step > last_step).then_some(step)
}

/// RFC 4648 base32 without padding, the form authenticator apps expect a
/// secret in.
pub fn base32(bytes: &[u8]) -> String {
    base32::encode(base32::Alphabet::Rfc4648 { padding: false }, bytes)
}

/// Whether an authenticator can show this as the name of the server. It
/// labels an entry `issuer:account`, so the name cannot hold a colon.
pub fn valid_issuer(issuer: &str) -> bool {
    !issuer.is_empty() && !issuer.contains(':')
}

/// The link an authenticator app reads, usually from a QR code. It names
/// the secret, the issuer and the account. The rest is left out, since what
/// this server uses is what an app assumes when a link says nothing.
pub fn provisioning_url(issuer: &str, account: &str, secret: &[u8]) -> Result<String, TotpError> {
    authenticator(secret)
        .with_issuer(Some(issuer))
        .with_account_name(account)
        .build()?
        .to_url()
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
            (59u64, "287082"),
            (1111111109, "081804"),
            (1111111111, "050471"),
            (1234567890, "005924"),
            (2000000000, "279037"),
            (20000000000, "353130"),
        ] {
            assert_eq!(code_at(RFC_SECRET, step_at(time)), code, "at {time}");
        }
    }

    #[test]
    fn code_is_accepted_around_its_step_and_only_once() {
        let now = 1_700_000_000;
        let step = step_at(now);
        let code = code_at(RFC_SECRET, step);
        assert_eq!(verify(RFC_SECRET, &code, now, 0), Some(step));
        // A step late or early is still fine.
        assert_eq!(verify(RFC_SECRET, &code, now + STEP_SECS, 0), Some(step));
        assert_eq!(verify(RFC_SECRET, &code, now - STEP_SECS, 0), Some(step));
        // Two steps late is not.
        assert_eq!(verify(RFC_SECRET, &code, now + 2 * STEP_SECS, 0), None);
        // Nor is a code whose step was already used.
        assert_eq!(verify(RFC_SECRET, &code, now, step), None);
        // The next code is.
        let next = code_at(RFC_SECRET, step + 1);
        assert_eq!(verify(RFC_SECRET, &next, now, step), Some(step + 1));
    }

    #[test]
    fn malformed_codes_are_refused() {
        let now = 1_700_000_000;
        for code in ["", "12345", "1234567", "12a456", "+12345", "１２３４５６"] {
            assert_eq!(verify(RFC_SECRET, code, now, 0), None, "{code}");
        }
        // Leading zeros are part of the code.
        let step = (0..)
            .map(|i| step_at(now) + i)
            .find(|step| code_at(RFC_SECRET, *step).starts_with('0'))
            .unwrap();
        let code = code_at(RFC_SECRET, step);
        assert_eq!(verify(RFC_SECRET, &code, step * STEP_SECS, 0), Some(step));
        // Typed with a space after it, as pasted codes often are.
        let spaced = format!(" {code} ");
        assert_eq!(verify(RFC_SECRET, &spaced, step * STEP_SECS, 0), Some(step));
    }

    #[test]
    fn secret_too_short_to_be_one_verifies_nothing() {
        let now = 1_700_000_000;
        let weak = b"short";
        let code = code_at(weak, step_at(now));
        assert_eq!(verify(weak, &code, now, 0), None);
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
        let url = provisioning_url("Mindstream Notes", "ann.b_c-d", RFC_SECRET).unwrap();
        assert_eq!(
            url,
            "otpauth://totp/Mindstream%20Notes:ann.b_c-d\
             ?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Mindstream%20Notes"
        );
    }

    #[test]
    fn issuer_with_a_colon_is_not_a_name_an_authenticator_can_show() {
        assert!(valid_issuer("Mindstream Notes"));
        assert!(!valid_issuer("Notes: home"));
        assert!(!valid_issuer(""));
        assert!(provisioning_url("Notes: home", "ann", RFC_SECRET).is_err());
    }
}
