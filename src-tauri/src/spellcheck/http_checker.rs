//! A checking service the app talks to but does not know.
//!
//! This used to be a LanguageTool client. LanguageTool was then the only
//! service the app could speak to, its name was an entry in a host-owned
//! allow-list, and adding a second one meant editing this file and shipping a
//! release — which a third-party plugin cannot do. Now the plugin describes its
//! service as data and this executes that description.
//!
//! WHAT STAYS HOST-OWNED, and why the plugin only declares a SHAPE: a checker
//! sees the full text of every note the user types in. The host builds the
//! request, holds the connection and returns findings, so a plugin never
//! receives note text and cannot choose where it goes. Declaring the wire
//! format costs none of that.
//!
//! WHY THE REQUEST IS MADE HERE rather than by `fetch` in the WebView, which
//! the CSP would allow. A self-hosted server sends no CORS headers, so a
//! browser request to the common setup is refused before it is sent; Chromium's
//! Private Network Access rules gate page-to-LAN requests besides; and on the
//! platforms where the app is served from a custom scheme treated as secure, a
//! plain-`http://` server is blocked as mixed content. `reqwest` is subject to
//! none of the three. This is not a preference — it is the difference between
//! a self-hosted instance working and not.
//!
//! No `languagetool-rust` dependency: it pulls an entire second HTTP stack for
//! one POST, and we already have `reqwest`.
//!
//! NETWORK BOUNDARY: this is the only part of spellchecking that leaves the
//! machine. The dictionary path never touches the network at check time.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

use crate::error::{AppError, AppResult, CommandResult};

/// One finding, in the shape the frontend's diagnostics bus wants.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckerMatch {
    /// Offsets are relative to the submitted text.
    pub from: usize,
    pub to: usize,
    pub message: String,
    pub replacements: Vec<String>,
    /// The service's own rule category; the caller maps it to a kind.
    pub category: String,
}

/// How the request body carries its fields.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Encoding {
    Form,
    Json,
}

/// Names the host's values take in the request. A field left out is not sent.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestFields {
    pub text: String,
    pub language: Option<String>,
    pub api_key: Option<String>,
    pub username: Option<String>,
    pub preferred_variants: Option<String>,
    pub disabled_categories: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSpec {
    pub path: String,
    pub encoding: Encoding,
    pub fields: RequestFields,
    #[serde(default)]
    pub static_fields: BTreeMap<String, String>,
}

/// Where the findings live in the response, as JSON Pointers.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchSpec {
    pub list: String,
    pub offset: String,
    pub length: Option<String>,
    pub end: Option<String>,
    pub message: String,
    pub replacements: Option<String>,
    pub replacement_value: Option<String>,
    pub category: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionSpec {
    pub code: String,
    pub confidence: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeSpec {
    pub path: String,
    pub list: String,
    pub language_code: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckerProtocol {
    pub trim_endpoint_suffix: Option<String>,
    pub check: RequestSpec,
    pub matches: MatchSpec,
    pub detection: Option<DetectionSpec>,
    pub probe: Option<ProbeSpec>,
}

/// Values the host supplies for a check; the protocol says where they go.
#[derive(Debug, Clone, Default)]
pub struct CheckInput<'a> {
    pub endpoint: &'a str,
    pub api_key: Option<&'a str>,
    pub username: Option<&'a str>,
    pub language: &'a str,
    pub text: &'a str,
    pub disabled_categories: &'a [String],
    pub preferred_variants: &'a [String],
}

/// The user's endpoint, with the declared suffix removed.
///
/// People paste whatever their server's documentation shows, which is often the
/// API root including its version segment — and a trailing slash comes along
/// for free. Both forms would otherwise build `/v2/v2/check`, which 404s and
/// reads as an unreachable server rather than a URL one segment too long.
fn base_url(endpoint: &str, trim_suffix: Option<&str>) -> String {
    let trimmed = endpoint.trim().trim_end_matches('/');
    match trim_suffix {
        Some(suffix) if !suffix.is_empty() => {
            trimmed.strip_suffix(suffix).unwrap_or(trimmed).to_string()
        }
        _ => trimmed.to_string(),
    }
}

/// Below this, auto-detection is not worth believing.
///
/// Measured against a real server: full sentences come back at 0.99, while
/// single words and short fragments land between 0.23 and 0.46 — and at that
/// end it gets them wrong, detecting the German `Sterbeurkunde` as French.
/// Paragraph-at-a-time checking means short segments are the norm, not the
/// exception, so a mis-detected language would spellcheck a German paragraph
/// against a French dictionary.
const MIN_DETECTION_CONFIDENCE: f64 = 0.5;

/// The language value meaning "let the server decide".
const AUTO_LANGUAGE: &str = "auto";

/// Fewer words than this and detection is not asked at all.
///
/// The confidence floor above catches a server that ADMITS it is guessing. It
/// does nothing about the other failure, which is the one users actually hit: a
/// one-word paragraph — a heading, a table cell, a label — detected as the
/// wrong language with high confidence. `Vertragsnummer` alone comes back as
/// English at a confidence the floor happily accepts, and the English speller
/// then flags a perfectly good German compound.
///
/// A word count rather than a character count, because length carries no
/// signal here: `Vertragsnummer` is fourteen characters of exactly one clue.
const MIN_DETECTION_WORDS: usize = 4;

/// True when there is enough text for language detection to mean anything.
fn worth_detecting(text: &str) -> bool {
    text.split_whitespace().count() >= MIN_DETECTION_WORDS
}

/// How many replacements to keep per match.
///
/// A service can return dozens for one match. The popover shows six before
/// collapsing, so carrying more than a couple of screens' worth across IPC for
/// every finding in a document is waste.
const MAX_REPLACEMENTS: usize = 12;

/// Resolve a pointer, treating the empty pointer as the whole document.
fn at<'v>(value: &'v Value, pointer: &str) -> Option<&'v Value> {
    if pointer.is_empty() {
        Some(value)
    } else {
        value.pointer(pointer)
    }
}

