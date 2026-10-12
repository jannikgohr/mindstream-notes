//! The server's own front door: the limit on sign-in attempts and the route
//! a client reads to learn what it is talking to.

mod common;

use std::io::{Read, Write};

use etebase::error::Error;
use etebase::{Account, User};

fn try_signup(url: &str) -> Result<Account, Error> {
    etebase::init().unwrap();
    let name = common::username("guess");
    let user = User::new(&name, "guess@test.local");
    Account::signup_key(common::client(url), &user, &[1u8; 32])
}

#[test]
fn sign_in_attempts_are_limited_per_address() {
    let url = common::start_server(|config| {
        config.auth_rate_per_minute = 1;
        config.auth_rate_burst = 3;
    });

    let first = try_signup(&url).expect("first attempt");
    try_signup(&url).expect("second attempt");
    try_signup(&url).expect("third attempt");
    match try_signup(&url) {
        Err(Error::Http(message)) => {
            assert!(message.contains("429"), "{message}");
            assert!(message.contains("throttled"), "{message}");
        }
        Err(other) => panic!("refused, but with {other:?}"),
        Ok(_) => panic!("a fourth attempt in a row was let through"),
    }

    // The limit is on signing in, not on using a session already held.
    first
        .collection_manager()
        .unwrap()
        .list("any", None)
        .unwrap();
}

/// A bare HTTP GET, since the info route is JSON and the client library only
/// speaks msgpack.
fn http_get(url: &str, path: &str) -> String {
    let address = url.trim_start_matches("http://");
    let mut stream = std::net::TcpStream::connect(address).unwrap();
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}

#[test]
fn info_route_says_what_the_server_is() {
    let open = http_get(common::server(), "/api/v1/mindstream/info/");
    assert!(open.starts_with("HTTP/1.1 200"), "{open}");
    assert!(open.contains("\"server\":\"mindstream-server\""), "{open}");
    assert!(open.contains("\"protocol\":1"), "{open}");
    assert!(open.contains("\"signup\":\"open\""), "{open}");

    let closed = http_get(
        &common::start_server(common::closed_signup),
        "/api/v1/mindstream/info/",
    );
    assert!(closed.contains("\"signup\":\"closed\""), "{closed}");

    let health = http_get(common::server(), "/healthz");
    assert!(health.starts_with("HTTP/1.1 200"), "{health}");
    let missing = http_get(common::server(), "/api/v1/nothing/here/");
    assert!(missing.starts_with("HTTP/1.1 404"), "{missing}");
}

/// A reverse proxy used to add these. The server answers browsers directly
/// now, on the invite page at least, so it sends them itself, on every
/// answer including refusals.
#[tokio::test]
async fn every_answer_carries_the_security_headers() {
    let http = reqwest::Client::new();
    for path in [
        "/healthz",
        "/api/v1/mindstream/info/",
        "/api/v1/collection/",
        "/api/v1/no-such-route/",
        "/join/some-link",
    ] {
        let response = http
            .get(format!("{}{path}", common::server()))
            .send()
            .await
            .unwrap();
        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .map(|value| value.to_str().unwrap().to_owned())
        };
        assert_eq!(
            header("x-content-type-options").as_deref(),
            Some("nosniff"),
            "{path}"
        );
        assert_eq!(header("x-frame-options").as_deref(), Some("DENY"), "{path}");
        assert_eq!(
            header("referrer-policy").as_deref(),
            Some("no-referrer"),
            "{path}"
        );
    }
}
