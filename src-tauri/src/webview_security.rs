//! Per-document network policy for the signed-in account and local previews.

use std::borrow::Cow;

use tauri::http::{header, HeaderValue, Response};

/// Use parsed origins, never raw settings, in a CSP source list. Subpath
/// installs share the same origin; credentials and URL queries are excluded.
fn account_sources(server_url: &str) -> Option<String> {
    let url = reqwest::Url::parse(server_url).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url.host_str()?;
    if !host.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b':' | b'[' | b']')
    }) {
        return None;
    }
    let origin = url.origin().ascii_serialization();
    let socket_origin = if let Some(host) = origin.strip_prefix("https://") {
        format!("wss://{host}")
    } else {
        format!("ws://{}", origin.strip_prefix("http://")?)
    };
    Some(format!("{origin} {socket_origin}"))
}

fn with_account_sources(
    policy: &str,
    server_url: Option<&str>,
    preview_port: Option<u16>,
) -> String {
    let sources = server_url.and_then(account_sources);
    policy
        .split(';')
        .map(|directive| {
            let directive = directive.trim();
            if directive.split_whitespace().next() == Some("connect-src") {
                let directive = match preview_port {
                    Some(port) => {
                        format!("{directive} http://127.0.0.1:{port} ws://127.0.0.1:{port}")
                    }
                    None => directive.to_string(),
                };
                match &sources {
                    Some(sources) => format!("{directive} {sources}"),
                    None => directive.to_string(),
                }
            } else if directive.split_whitespace().next() == Some("frame-src") {
                match preview_port {
                    Some(port) => format!("{directive} http://127.0.0.1:{port}"),
                    None => directive.to_string(),
                }
            } else {
                directive.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// Tauri has already added its script hashes and IPC sources to this header.
/// Extend only connect-src so those generated protections survive unchanged.
pub fn apply_account_policy(
    response: &mut Response<Cow<'static, [u8]>>,
    server_url: Option<&str>,
    preview_port: Option<u16>,
) {
    let Some(policy) = response
        .headers()
        .get(header::CONTENT_SECURITY_POLICY)
        .and_then(|value| value.to_str().ok())
    else {
        return;
    };
    let updated = with_account_sources(policy, server_url, preview_port);
    if let Ok(value) = HeaderValue::from_str(&updated) {
        response
            .headers_mut()
            .insert(header::CONTENT_SECURITY_POLICY, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configured_policy() -> String {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        config["app"]["security"]["csp"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn packaged_policy_has_no_unrestricted_network_schemes() {
        let policy = configured_policy();
        let connect = policy
            .split(';')
            .find(|part| part.trim().starts_with("connect-src "))
            .unwrap();
        for source in ["http:", "https:", "ws:", "wss:", "*"] {
            assert!(
                !connect.split_whitespace().any(|part| part == source),
                "{connect}"
            );
        }
    }

    #[test]
    fn configured_accounts_keep_http_polling_and_websocket_origins() {
        for (url, expected) in [
            (
                "https://notes.example.test/custom/base?x=1",
                "https://notes.example.test wss://notes.example.test",
            ),
            (
                "http://my-server:8080/base",
                "http://my-server:8080 ws://my-server:8080",
            ),
            ("http://[::1]:8080/", "http://[::1]:8080 ws://[::1]:8080"),
            (
                "https://user:password@example.test/",
                "https://example.test wss://example.test",
            ),
        ] {
            assert_eq!(account_sources(url).as_deref(), Some(expected));
        }
        for url in [
            "https://*.example.test",
            "https://evil.test;script-src/",
            "file:///tmp/x",
            "data:text/plain,x",
            "invalid",
        ] {
            assert!(account_sources(url).is_none(), "{url}");
        }
    }

    #[test]
    fn each_new_document_uses_only_its_current_account() {
        let policy = configured_policy();
        let first = with_account_sources(&policy, Some("https://one.example"), None);
        let second = with_account_sources(&policy, Some("https://two.example"), None);
        let signed_out = with_account_sources(&policy, None, None);
        assert!(first.contains("https://one.example wss://one.example"));
        assert!(second.contains("https://two.example wss://two.example"));
        assert!(!second.contains("one.example"));
        assert!(!signed_out.contains("one.example"));
        assert!(!signed_out.contains("two.example"));
    }

    #[test]
    fn resource_handler_preserves_script_hashes_and_non_connect_directives() {
        let policy = "script-src 'self' 'sha256-test'; connect-src 'self' ipc:; frame-src 'self'; object-src 'none'";
        let mut response = Response::builder()
            .header(header::CONTENT_SECURITY_POLICY, policy)
            .body(Cow::Borrowed(&b"page"[..]))
            .unwrap();
        apply_account_policy(&mut response, Some("https://notes.example.test"), None);
        assert_eq!(response.headers()[header::CONTENT_SECURITY_POLICY], "script-src 'self' 'sha256-test'; connect-src 'self' ipc: https://notes.example.test wss://notes.example.test; frame-src 'self'; object-src 'none'");
        assert_eq!(response.body().as_ref(), b"page");
    }
}