fn string_at(value: &Value, pointer: &str) -> Option<String> {
    at(value, pointer)
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

fn usize_at(value: &Value, pointer: &str) -> Option<usize> {
    at(value, pointer)
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
}

/// Turn a response into findings, per the declared pointers.
///
/// A match missing its offset, extent or message is DROPPED rather than
/// defaulted. A finding placed at a guessed position underlines the wrong words,
/// which is worse than the finding never appearing — and silently wrong
/// squiggles are exactly what makes a checker feel broken.
fn into_matches(response: &Value, spec: &MatchSpec) -> Vec<CheckerMatch> {
    let Some(Value::Array(list)) = at(response, &spec.list) else {
        return Vec::new();
    };

    list.iter()
        .filter_map(|item| {
            let from = usize_at(item, &spec.offset)?;
            let to = match (&spec.length, &spec.end) {
                (Some(length), _) => from + usize_at(item, length)?,
                (None, Some(end)) => usize_at(item, end)?,
                (None, None) => return None,
            };
            if to <= from {
                return None;
            }
            Some(CheckerMatch {
                from,
                to,
                message: string_at(item, &spec.message)?,
                replacements: replacements_of(item, spec),
                category: spec
                    .category
                    .as_deref()
                    .and_then(|p| string_at(item, p))
                    .unwrap_or_default(),
            })
        })
        .collect()
}

/// Suggestions for one match — a list of strings, or of objects with the value
/// at a declared pointer inside each.
fn replacements_of(item: &Value, spec: &MatchSpec) -> Vec<String> {
    let Some(pointer) = spec.replacements.as_deref() else {
        return Vec::new();
    };
    let Some(Value::Array(list)) = at(item, pointer) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|entry| match spec.replacement_value.as_deref() {
            Some(inner) => string_at(entry, inner),
            None => entry.as_str().map(str::to_string),
        })
        .take(MAX_REPLACEMENTS)
        .collect()
}

/// Check one span of text against the service the protocol describes.
pub async fn check(
    input: CheckInput<'_>,
    protocol: &CheckerProtocol,
) -> AppResult<Vec<CheckerMatch>> {
    // Too short to detect: name the language outright rather than asking and
    // then second-guessing the answer. Costs one request instead of two, and
    // the result is the same every time the same fragment is checked.
    if input.language == AUTO_LANGUAGE
        && !input.preferred_variants.is_empty()
        && !worth_detecting(input.text)
    {
        let chosen = input.preferred_variants[0].clone();
        let response = check_once(&input, protocol, &chosen, &[]).await?;
        return Ok(into_matches(&response, &protocol.matches));
    }

    let first = check_once(&input, protocol, input.language, input.preferred_variants).await?;

    // Auto-detection is only trusted when it is confident AND landed on a
    // language the user actually writes. Otherwise re-ask, naming the language
    // outright — checking German prose against a French dictionary produces far
    // more nonsense than checking it against the wrong German variant.
    if let Some(detection) = &protocol.detection {
        if input.language == AUTO_LANGUAGE && !input.preferred_variants.is_empty() {
            let code = string_at(&first, &detection.code).unwrap_or_default();
            let confidence = at(&first, &detection.confidence)
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let plausible = confidence >= MIN_DETECTION_CONFIDENCE
                && input
                    .preferred_variants
                    .iter()
                    .any(|tag| same_language(tag, &code));
            if !plausible {
                let fallback = input.preferred_variants[0].clone();
                let retry = check_once(&input, protocol, &fallback, &[]).await?;
                return Ok(into_matches(&retry, &protocol.matches));
            }
        }
    }

    Ok(into_matches(&first, &protocol.matches))
}

/// True when two tags name the same language, ignoring the region.
///
/// `de-DE` and `de-AT` are the same language for this purpose: detection
/// picking the wrong variant is a minor issue, picking the wrong language is
/// not.
fn same_language(a: &str, b: &str) -> bool {
    let base = |tag: &str| tag.split('-').next().unwrap_or("").to_ascii_lowercase();
    !b.is_empty() && base(a) == base(b)
}

/// Assemble the declared fields for one request.
fn build_fields(
    input: &CheckInput<'_>,
    spec: &RequestSpec,
    language: &str,
    preferred_variants: &[String],
) -> Vec<(String, String)> {
    let fields = &spec.fields;
    let mut out: Vec<(String, String)> = vec![(fields.text.clone(), input.text.to_string())];

    if let Some(name) = &fields.language {
        out.push((name.clone(), language.to_string()));
    }
    if let Some(name) = &fields.disabled_categories {
        if !input.disabled_categories.is_empty() {
            out.push((name.clone(), input.disabled_categories.join(",")));
        }
    }
    // Only meaningful alongside automatic selection, and rejected otherwise by
    // at least one real service. Detection on a short paragraph is a coin toss
    // between regional variants, which barely matters for grammar but would
    // mis-spellcheck the whole paragraph — so the languages the user actually
    // selected are passed through to narrow the guess.
    if let Some(name) = &fields.preferred_variants {
        if language == AUTO_LANGUAGE && !preferred_variants.is_empty() {
            out.push((name.clone(), preferred_variants.join(",")));
        }
    }
    // Sent together: the services that want a key generally want an account
    // name with it, and a self-hosted instance usually needs neither.
    if let (Some(key), Some(user)) = (input.api_key, input.username) {
        if let Some(name) = &fields.api_key {
            out.push((name.clone(), key.to_string()));
        }
        if let Some(name) = &fields.username {
            out.push((name.clone(), user.to_string()));
        }
    }
    for (name, value) in &spec.static_fields {
        out.push((name.clone(), value.clone()));
    }
    out
}

async fn check_once(
    input: &CheckInput<'_>,
    protocol: &CheckerProtocol,
    language: &str,
    preferred_variants: &[String],
) -> AppResult<Value> {
    let base = base_url(input.endpoint, protocol.trim_endpoint_suffix.as_deref());
    let url = format!("{base}{}", protocol.check.path);
    let fields = build_fields(input, &protocol.check, language, preferred_variants);

    let request = reqwest::Client::new().post(&url);
    let request = match protocol.check.encoding {
        Encoding::Form => request.form(&fields),
        Encoding::Json => {
            let body: serde_json::Map<String, Value> = fields
                .into_iter()
                .map(|(k, v)| (k, Value::String(v)))
                .collect();
            request.json(&Value::Object(body))
        }
    };

    let response = request
        .send()
        .await
        .map_err(|err| AppError::InvalidArg(format!("checker request failed: {err}")))?;

    let status = response.status();
    if !status.is_success() {
        return Err(AppError::InvalidArg(format!("checker returned {status}")));
    }

    response
        .json()
        .await
        .map_err(|err| AppError::InvalidArg(format!("checker response invalid: {err}")))
}

