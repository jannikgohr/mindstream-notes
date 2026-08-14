//! LanguageTool client.
//!
//! Grammar and style checking over LanguageTool's `/v2/check` API, against
//! either a self-hosted server or the public one.
//!
//! WHY THIS LIVES IN THE BACKEND, not in the plugin: a checker sees the full
//! text of every note the user types in. Routing it through Rust means the
//! endpoint and API key are host-controlled, the request is one auditable
//! place, and a plugin cannot quietly redirect note content somewhere else.
//! The plugin only declares that the checker exists and which settings hold
//! its configuration.
//!
//! No `languagetool-rust` dependency: it pulls an entire second HTTP stack
//! for one POST, and we already have `reqwest`. Calling the endpoint
//! directly also keeps the request shape under our control.
//!
//! NETWORK BOUNDARY: this is the only part of spellchecking that leaves the
//! machine. The dictionary path never touches the network at check time.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult, CommandResult};

/// One finding, in the shape the frontend's diagnostics bus wants.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageToolMatch {
    /// Offsets are relative to the submitted text.
    pub from: usize,
    pub to: usize,
    pub message: String,
    pub replacements: Vec<String>,
    /// LanguageTool's category id; the caller maps it to a diagnostic kind.
    pub category: String,
}

#[derive(Debug, Deserialize)]
struct CheckResponse {
    matches: Vec<Match>,
}

#[derive(Debug, Deserialize)]
struct Match {
    offset: usize,
    length: usize,
    message: String,
    #[serde(default)]
    replacements: Vec<Replacement>,
    rule: Rule,
}

#[derive(Debug, Deserialize)]
struct Replacement {
    value: String,
}

#[derive(Debug, Deserialize)]
struct Rule {
    #[serde(default)]
    category: Category,
}

#[derive(Debug, Default, Deserialize)]
struct Category {
    #[serde(default)]
    id: String,
}

/// Reduce a user-entered server URL to its base.
///
/// People paste what their server's docs show them, which is usually the API
/// root including `/v2` — and a trailing slash comes along for free. Both
/// forms then produce `/v2/v2/check`, which 404s and looks like an
/// unreachable server rather than a URL that needs one path segment removed.
/// Accept every reasonable spelling instead of making the user guess.
fn base_url(endpoint: &str) -> String {
    let trimmed = endpoint.trim().trim_end_matches('/');
    trimmed.strip_suffix("/v2").unwrap_or(trimmed).to_string()
}

/// How many replacements to keep per match.
///
/// LanguageTool can return dozens for one match. The popover shows six
/// before collapsing, so carrying more than a couple of screens' worth
/// across IPC for every finding in a document is waste.
const MAX_REPLACEMENTS: usize = 12;

fn into_matches(parsed: CheckResponse) -> Vec<LanguageToolMatch> {
    parsed
        .matches
        .into_iter()
        .map(|m| LanguageToolMatch {
            from: m.offset,
            to: m.offset + m.length,
            message: m.message,
            replacements: m
                .replacements
                .into_iter()
                .map(|r| r.value)
                .take(MAX_REPLACEMENTS)
                .collect(),
            category: m.rule.category.id,
        })
        .collect()
}

/// Check one segment of text.
///
/// `language` is a BCP-47 tag or `auto`. Auto-detection is the sensible
/// default here: it matches the rest of the feature, where the user selects
/// languages rather than tagging each paragraph.
pub async fn check(
    endpoint: &str,
    api_key: Option<&str>,
    username: Option<&str>,
    language: &str,
    text: &str,
    disabled_categories: &[String],
) -> AppResult<Vec<LanguageToolMatch>> {
    let url = format!("{}/v2/check", base_url(endpoint));

    let mut form: Vec<(String, String)> = vec![
        ("text".into(), text.to_string()),
        ("language".into(), language.to_string()),
    ];
    if !disabled_categories.is_empty() {
        form.push(("disabledCategories".into(), disabled_categories.join(",")));
    }
    // The public API authenticates with username and key together; a
    // self-hosted server usually needs neither.
    if let (Some(key), Some(user)) = (api_key, username) {
        form.push(("apiKey".into(), key.to_string()));
        form.push(("username".into(), user.to_string()));
    }

    let response = reqwest::Client::new()
        .post(&url)
        .form(&form)
        .send()
        .await
        .map_err(|err| AppError::InvalidArg(format!("LanguageTool request failed: {err}")))?;

    let status = response.status();
    if !status.is_success() {
        return Err(AppError::InvalidArg(format!(
            "LanguageTool returned {status}"
        )));
    }

    let parsed: CheckResponse = response
        .json()
        .await
        .map_err(|err| AppError::InvalidArg(format!("LanguageTool response invalid: {err}")))?;

    Ok(into_matches(parsed))
}

