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

/// An address may hold only so many sockets. They are what a caller can
/// leave open for hours at no cost to itself, so the cap is checked before
/// the socket exists and its place is given back when it closes.
#[tokio::test]
async fn sockets_are_capped_per_address_and_a_closed_one_frees_its_place() {
    use common::raw::{Device, Socket};

    let url = common::start_server(|config| config.max_connections_per_address = 2);
    let device = Device::signup(&url, "sockets").await;
    let first = device.feed().await;
    let _second = device.feed().await;

    let refused = Socket::try_open(&url, "/api/v1/mindstream/feed/", Some(&device.token)).await;
    let refusal = refused.err().expect("a third socket was let in");
    assert!(refusal.contains("429"), "{refusal}");
    // A room socket counts against the same cap, ticket or no ticket.
    let refused = Socket::try_open(&url, "/api/v1/room/", None).await;
    assert!(refused.is_err());

    drop(first);
    let mut opened = None;
    for _ in 0..50 {
        match Socket::try_open(&url, "/api/v1/mindstream/feed/", Some(&device.token)).await {
            Ok(socket) => {
                opened = Some(socket);
                break;
            }
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(50)).await,
        }
    }
    assert!(opened.is_some(), "the closed socket's place was not freed");
}

/// The same for plain connections, the way the proxy in front of the old
/// stack capped them: one past the cap is closed before it is read from.
/// A trusted proxy is exempt, so the test server has to stop trusting this
/// machine first.
#[tokio::test]
async fn connections_are_capped_per_address() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    let url = common::start_server(|config| {
        config.trusted_proxies.clear();
        config.max_connections_per_address = 2;
    });
    let address = url.trim_start_matches("http://").to_owned();
    let request = b"GET /healthz HTTP/1.1\r\nHost: test\r\n\r\n";

    // Two connections that stay open after being answered.
    let mut held = Vec::new();
    for _ in 0..2 {
        let mut stream = TcpStream::connect(&address).await.unwrap();
        stream.write_all(request).await.unwrap();
        let mut answer = [0u8; 15];
        stream.read_exact(&mut answer).await.unwrap();
        assert_eq!(&answer, b"HTTP/1.1 200 OK");
        held.push(stream);
    }

    // The third is accepted by the system and closed by the server.
    let mut third = TcpStream::connect(&address).await.unwrap();
    let _ = third.write_all(request).await;
    let mut answer = Vec::new();
    let read = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        third.read_to_end(&mut answer),
    )
    .await
    .expect("the connection past the cap was left open");
    assert!(
        read.is_err() || answer.is_empty(),
        "the connection past the cap was answered: {:?}",
        String::from_utf8_lossy(&answer)
    );

    // Closing one makes room.
    held.pop();
    let mut answered = false;
    for _ in 0..50 {
        let mut stream = TcpStream::connect(&address).await.unwrap();
        let _ = stream.write_all(request).await;
        let mut answer = [0u8; 15];
        if stream.read_exact(&mut answer).await.is_ok() && &answer == b"HTTP/1.1 200 OK" {
            answered = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(
        answered,
        "closing a connection did not make room for another"
    );
}