/// Outcome of a connection test, ready to show the user.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionResult {
    pub ok: bool,
    /// Server-provided detail — a language count on success, the failure reason
    /// otherwise. Not translated: it reports what the server said.
    pub detail: String,
    /// Selected languages this server does NOT offer, as BCP-47 tags.
    ///
    /// The most useful thing a connection test can report for a self-hosted
    /// instance: a container can be perfectly reachable and simply not have the
    /// language you write in, which otherwise shows up as "grammar checking
    /// does nothing" with no explanation.
    pub missing_languages: Vec<String>,
}

/// Text used to verify credentials.
///
/// A FIXED sample, never note content: a connection test must not be a way to
/// send the user's writing somewhere before they have decided the server is one
/// they trust.
///
/// Deliberately meaningless rather than a sentence with a planted mistake. An
/// earlier version relied on a wrong sentence coming back with matches, which
/// assumed rules a self-hosted server may simply not have — n-gram data is a
/// multi-gigabyte optional download, and many instances ship with one language
/// or none. All this needs to establish is that the server ACCEPTS an
/// authenticated request.
const PROBE_TEXT: &str = "test";

/// Check that a service is reachable and, when credentials are supplied, that
/// they work.
///
/// Reachability goes through the declared probe path rather than the check
/// path: it is a plain GET that needs no auth and carries no text at all, so
/// the common case of "is my container up?" sends nothing anywhere. A protocol
/// without a probe can still be tested — it just costs the fixed sample above.
pub async fn test_connection(
    endpoint: &str,
    api_key: Option<&str>,
    username: Option<&str>,
    wanted_languages: &[String],
    protocol: &CheckerProtocol,
) -> TestConnectionResult {
    let base = base_url(endpoint, protocol.trim_endpoint_suffix.as_deref());
    let client = reqwest::Client::new();

    let Some(probe) = &protocol.probe else {
        return probe_with_check(endpoint, api_key, username, protocol).await;
    };

    let offered: Vec<String> = match client.get(format!("{base}{}", probe.path)).send().await {
        Ok(response) if response.status().is_success() => match response.json::<Value>().await {
            Ok(body) => language_codes(&body, probe),
            Err(err) => {
                return TestConnectionResult {
                    ok: false,
                    // Reached something, but not the service — usually a proxy
                    // or the wrong port.
                    detail: format!("not the expected server: {err}"),
                    missing_languages: Vec::new(),
                };
            }
        },
        Ok(response) => {
            return TestConnectionResult {
                ok: false,
                detail: format!("server returned {}", response.status()),
                missing_languages: Vec::new(),
            }
        }
        Err(err) => {
            return TestConnectionResult {
                ok: false,
                detail: format!("{err}"),
                missing_languages: Vec::new(),
            }
        }
    };

    let missing: Vec<String> = wanted_languages
        .iter()
        .filter(|wanted| !offered.iter().any(|have| same_language(wanted, have)))
        .cloned()
        .collect();

    // Only worth a second request when there are credentials to verify; a
    // self-hosted server usually has none.
    if api_key.is_some() && username.is_some() {
        // Probe in a language the server actually offers, so a German-only
        // instance is not failed for lacking English.
        let probe_language = wanted_languages
            .iter()
            .find(|wanted| offered.iter().any(|have| same_language(wanted, have)))
            .cloned()
            .or_else(|| offered.first().cloned())
            .unwrap_or_else(|| "en-US".to_string());

        let input = CheckInput {
            endpoint,
            api_key,
            username,
            language: &probe_language,
            text: PROBE_TEXT,
            disabled_categories: &[],
            preferred_variants: &[],
        };
        if let Err(err) = check_once(&input, protocol, &probe_language, &[]).await {
            return TestConnectionResult {
                ok: false,
                detail: format!("{err}"),
                missing_languages: missing,
            };
        }
    }

    TestConnectionResult {
        ok: true,
        detail: format!("{} languages available", offered.len()),
        missing_languages: missing,
    }
}

/// Fallback reachability test for a protocol that declares no probe path.
async fn probe_with_check(
    endpoint: &str,
    api_key: Option<&str>,
    username: Option<&str>,
    protocol: &CheckerProtocol,
) -> TestConnectionResult {
    let input = CheckInput {
        endpoint,
        api_key,
        username,
        language: AUTO_LANGUAGE,
        text: PROBE_TEXT,
        disabled_categories: &[],
        preferred_variants: &[],
    };
    match check_once(&input, protocol, AUTO_LANGUAGE, &[]).await {
        Ok(_) => TestConnectionResult {
            ok: true,
            detail: "server reachable".to_string(),
            missing_languages: Vec::new(),
        },
        Err(err) => TestConnectionResult {
            ok: false,
            detail: format!("{err}"),
            missing_languages: Vec::new(),
        },
    }
}

/// BCP-47 tags a probe response offers, trying each declared pointer in turn.
fn language_codes(body: &Value, probe: &ProbeSpec) -> Vec<String> {
    let Some(Value::Array(list)) = at(body, &probe.list) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|entry| {
            probe
                .language_code
                .iter()
                .find_map(|pointer| string_at(entry, pointer))
        })
        .collect()
}

#[tauri::command]
pub async fn text_checker_test_connection(
    endpoint: String,
    api_key: Option<String>,
    username: Option<String>,
    wanted_languages: Vec<String>,
    protocol: CheckerProtocol,
) -> CommandResult<TestConnectionResult> {
    Ok(test_connection(
        &endpoint,
        api_key.as_deref(),
        username.as_deref(),
        &wanted_languages,
        &protocol,
    )
    .await)
}

