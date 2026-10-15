//! The page an invite link shows in a browser.
//!
//! A link is an ordinary web address so that it survives being pasted into a
//! chat or an email. A browser is what opens it, on any server's address, so
//! it lands here. From here the app is one click away: the page offers the
//! same link under the app's own scheme, which the operating system hands to
//! the app where it is installed. Where it is not, or the click does
//! nothing, the page says how to paste the link in by hand.
//!
//! The page is the same for every link and never looks one up. The secret
//! sits after the `#`, which the browser keeps to itself, so there is
//! nothing here the server could check, and nothing it should show to
//! whoever has only the address.

use std::sync::OnceLock;

use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue};
use axum::response::{Html, IntoResponse, Response};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use sha2::{Digest, Sha256};

use crate::AppState;

/// The scheme the app is registered for with the operating system. An
/// address under it never leaves the device: no server is asked anything.
/// Written down for every side in `protocol/links`.
const APP_SCHEME: &str = "mindstream-notes";

struct Text {
    lang: &'static str,
    title: &'static str,
    heading: &'static str,
    open: &'static str,
    by_hand: &'static str,
    steps: [&'static str; 3],
    link_label: &'static str,
    copy: &'static str,
    copied: &'static str,
    warning: &'static str,
    get_app: &'static str,
}

const ENGLISH: Text = Text {
    lang: "en",
    title: "Join a shared folder",
    heading: "You have been invited to a shared folder",
    open: "Open in Mindstream Notes",
    by_hand: "If nothing opens, do it by hand:",
    steps: [
        "Open Mindstream Notes.",
        "Right-click an empty spot in the list of notes and choose \"Join shared folder…\".",
        "Paste the link below.",
    ],
    link_label: "Your link",
    copy: "Copy link",
    copied: "Copied",
    warning: "Anyone who has this link can join. Pass it on only to people you trust.",
    get_app: "Get Mindstream Notes",
};

const GERMAN: Text = Text {
    lang: "de",
    title: "Einem geteilten Ordner beitreten",
    heading: "Du wurdest in einen geteilten Ordner eingeladen",
    open: "In Mindstream Notes öffnen",
    by_hand: "Falls sich nichts öffnet, geht es auch von Hand:",
    steps: [
        "Öffne Mindstream Notes.",
        "Klicke in der Notizliste mit der rechten Maustaste auf eine freie Stelle und wähle \"Geteiltem Ordner beitreten…\".",
        "Füge den Link unten ein.",
    ],
    link_label: "Dein Link",
    copy: "Link kopieren",
    copied: "Kopiert",
    warning:
        "Wer diesen Link hat, kann beitreten. Gib ihn nur an Menschen weiter, denen du vertraust.",
    get_app: "Mindstream Notes holen",
};

/// The first language the browser asks for that the page is written in.
fn text_for(accept_language: Option<&str>) -> &'static Text {
    accept_language
        .unwrap_or("")
        .split(',')
        .filter_map(|entry| entry.split(';').next())
        .map(|tag| tag.trim().to_ascii_lowercase())
        .find_map(|tag| match tag.split('-').next() {
            Some("de") => Some(&GERMAN),
            Some("en") => Some(&ENGLISH),
            _ => None,
        })
        .unwrap_or(&ENGLISH)
}

const STYLE: &str = "\
body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:0 1rem;background:#f6f5f2;color:#1d1d1f}\
main{max-width:34rem;margin:10vh auto;padding:2rem;background:#fff;border-radius:12px;\
box-shadow:0 1px 3px rgba(0,0,0,.12)}\
h1{font-size:1.4rem;margin:0 0 1rem}\
ol{padding-left:1.2rem}\
label{display:block;margin-top:1.5rem;font-weight:600}\
input{width:100%;box-sizing:border-box;margin:.4rem 0;padding:.6rem;font:inherit;\
border:1px solid #c8c8cc;border-radius:8px}\
button,a.open{font:inherit;padding:.5rem 1rem;border:0;border-radius:8px;background:#2f6feb;\
color:#fff;cursor:pointer}\
a.open{display:inline-block;text-decoration:none;margin-bottom:1rem}\
a.open[hidden]{display:none}\
p.note{color:#5c5c63;font-size:.9rem}a{color:#1f5fd0}\
@media(prefers-color-scheme:dark){body{background:#17171a;color:#eee}\
main{background:#232327;box-shadow:none}input{background:#17171a;color:#eee;border-color:#44444b}\
p.note{color:#a0a0a8}a{color:#8ab4ff}}";

/// Shows the whole address, secret included, for copying into the app, and
/// points the button that opens the app at the same address under the app's
/// scheme. Without scripts the page still says what to do; the address bar
/// has the same link.
///
/// The address under the app's scheme carries the link, secret and all, as
/// one percent-encoded parameter. The browser hands it to the operating
/// system and to nobody else.
///
/// The clipboard interface is missing on a page served without TLS and may
/// refuse where it exists. The older command is tried then. If that fails
/// too the link stays selected, ready to copy by hand, and the button does
/// not claim otherwise.
const SCRIPT: &str = "\
var field=document.getElementById('link');field.value=location.href;\
var open=document.getElementById('open');\
open.href=open.dataset.scheme+'://join?link='+encodeURIComponent(location.href);open.hidden=false;\
var button=document.getElementById('copy');button.hidden=false;\
function done(){button.textContent=button.dataset.copied;}\
function older(){field.select();if(document.execCommand('copy'))done();}\
button.addEventListener('click',function(){field.select();\
if(navigator.clipboard){navigator.clipboard.writeText(field.value).then(done,older);}\
else{older();}});";

