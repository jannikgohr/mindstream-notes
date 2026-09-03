//! Does the LanguageTool plugin's manifest still describe LanguageTool?
//!
//! Everything else about the checker is tested against a stub, deliberately:
//! the app's own behaviour is what those tests are about, and a stub can
//! assert what it RECEIVED, which a real server cannot. The one question a
//! stub can never answer is whether the wire format the manifest describes is
//! still the wire format the service speaks — a stub answers in whatever shape
//! we taught it, including a shape the real service abandoned two releases ago.
//!
//! So this file tests THEIR side of the contract and nothing of ours. It is
//! two tests:
//!
//!   - the manifest still deserializes into a protocol this crate can execute,
//!     which runs everywhere and costs nothing;
//!   - the declared pointers actually resolve against a live server's reply,
//!     which runs only when `MINDSTREAM_LT_ENDPOINT` names one.
//!
//! The network test SKIPS when that variable is unset, so it stays out of the
//! ordinary suite and out of required CI. Point it at whatever instance you
//! already run:
//!
//!   MINDSTREAM_LT_ENDPOINT=http://localhost:8010 cargo test --test languagetool_contract -- --nocapture
//!
//! It is deliberately not wired into a Docker image. Pinning a LanguageTool
//! version in CI would test their release process on every push of ours; the
//! drift this catches is slow, and catching it the first time someone runs the
//! suite against a real server is soon enough.

use mindstream_notes_lib::spellcheck::http_checker::{check, CheckInput, CheckerProtocol};
use serde_json::Value;

/// The environment variable that opts in to the live half.
const ENDPOINT_VAR: &str = "MINDSTREAM_LT_ENDPOINT";

/// Fixed text, never note content — the same rule the connection test follows.
///
/// Two misspellings an English dictionary is certain to reject, in a sentence
/// long enough that language detection has something to work with.
const SAMPLE: &str = "Ths sentence has a typpo in it.";

/// The `protocol` block of the checker the plugin contributes.
fn manifest_protocol() -> Value {
    let raw = include_str!("../../plugins/languagetool/manifest.json");
    let manifest: Value = serde_json::from_str(raw).expect("manifest is not valid JSON");
    manifest["contributes"]["textCheckers"]
        .as_array()
        .and_then(|checkers| checkers.first())
        .expect("the manifest contributes no text checker")["protocol"]
        .clone()
}

fn protocol() -> CheckerProtocol {
    serde_json::from_value(manifest_protocol()).expect("the manifest's protocol no longer parses")
}

#[test]
fn the_shipped_manifest_describes_a_protocol_this_crate_can_execute() {
    // The manifest is data the host executes, so a typo in it is not a compile
    // error anywhere — it is a checker that quietly finds nothing.
    let parsed = protocol();

    assert_eq!(parsed.check.path, "/v2/check");
    assert_eq!(parsed.matches.list, "/matches");
    assert_eq!(parsed.matches.offset, "/offset");
    // The short-text language decision reads this pointer. A manifest that
    // stops declaring detection changes which language a paragraph is checked
    // in, which is not the kind of change that should pass unnoticed.
    let detection = parsed
        .detection
        .expect("the protocol must declare where detection lives");
    assert_eq!(detection.code, "/language/detectedLanguage/code");
    assert_eq!(
        detection.confidence,
        "/language/detectedLanguage/confidence"
    );
    assert!(
        parsed.probe.is_some(),
        "the Check button needs a probe path"
    );
}

#[test]
fn the_declared_pointers_resolve_against_a_real_server() {
    let Ok(endpoint) = std::env::var(ENDPOINT_VAR) else {
        eprintln!("skipped: set {ENDPOINT_VAR} to a LanguageTool instance to run this");
        return;
    };

    let found = tauri::async_runtime::block_on(check(
        CheckInput {
            endpoint: &endpoint,
            api_key: None,
            username: None,
            language: "en-US",
            text: SAMPLE,
            disabled_categories: &[],
            preferred_variants: &[],
        },
        &protocol(),
    ))
    .expect("the server refused the request the manifest describes");

    // Every assertion below is about THEIR reply reaching us intact through
    // the manifest's pointers. A pointer that stopped resolving yields an
    // empty result rather than an error, so "we got findings at all" is the
    // substance of the test.
    assert!(
        !found.is_empty(),
        "a live server found nothing wrong with {SAMPLE:?} — the match pointers have drifted"
    );

    let typo = found
        .iter()
        .find(|m| SAMPLE.get(m.from..m.to) == Some("typpo"))
        .unwrap_or_else(|| panic!("no finding landed on the misspelling: {found:?}"));

    // Offsets are the field most likely to break silently: a range that no
    // longer means "characters into the submitted text" underlines the wrong
    // word rather than failing.
    assert!(typo.to <= SAMPLE.len());
    assert!(
        !typo.message.is_empty(),
        "the message pointer resolved to nothing"
    );
    assert!(
        typo.replacements.iter().any(|r| r == "typo"),
        "no usable replacement came back: {:?}",
        typo.replacements
    );
    assert!(
        !typo.category.is_empty(),
        "the category pointer resolved to nothing, so every finding maps to the default kind"
    );
}