// Tauri injects each call argument individually, so the arg count is the
// command's payload shape rather than something to refactor away.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn text_checker_check(
    endpoint: String,
    api_key: Option<String>,
    username: Option<String>,
    language: String,
    text: String,
    disabled_categories: Vec<String>,
    preferred_variants: Vec<String>,
    protocol: CheckerProtocol,
) -> CommandResult<Vec<CheckerMatch>> {
    Ok(check(
        CheckInput {
            endpoint: &endpoint,
            api_key: api_key.as_deref(),
            username: username.as_deref(),
            language: &language,
            text: &text,
            disabled_categories: &disabled_categories,
            preferred_variants: &preferred_variants,
        },
        &protocol,
    )
    .await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The LanguageTool protocol, exactly as its manifest declares it.
    ///
    /// Loaded as JSON rather than built with struct literals on purpose: these
    /// tests then prove the declaration a real plugin ships actually drives the
    /// generic client, which is the whole claim of this module.
    fn languagetool() -> CheckerProtocol {
        serde_json::from_str(LANGUAGETOOL_JSON).unwrap()
    }

    const LANGUAGETOOL_JSON: &str = r#"{
              "trimEndpointSuffix": "/v2",
              "check": {
                "path": "/v2/check",
                "encoding": "form",
                "fields": {
                  "text": "text",
                  "language": "language",
                  "apiKey": "apiKey",
                  "username": "username",
                  "preferredVariants": "preferredVariants",
                  "disabledCategories": "disabledCategories"
                }
              },
              "matches": {
                "list": "/matches",
                "offset": "/offset",
                "length": "/length",
                "message": "/message",
                "replacements": "/replacements",
                "replacementValue": "/value",
                "category": "/rule/category/id"
              },
              "detection": {
                "code": "/language/detectedLanguage/code",
                "confidence": "/language/detectedLanguage/confidence"
              },
              "probe": {
                "path": "/v2/languages",
                "list": "",
                "languageCode": ["/longCode", "/code"]
              }
            }"#;

    #[test]
    fn the_fixture_is_the_protocol_the_plugin_actually_ships() {
        // "Exactly as its manifest declares it" was a comment, and a comment
        // cannot notice the manifest changing. Every test in this module is
        // only evidence about the real plugin while these two agree.
        let manifest: Value =
            serde_json::from_str(include_str!("../../../plugins/languagetool/manifest.json"))
                .unwrap();
        let shipped = &manifest["contributes"]["textCheckers"][0]["protocol"];

        assert_eq!(
            serde_json::from_str::<Value>(LANGUAGETOOL_JSON).unwrap(),
            *shipped
        );
    }

    fn parse(json: &str) -> Vec<CheckerMatch> {
        let value: Value = serde_json::from_str(json).unwrap();
        into_matches(&value, &languagetool().matches)
    }

    /// A real `/v2/check` response, trimmed to the fields we read.
    fn sample() -> &'static str {
        r#"{"matches":[
            {"message":"Possible spelling mistake found.","offset":4,"length":5,
             "replacements":[{"value":"tests"},{"value":"text"}],
             "rule":{"id":"MORFOLOGIK_RULE","category":{"id":"TYPOS"}}},
            {"message":"Use a comma here.","offset":20,"length":1,
             "replacements":[],
             "rule":{"id":"COMMA_RULE","category":{"id":"PUNCTUATION"}}}
          ]}"#
    }

    #[test]
    fn reads_the_detected_language_and_confidence() {
        // Measured shapes: a full sentence scores 0.99, a single word 0.43 —
        // and at 0.43 the server called the German "Sterbeurkunde" French.
        let json: Value = serde_json::from_str(
            r#"{"matches":[],"language":{"detectedLanguage":{"code":"fr","confidence":0.429}}}"#,
        )
        .unwrap();
        let detection = languagetool().detection.unwrap();
        assert_eq!(string_at(&json, &detection.code).unwrap(), "fr");
        let confidence = at(&json, &detection.confidence)
            .and_then(|v| v.as_f64())
            .unwrap();
        assert!(confidence < MIN_DETECTION_CONFIDENCE);
    }

    #[test]
    fn tolerates_a_response_without_language_information() {
        let json: Value = serde_json::from_str(r#"{"matches":[]}"#).unwrap();
        let detection = languagetool().detection.unwrap();
        assert_eq!(string_at(&json, &detection.code), None);
    }

    #[test]
    fn treats_regional_variants_as_the_same_language() {
        // Detection picking de-AT for de-DE prose is a non-issue; picking
        // French is the failure this guards.
        assert!(same_language("de-DE", "de-AT"));
        assert!(same_language("de-DE", "de"));
        assert!(same_language("en-US", "en-GB"));
        assert!(!same_language("de-DE", "fr"));
        assert!(!same_language("de-DE", ""));
    }

    #[test]
    fn accepts_the_url_forms_people_actually_paste() {
        // A LanguageTool server's own docs show the API root, so `/v2` and a
        // trailing slash are what users copy. Both used to produce
        // `/v2/v2/check`, which 404s and reads as "server unreachable".
        for input in [
            "http://192.168.178.130:8081",
            "http://192.168.178.130:8081/",
            "http://192.168.178.130:8081/v2",
            "http://192.168.178.130:8081/v2/",
            "  http://192.168.178.130:8081/v2/  ",
        ] {
            assert_eq!(
                base_url(input, Some("/v2")),
                "http://192.168.178.130:8081",
                "{input}"
            );
        }
    }

    #[test]
    fn leaves_a_path_prefix_alone() {
        // A server behind a reverse proxy at /languagetool must keep it.
        assert_eq!(
            base_url("https://example.com/languagetool/v2/", Some("/v2")),
            "https://example.com/languagetool"
        );
    }

    #[test]
    fn trims_nothing_when_the_protocol_declares_no_suffix() {
        assert_eq!(
            base_url("https://example.com/api/", None),
            "https://example.com/api"
        );
    }

    #[test]
    fn converts_offset_and_length_into_a_range() {
        // The service reports offset + length; the diagnostics model is a
        // half-open range, and confusing the two shifts every squiggle.
        let out = parse(sample());
        assert_eq!((out[0].from, out[0].to), (4, 9));
        assert_eq!((out[1].from, out[1].to), (20, 21));
    }

    #[test]
    fn reads_an_end_offset_when_the_protocol_declares_one() {
        // The other half of the extent rule: a service that reports where a
        // finding ends rather than how long it is.
        let spec: MatchSpec = serde_json::from_str(
            r#"{"list":"/m","offset":"/start","end":"/stop","message":"/msg"}"#,
        )
        .unwrap();
        let body: Value =
            serde_json::from_str(r#"{"m":[{"start":3,"stop":8,"msg":"x"}]}"#).unwrap();
        let out = into_matches(&body, &spec);
        assert_eq!((out[0].from, out[0].to), (3, 8));
    }

    #[test]
    fn reads_replacements_given_as_plain_strings() {
        // No replacementValue pointer: the entries are the strings themselves.
        let spec: MatchSpec = serde_json::from_str(
            r#"{"list":"/m","offset":"/o","length":"/l","message":"/msg","replacements":"/fix"}"#,
        )
        .unwrap();
        let body: Value =
            serde_json::from_str(r#"{"m":[{"o":0,"l":2,"msg":"x","fix":["aa","bb"]}]}"#).unwrap();
        assert_eq!(into_matches(&body, &spec)[0].replacements, vec!["aa", "bb"]);
    }

    #[test]
    fn flattens_replacements_in_order() {
        assert_eq!(parse(sample())[0].replacements, vec!["tests", "text"]);
    }

    #[test]
    fn keeps_the_category_so_the_caller_can_map_a_kind() {
        let out = parse(sample());
        assert_eq!(out[0].category, "TYPOS");
        assert_eq!(out[1].category, "PUNCTUATION");
    }

    #[test]
    fn tolerates_a_match_with_no_replacements() {
        assert!(parse(sample())[1].replacements.is_empty());
    }

    #[test]
    fn tolerates_a_rule_without_a_category() {
        let json = r#"{"matches":[{"message":"m","offset":0,"length":1,"rule":{"id":"X"}}]}"#;
        assert_eq!(parse(json)[0].category, "");
    }

    #[test]
    fn tolerates_an_empty_result() {
        assert!(parse(r#"{"matches":[]}"#).is_empty());
    }

    #[test]
    fn tolerates_a_response_that_is_not_the_expected_shape() {
        // A proxy or the wrong port answers with something else entirely. No
        // findings is the right answer; panicking on the editor's hot path is
        // not.
        assert!(parse(r#"{"error":"nope"}"#).is_empty());
    }

    #[test]
    fn drops_a_match_that_cannot_be_placed() {
        // A finding with no offset would otherwise be defaulted to position 0
        // and underline the wrong words — worse than not showing it at all.
        let json = r#"{"matches":[{"message":"m","length":1,"rule":{"id":"X"}},
                       {"message":"m2","offset":2,"length":1,"rule":{"id":"X"}}]}"#;
        let out = parse(json);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].message, "m2");
    }

    #[test]
    fn drops_an_empty_range() {
        let json = r#"{"matches":[{"message":"m","offset":5,"length":0,"rule":{"id":"X"}}]}"#;
        assert!(parse(json).is_empty());
    }

    #[test]
    fn caps_replacements() {
        let many: Vec<String> = (0..40).map(|i| format!(r#"{{"value":"{i}"}}"#)).collect();
        let json = format!(
            r#"{{"matches":[{{"message":"m","offset":0,"length":1,"replacements":[{}],"rule":{{"id":"X"}}}}]}}"#,
            many.join(",")
        );
        assert_eq!(parse(&json)[0].replacements.len(), MAX_REPLACEMENTS);
    }

    #[test]
    fn reads_probe_languages_through_either_pointer() {
        let protocol = languagetool();
        let probe = protocol.probe.unwrap();
        let body: Value = serde_json::from_str(
            r#"[{"name":"German","code":"de","longCode":"de-DE"},{"name":"X","code":"xx"}]"#,
        )
        .unwrap();
        // longCode wins where present; code is the fallback.
        assert_eq!(language_codes(&body, &probe), vec!["de-DE", "xx"]);
    }

    #[test]
    fn builds_the_declared_request_fields() {
        let protocol = languagetool();
        let variants = vec!["de-DE".to_string(), "en-US".to_string()];
        let disabled = vec!["TYPOS".to_string()];
        let input = CheckInput {
            endpoint: "http://x",
            api_key: Some("k"),
            username: Some("u"),
            language: AUTO_LANGUAGE,
            text: "hello",
            disabled_categories: &disabled,
            preferred_variants: &variants,
        };
        let fields = build_fields(&input, &protocol.check, AUTO_LANGUAGE, &variants);
        let get = |name: &str| {
            fields
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.clone())
        };
        assert_eq!(get("text").as_deref(), Some("hello"));
        assert_eq!(get("language").as_deref(), Some("auto"));
        assert_eq!(get("disabledCategories").as_deref(), Some("TYPOS"));
        assert_eq!(get("preferredVariants").as_deref(), Some("de-DE,en-US"));
        assert_eq!(get("apiKey").as_deref(), Some("k"));
        assert_eq!(get("username").as_deref(), Some("u"));
    }

    #[test]
    fn omits_preferred_variants_when_a_language_is_named() {
        // Real servers reject the combination, so this is not merely tidy.
        let protocol = languagetool();
        let variants = vec!["de-DE".to_string()];
        let input = CheckInput {
            endpoint: "http://x",
            language: "de-DE",
            text: "hello",
            preferred_variants: &variants,
            ..Default::default()
        };
        let fields = build_fields(&input, &protocol.check, "de-DE", &variants);
        assert!(!fields.iter().any(|(k, _)| k == "preferredVariants"));
    }

    #[test]
    fn omits_credentials_unless_both_are_present() {
        // Self-hosted instances usually have neither, and sending half a
        // credential pair is rejected rather than ignored.
        let protocol = languagetool();
        let input = CheckInput {
            endpoint: "http://x",
            api_key: Some("k"),
            username: None,
            language: "de-DE",
            text: "hello",
            ..Default::default()
        };
        let fields = build_fields(&input, &protocol.check, "de-DE", &[]);
        assert!(!fields.iter().any(|(k, _)| k == "apiKey"));
    }

    #[test]
    fn sends_static_fields_verbatim() {
        let spec: RequestSpec = serde_json::from_str(
            r#"{"path":"/c","encoding":"json","fields":{"text":"t"},
                "staticFields":{"level":"picky"}}"#,
        )
        .unwrap();
        let input = CheckInput {
            endpoint: "http://x",
            text: "hello",
            language: "de",
            ..Default::default()
        };
        let fields = build_fields(&input, &spec, "de", &[]);
        assert!(fields.contains(&("level".to_string(), "picky".to_string())));
        // A protocol that declares no language field simply does not send one.
        assert!(!fields.iter().any(|(k, _)| k == "language"));
    }

    // ---- Against a real socket ------------------------------------------
    //
    // What is left untested by the pure-function tests above is the request
    // itself: the URL it is built from, how its body is encoded, and what
    // happens to a reply that is not the success the happy path assumes. All
    // three are only observable through an actual connection, so these run
    // against a throwaway HTTP server on a loopback port rather than against a
    // stubbed client.

    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc::{self, Receiver};

    /// One canned reply in a server's script.
    struct Reply {
        status: u16,
        body: String,
    }

    fn ok(body: &str) -> Reply {
        Reply {
            status: 200,
            body: body.to_string(),
        }
    }

    /// What a request actually asked for, as the server saw it.
    struct Recorded {
        path: String,
        body: String,
    }

    struct TestServer {
        base: String,
        seen: Receiver<Recorded>,
    }

    impl TestServer {
        fn next(&self) -> Recorded {
            self.seen
                .recv_timeout(std::time::Duration::from_secs(10))
                .expect("expected a request the server never received")
        }

        /// No further request was made — how "did not re-ask" is asserted.
        fn is_done(&self) -> bool {
            self.seen
                .recv_timeout(std::time::Duration::from_millis(200))
                .is_err()
        }
    }

    /// Serve `replies` in order, one per connection, recording each request.
    fn serve(replies: Vec<Reply>) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (tx, seen) = mpsc::channel();

        std::thread::spawn(move || {
            for reply in replies {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let recorded = read_request(&mut stream);
                let _ = tx.send(recorded);
                let response = format!(
                    "HTTP/1.1 {} STATUS\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    reply.status,
                    reply.body.len(),
                    reply.body
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });

        TestServer { base, seen }
    }

    fn read_request(stream: &mut TcpStream) -> Recorded {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut request_line = String::new();
        reader.read_line(&mut request_line).unwrap();
        let path = request_line
            .split_whitespace()
            .nth(1)
            .unwrap_or("")
            .to_string();

        let mut length = 0usize;
        loop {
            let mut header = String::new();
            reader.read_line(&mut header).unwrap();
            if header.trim().is_empty() {
                break;
            }
            if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:") {
                length = value.trim().parse().unwrap_or(0);
            }
        }

        let mut body = vec![0u8; length];
        if length > 0 {
            reader.read_exact(&mut body).unwrap();
        }
        Recorded {
            path,
            body: String::from_utf8_lossy(&body).to_string(),
        }
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tauri::async_runtime::block_on(future)
    }

    /// An endpoint nothing is listening on, for the unreachable-server cases.
    fn dead_endpoint() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        format!("http://{address}")
    }

    fn input<'a>(endpoint: &'a str, language: &'a str) -> CheckInput<'a> {
        CheckInput {
            endpoint,
            api_key: None,
            username: None,
            language,
            text: "Dies ist ein Satzz.",
            disabled_categories: &[],
            preferred_variants: &[],
        }
    }

    #[test]
    fn posts_to_the_declared_path_and_returns_the_findings() {
        let server = serve(vec![ok(sample())]);
        let found = block_on(check(input(&server.base, "de-DE"), &languagetool())).unwrap();

        let request = server.next();
        assert_eq!(request.path, "/v2/check");
        // Form-encoded, as the protocol declares.
        assert!(
            request.body.contains("text=Dies+ist+ein+Satzz."),
            "{}",
            request.body
        );
        assert!(request.body.contains("language=de-DE"), "{}", request.body);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].from, 4);
    }

    #[test]
    fn sends_a_json_body_when_the_protocol_declares_json() {
        let mut protocol = languagetool();
        protocol.check.encoding = Encoding::Json;
        let server = serve(vec![ok(r#"{"matches":[]}"#)]);

        block_on(check(input(&server.base, "de-DE"), &protocol)).unwrap();

        let body: Value = serde_json::from_str(&server.next().body).unwrap();
        assert_eq!(body["text"], "Dies ist ein Satzz.");
        assert_eq!(body["language"], "de-DE");
    }

    #[test]
    fn reports_an_unsuccessful_status_rather_than_an_empty_result() {
        // Silently returning no findings would read as "your text is fine".
        let server = serve(vec![Reply {
            status: 500,
            body: "boom".to_string(),
        }]);
        let err = block_on(check(input(&server.base, "de-DE"), &languagetool())).unwrap_err();
        assert!(format!("{err}").contains("500"), "{err}");
    }

    #[test]
    fn reports_a_reply_that_is_not_json() {
        let server = serve(vec![ok("<html>not a checker</html>")]);
        let err = block_on(check(input(&server.base, "de-DE"), &languagetool())).unwrap_err();
        assert!(format!("{err}").contains("invalid"), "{err}");
    }

    #[test]
    fn reports_an_unreachable_server() {
        let endpoint = dead_endpoint();
        let err = block_on(check(input(&endpoint, "de-DE"), &languagetool())).unwrap_err();
        assert!(format!("{err}").contains("request failed"), "{err}");
    }

    #[test]
    fn believes_confident_detection_of_a_language_the_user_writes() {
        let server = serve(vec![ok(
            r#"{"matches":[{"message":"m","offset":0,"length":3}],
                "language":{"detectedLanguage":{"code":"de","confidence":0.99}}}"#,
        )]);
        let variants = vec!["de-DE".to_string()];
        let mut request = input(&server.base, AUTO_LANGUAGE);
        request.preferred_variants = &variants;

        let found = block_on(check(request, &languagetool())).unwrap();

        server.next();
        assert!(server.is_done(), "a believable detection must not re-ask");
        assert_eq!(found.len(), 1);
    }

    #[test]
    fn never_asks_for_detection_on_a_one_word_paragraph() {
        // The reported bug: `Vertragsnummer` on its own is detected as English
        // with high confidence, so the confidence floor lets it through and a
        // correct German compound comes back underlined.
        let server = serve(vec![ok(r#"{"matches":[]}"#)]);
        let variants = vec!["de-DE".to_string(), "en-US".to_string()];
        let mut request = input(&server.base, AUTO_LANGUAGE);
        request.text = "Vertragsnummer";
        request.preferred_variants = &variants;

        block_on(check(request, &languagetool())).unwrap();

        let only = server.next();
        assert!(only.body.contains("language=de-DE"), "{}", only.body);
        // Named outright, so there is nothing for the server to guess at.
        assert!(!only.body.contains("preferredVariants"), "{}", only.body);
        assert!(server.is_done(), "the short path must cost one request");
    }

    #[test]
    fn still_detects_when_there_is_enough_text_to_go_on() {
        let server = serve(vec![ok(
            r#"{"matches":[],"language":{"detectedLanguage":{"code":"en","confidence":0.99}}}"#,
        )]);
        let variants = vec!["de-DE".to_string(), "en-US".to_string()];
        let mut request = input(&server.base, AUTO_LANGUAGE);
        request.text = "This is an English sentence.";
        request.preferred_variants = &variants;

        block_on(check(request, &languagetool())).unwrap();

        assert!(server.next().body.contains("language=auto"));
        assert!(server.is_done(), "a believable detection must not re-ask");
    }

    #[test]
    fn the_first_preferred_variant_is_the_one_short_text_gets() {
        // The order of the user's selected languages decides this, so it is a
        // contract with the frontend and not an implementation detail: the
        // same fragment checks as English here and as German in the test above.
        let server = serve(vec![ok(r#"{"matches":[]}"#)]);
        let variants = vec!["en-US".to_string(), "de-DE".to_string()];
        let mut request = input(&server.base, AUTO_LANGUAGE);
        request.text = "Vertragsnummer";
        request.preferred_variants = &variants;

        block_on(check(request, &languagetool())).unwrap();

        assert!(server.next().body.contains("language=en-US"));
    }

    #[test]
    fn asks_anyway_when_short_text_has_no_variants_to_fall_back_on() {
        // Nothing to name the language with, so the server's guess is still
        // better than refusing to check. Also the indexing guard: variants[0]
        // must never be reached on an empty list.
        let server = serve(vec![ok(r#"{"matches":[]}"#)]);
        let mut request = input(&server.base, AUTO_LANGUAGE);
        request.text = "Vertragsnummer";

        block_on(check(request, &languagetool())).unwrap();

        assert!(server.next().body.contains("language=auto"));
        assert!(server.is_done());
    }

    #[test]
    fn leaves_an_explicitly_named_language_alone_on_short_text() {
        // One selected language means the frontend names it rather than
        // sending `auto`, and there is nothing here to second-guess.
        let server = serve(vec![ok(r#"{"matches":[]}"#)]);
        let mut request = input(&server.base, "de-DE");
        request.text = "Vertragsnummer";

        block_on(check(request, &languagetool())).unwrap();

        assert!(server.next().body.contains("language=de-DE"));
        assert!(server.is_done());
    }

    #[test]
    fn names_the_language_for_short_text_even_without_a_detection_spec() {
        // A protocol that declares no detection gives us no way to notice a
        // wrong guess afterwards, which is a reason to guess less, not more.
        let mut protocol = languagetool();
        protocol.detection = None;
        let server = serve(vec![ok(r#"{"matches":[]}"#)]);
        let variants = vec!["de-DE".to_string()];
        let mut request = input(&server.base, AUTO_LANGUAGE);
        request.text = "Vertragsnummer";
        request.preferred_variants = &variants;

        block_on(check(request, &protocol)).unwrap();

        assert!(server.next().body.contains("language=de-DE"));
    }

    #[test]
    fn counts_words_rather_than_characters_for_detection() {
        // Length carries no signal: one long compound is still one clue, and
        // four short words are enough to tell German from English.
        assert!(!worth_detecting("Vertragsnummer"));
        assert!(!worth_detecting("  Nr. 4 \n"));
        assert!(!worth_detecting(""));
        assert!(!worth_detecting("Dies ist kurz"));
        assert!(worth_detecting("Dies ist ein Satz."));
        assert!(worth_detecting("a b c d"));
    }

    #[test]
    fn re_asks_by_name_when_detection_lands_outside_what_the_user_writes() {
        // The failure this exists to stop: German prose checked against French.
        let server = serve(vec![
            ok(r#"{"matches":[],"language":{"detectedLanguage":{"code":"fr","confidence":0.99}}}"#),
            ok(r#"{"matches":[{"message":"m","offset":0,"length":3}]}"#),
        ]);
        let variants = vec!["de-DE".to_string()];
        let mut request = input(&server.base, AUTO_LANGUAGE);
        request.preferred_variants = &variants;

        let found = block_on(check(request, &languagetool())).unwrap();

        server.next();
        let retry = server.next();
        assert!(retry.body.contains("language=de-DE"), "{}", retry.body);
        // The re-ask names the language, so variants are no longer sent.
        assert!(!retry.body.contains("preferredVariants"), "{}", retry.body);
        assert_eq!(found.len(), 1);
    }

    #[test]
    fn re_asks_by_name_when_detection_is_not_confident() {
        let server = serve(vec![
            ok(r#"{"matches":[],"language":{"detectedLanguage":{"code":"de","confidence":0.43}}}"#),
            ok(r#"{"matches":[]}"#),
        ]);
        let variants = vec!["de-DE".to_string(), "en-US".to_string()];
        let mut request = input(&server.base, AUTO_LANGUAGE);
        request.preferred_variants = &variants;

        block_on(check(request, &languagetool())).unwrap();

        let first = server.next();
        assert!(
            first.body.contains("preferredVariants=de-DE%2Cen-US"),
            "{}",
            first.body
        );
        assert!(server.next().body.contains("language=de-DE"));
    }

    #[test]
    fn test_connection_counts_the_languages_a_server_offers() {
        let server = serve(vec![ok(
            r#"[{"longCode":"de-DE","code":"de"},{"longCode":"en-US","code":"en"}]"#,
        )]);

        let result = block_on(test_connection(
            &server.base,
            None,
            None,
            &["de-DE".to_string()],
            &languagetool(),
        ));

        assert_eq!(server.next().path, "/v2/languages");
        assert!(result.ok);
        assert!(result.detail.contains('2'), "{}", result.detail);
        assert!(result.missing_languages.is_empty());
    }

    #[test]
    fn test_connection_names_the_languages_the_server_lacks() {
        // A reachable container that simply lacks the language you write in is
        // the most useful thing this test can report.
        let server = serve(vec![ok(r#"[{"longCode":"en-US","code":"en"}]"#)]);

        let result = block_on(test_connection(
            &server.base,
            None,
            None,
            &["de-DE".to_string(), "en-GB".to_string()],
            &languagetool(),
        ));

        assert!(result.ok);
        assert_eq!(result.missing_languages, vec!["de-DE".to_string()]);
    }

    #[test]
    fn test_connection_reports_an_unsuccessful_probe() {
        let server = serve(vec![Reply {
            status: 404,
            body: "nope".to_string(),
        }]);

        let result = block_on(test_connection(
            &server.base,
            None,
            None,
            &[],
            &languagetool(),
        ));

        assert!(!result.ok);
        assert!(result.detail.contains("404"), "{}", result.detail);
    }

    #[test]
    fn test_connection_reports_reaching_something_that_is_not_the_service() {
        // Usually a proxy or the wrong port.
        let server = serve(vec![ok("<html>hello</html>")]);

        let result = block_on(test_connection(
            &server.base,
            None,
            None,
            &[],
            &languagetool(),
        ));

        assert!(!result.ok);
        assert!(
            result.detail.contains("not the expected server"),
            "{}",
            result.detail
        );
    }

    #[test]
    fn test_connection_reports_an_unreachable_server() {
        let result = block_on(test_connection(
            &dead_endpoint(),
            None,
            None,
            &[],
            &languagetool(),
        ));
        assert!(!result.ok);
        assert!(!result.detail.is_empty());
    }

    #[test]
    fn test_connection_verifies_credentials_in_a_language_the_server_offers() {
        let server = serve(vec![
            ok(r#"[{"longCode":"de-DE","code":"de"}]"#),
            ok(r#"{"matches":[]}"#),
        ]);

        let result = block_on(test_connection(
            &server.base,
            Some("key"),
            Some("user"),
            &["de-DE".to_string()],
            &languagetool(),
        ));

        server.next();
        let verify = server.next();
        assert_eq!(verify.path, "/v2/check");
        assert!(verify.body.contains("language=de-DE"), "{}", verify.body);
        // A fixed probe string — never the user's writing.
        assert!(verify.body.contains("text=test"), "{}", verify.body);
        assert!(verify.body.contains("apiKey=key"), "{}", verify.body);
        assert!(result.ok);
    }

    #[test]
    fn test_connection_fails_when_the_credentials_are_refused() {
        let server = serve(vec![
            ok(r#"[{"longCode":"de-DE","code":"de"}]"#),
            Reply {
                status: 403,
                body: "denied".to_string(),
            },
        ]);

        let result = block_on(test_connection(
            &server.base,
            Some("key"),
            Some("user"),
            &["de-DE".to_string()],
            &languagetool(),
        ));

        assert!(!result.ok);
        assert!(result.detail.contains("403"), "{}", result.detail);
    }

    #[test]
    fn test_connection_skips_the_probe_when_no_credentials_are_supplied() {
        let server = serve(vec![ok(r#"[{"longCode":"de-DE","code":"de"}]"#)]);

        let result = block_on(test_connection(
            &server.base,
            None,
            Some("user"),
            &[],
            &languagetool(),
        ));

        server.next();
        assert!(
            server.is_done(),
            "a key-less server needs no second request"
        );
        assert!(result.ok);
    }

    #[test]
    fn falls_back_to_the_check_path_when_no_probe_is_declared() {
        let mut protocol = languagetool();
        protocol.probe = None;
        let server = serve(vec![ok(r#"{"matches":[]}"#)]);

        let result = block_on(test_connection(&server.base, None, None, &[], &protocol));

        let request = server.next();
        assert_eq!(request.path, "/v2/check");
        assert!(request.body.contains("text=test"), "{}", request.body);
        assert!(result.ok);
        assert_eq!(result.detail, "server reachable");
    }

    #[test]
    fn reports_a_failure_from_the_check_path_fallback() {
        let mut protocol = languagetool();
        protocol.probe = None;

        let result = block_on(test_connection(
            &dead_endpoint(),
            None,
            None,
            &[],
            &protocol,
        ));

        assert!(!result.ok);
        assert!(
            result.detail.contains("request failed"),
            "{}",
            result.detail
        );
    }

    #[test]
    fn the_check_command_carries_its_arguments_through() {
        // The command layer is a shape conversion — owned strings in, borrowed
        // ones out — and getting it wrong drops a field silently.
        let server = serve(vec![ok(sample())]);

        let found = block_on(text_checker_check(
            server.base.clone(),
            Some("key".into()),
            Some("user".into()),
            "de-DE".into(),
            "Ein Satzz.".into(),
            vec!["WHITESPACE".into()],
            vec![],
            languagetool(),
        ))
        .unwrap();

        let request = server.next();
        assert!(request.body.contains("apiKey=key"), "{}", request.body);
        assert!(request.body.contains("username=user"), "{}", request.body);
        assert!(
            request.body.contains("disabledCategories=WHITESPACE"),
            "{}",
            request.body
        );
        assert_eq!(found.len(), 2);
    }

    #[test]
    fn the_test_connection_command_carries_its_arguments_through() {
        let server = serve(vec![ok(r#"[{"longCode":"de-DE","code":"de"}]"#)]);

        let result = block_on(text_checker_test_connection(
            server.base.clone(),
            None,
            None,
            vec!["en-US".into()],
            languagetool(),
        ))
        .unwrap();

        assert_eq!(server.next().path, "/v2/languages");
        assert!(result.ok);
        assert_eq!(result.missing_languages, vec!["en-US".to_string()]);
    }
}