fn hash_source(content: &str) -> String {
    format!("'sha256-{}'", STANDARD.encode(Sha256::digest(content)))
}

/// Allows this page's own style and script and nothing else: no network
/// requests, no frames, no other scripts. The page handles a secret.
fn content_security_policy() -> &'static str {
    static POLICY: OnceLock<String> = OnceLock::new();
    POLICY.get_or_init(|| {
        format!(
            "default-src 'none'; style-src {}; script-src {}; base-uri 'none'; \
             form-action 'none'; frame-ancestors 'none'",
            hash_source(STYLE),
            hash_source(SCRIPT)
        )
    })
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn render(text: &Text, app_url: &str) -> String {
    let steps: String = text
        .steps
        .iter()
        .map(|step| format!("<li>{}</li>", escape(step)))
        .collect();
    format!(
        "<!doctype html><html lang=\"{lang}\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <meta name=\"robots\" content=\"noindex\"><title>{title}</title>\
         <style>{STYLE}</style></head><body><main><h1>{heading}</h1>\
         <a id=\"open\" class=\"open\" data-scheme=\"{APP_SCHEME}\" hidden>{open}</a>\
         <p>{by_hand}</p><ol>{steps}</ol>\
         <label for=\"link\">{link_label}</label><input id=\"link\" readonly>\
         <button id=\"copy\" type=\"button\" data-copied=\"{copied}\" hidden>{copy}</button>\
         <p class=\"note\">{warning}</p>\
         <p><a href=\"{app_url}\" rel=\"noreferrer\">{get_app}</a></p></main>\
         <script>{SCRIPT}</script></body></html>",
        lang = text.lang,
        title = escape(text.title),
        heading = escape(text.heading),
        open = escape(text.open),
        by_hand = escape(text.by_hand),
        link_label = escape(text.link_label),
        copied = escape(text.copied),
        copy = escape(text.copy),
        warning = escape(text.warning),
        app_url = escape(app_url),
        get_app = escape(text.get_app),
    )
}

pub async fn page(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let language = headers
        .get(header::ACCEPT_LANGUAGE)
        .and_then(|value| value.to_str().ok());
    let body = render(text_for(language), state.config.app_url());
    let fixed = |value: &'static str| HeaderValue::from_static(value);
    (
        [
            (
                header::CONTENT_SECURITY_POLICY,
                fixed(content_security_policy()),
            ),
            (header::REFERRER_POLICY, fixed("no-referrer")),
            (header::X_CONTENT_TYPE_OPTIONS, fixed("nosniff")),
            (header::CACHE_CONTROL, fixed("no-store")),
            (header::VARY, fixed("Accept-Language")),
        ],
        Html(body),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_is_written_in_the_first_language_it_has() {
        assert_eq!(text_for(None).lang, "en");
        assert_eq!(text_for(Some("de-DE,de;q=0.9,en;q=0.8")).lang, "de");
        assert_eq!(text_for(Some("fr-FR,de;q=0.7")).lang, "de");
        assert_eq!(text_for(Some("en-GB,de;q=0.7")).lang, "en");
        assert_eq!(text_for(Some("ja")).lang, "en");
    }

    #[test]
    fn nothing_from_configuration_reaches_the_page_as_markup() {
        let page = render(&ENGLISH, "https://example.com/\"><script>alert(1)</script>");
        assert!(!page.contains("<script>alert"));
        assert!(page.contains("&quot;&gt;&lt;script&gt;"));
    }

    /// The app's own menu entry is what the page tells people to look for,
    /// in both languages. These are the words in the app's two bundles.
    #[test]
    fn page_names_the_apps_menu_entry_as_the_app_does() {
        assert!(render(&ENGLISH, "https://example.com").contains("Join shared folder…"));
        assert!(render(&GERMAN, "https://example.com").contains("Geteiltem Ordner beitreten…"));
    }

    /// The button that opens the app is there, hidden until the script has
    /// given it an address, and the script builds that address the way the
    /// app reads it: the link as one encoded parameter under the app's
    /// scheme.
    #[test]
    fn page_offers_the_link_under_the_apps_scheme() {
        let page = render(&ENGLISH, "https://example.com");
        assert!(page.contains(
            "<a id=\"open\" class=\"open\" data-scheme=\"mindstream-notes\" hidden>Open in Mindstream Notes</a>"
        ));
        assert!(SCRIPT
            .contains("open.dataset.scheme+'://join?link='+encodeURIComponent(location.href)"));
        // Without scripts nothing claims to open anything.
        assert!(!page.contains("href=\"mindstream-notes:"));
    }

    /// The app registers a scheme with the operating system and this page
    /// builds addresses under it. Both take the name from one file.
    #[test]
    fn scheme_is_the_one_written_down_for_the_app() {
        let written: serde_json::Value =
            serde_json::from_str(include_str!("../../../protocol/links/invite-links.json"))
                .expect("the invite link file is JSON");
        assert_eq!(written["appScheme"], APP_SCHEME);
    }

    #[test]
    fn policy_allows_the_page_its_own_style_and_script_only() {
        let policy = content_security_policy();
        assert!(policy.starts_with("default-src 'none'"));
        assert!(policy.contains(&hash_source(STYLE)));
        assert!(policy.contains(&hash_source(SCRIPT)));
        assert!(!policy.contains("unsafe"));
        // The hashes cover exactly what the page carries inline.
        let page = render(&GERMAN, "https://example.com");
        assert!(page.contains(&format!("<style>{STYLE}</style>")));
        assert!(page.contains(&format!("<script>{SCRIPT}</script>")));
    }
}