/// Outcome of a connection test, ready to show the user.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionResult {
    pub ok: bool,
    /// Server-provided detail — a language count on success, the failure
    /// reason otherwise. Not translated: it reports what the server said.
    pub detail: String,
}

/// Text used to verify credentials.
///
/// A FIXED sample, never note content: a connection test must not be a way
/// to send the user's writing somewhere before they have decided the server
/// is one they trust. It is deliberately ungrammatical, so a successful
/// check also proves the server is actually returning matches rather than
/// just answering.
const PROBE_TEXT: &str = "This are a test.";

/// Check that a LanguageTool server is reachable and, when credentials are
/// supplied, that they work.
///
/// Reachability goes through `/v2/languages` rather than `/v2/check`: it is
/// a plain GET that needs no auth and carries no text at all, so the common
/// case of "is my container up?" sends nothing anywhere.
pub async fn test_connection(
    endpoint: &str,
    api_key: Option<&str>,
    username: Option<&str>,
) -> TestConnectionResult {
    let base = base_url(endpoint);
    let client = reqwest::Client::new();

    let languages = match client.get(format!("{base}/v2/languages")).send().await {
        Ok(response) if response.status().is_success() => {
            match response.json::<Vec<serde_json::Value>>().await {
                Ok(list) => list.len(),
                Err(err) => {
                    return TestConnectionResult {
                        ok: false,
                        // Reached something, but not LanguageTool — usually a
                        // proxy or the wrong port.
                        detail: format!("not a LanguageTool server: {err}"),
                    };
                }
            }
        }
        Ok(response) => {
            return TestConnectionResult {
                ok: false,
                detail: format!("server returned {}", response.status()),
            }
        }
        Err(err) => {
            return TestConnectionResult {
                ok: false,
                detail: format!("{err}"),
            }
        }
    };

    // Only worth a second request when there are credentials to verify;
    // a self-hosted server usually has none.
    if api_key.is_some() && username.is_some() {
        if let Err(err) = check(endpoint, api_key, username, "en-US", PROBE_TEXT, &[]).await {
            return TestConnectionResult {
                ok: false,
                detail: format!("credentials rejected: {err}"),
            };
        }
    }

    TestConnectionResult {
        ok: true,
        detail: format!("{languages} languages available"),
    }
}

#[tauri::command]
pub async fn languagetool_test_connection(
    endpoint: String,
    api_key: Option<String>,
    username: Option<String>,
) -> CommandResult<TestConnectionResult> {
    Ok(test_connection(&endpoint, api_key.as_deref(), username.as_deref()).await)
}

#[tauri::command]
pub async fn languagetool_check(
    endpoint: String,
    api_key: Option<String>,
    username: Option<String>,
    language: String,
    text: String,
    disabled_categories: Vec<String>,
) -> CommandResult<Vec<LanguageToolMatch>> {
    Ok(check(
        &endpoint,
        api_key.as_deref(),
        username.as_deref(),
        &language,
        &text,
        &disabled_categories,
    )
    .await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Vec<LanguageToolMatch> {
        into_matches(serde_json::from_str(json).unwrap())
    }

    /// A real `/v2/check` response, trimmed to the fields we read.
    fn sample() -> &'static str {
        concat!(
            r#"{"matches":[
              {"message":"Possible spelling mistake found.","offset":4,"length":5,
               "replacements":[{"value":"tests"},{"value":"text"}],
               "rule":{"id":"MORFOLOGIK_RULE","category":{"id":"TYPOS"}}},
              {"message":"Use a comma here.","offset":20,"length":1,
               "replacements":[],
               "rule":{"id":"COMMA_RULE","category":{"id":"PUNCTUATION"}}}
            ]}"#
        )
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
            assert_eq!(base_url(input), "http://192.168.178.130:8081", "{input}");
        }
    }

    #[test]
    fn leaves_a_path_prefix_alone() {
        // A server behind a reverse proxy at /languagetool must keep it.
        assert_eq!(
            base_url("https://example.com/languagetool/v2/"),
            "https://example.com/languagetool"
        );
    }

    #[test]
    fn converts_offset_and_length_into_a_range() {
        // LanguageTool reports offset + length; the diagnostics model is a
        // half-open range, and confusing the two shifts every squiggle.
        let out = parse(sample());
        assert_eq!((out[0].from, out[0].to), (4, 9));
        assert_eq!((out[1].from, out[1].to), (20, 21));
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
    fn caps_replacements() {
        let many: Vec<String> = (0..40).map(|i| format!(r#"{{"value":"{i}"}}"#)).collect();
        let json = format!(
            r#"{{"matches":[{{"message":"m","offset":0,"length":1,"replacements":[{}],"rule":{{"id":"X"}}}}]}}"#,
            many.join(",")
        );
        assert_eq!(parse(&json)[0].replacements.len(), MAX_REPLACEMENTS);
    }
}
