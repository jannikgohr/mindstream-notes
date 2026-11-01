//! The server's own front door: the limit on sign-in attempts and the route
//! a client reads to learn what it is talking to.

mod common;

use std::io::{Read, Write};
use std::time::Duration;

use common::raw::Device;
use etebase::error::Error;
use etebase::{Account, User};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

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
        config.trusted_proxies = Some(Vec::new());
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

/// The account reset route is refused past loopback by whoever serves, not
/// only by the binary's own startup check: a library consumer serving
/// through `serve` gets the same refusal.
#[tokio::test]
async fn test_reset_route_never_serves_past_loopback() {
    use mindstream_server::{serve, AppState, Config};

    let blob_dir = std::env::temp_dir().join(format!(
        "mindstream-server-test-reset-{}",
        std::process::id()
    ));
    let mut config = Config::for_tests(common::database_url(), blob_dir);
    assert!(config.test_reset);
    // Never actually served from here: the listener below stays loopback.
    config.listen = "0.0.0.0:1".into();
    let state = AppState::connect(config).await.expect("connect");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let refused = serve(listener, state, std::future::pending::<()>()).await;
    let err = refused.expect_err("serving the reset route past loopback");
    assert!(err.to_string().contains("refusing to start"), "{err}");
}

/// Post a body of `size` bytes nobody can decode, and return the status. The
/// server may answer before it has read all of it and close the connection,
/// so sending may fail where reading the answer does not.
async fn post_junk(url: &str, path: &str, headers: &str, size: usize) -> u16 {
    let mut stream = TcpStream::connect(url.trim_start_matches("http://"))
        .await
        .unwrap();
    let head = format!(
        "POST /api/v1{path} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n{headers}\
         Content-Length: {size}\r\n\r\n"
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(&vec![0xc1u8; size]).await;
    let mut status = [0u8; 12];
    stream.read_exact(&mut status).await.expect("an answer");
    std::str::from_utf8(&status[9..12])
        .unwrap()
        .parse()
        .expect("a status")
}

/// Nothing that takes a body from someone who has not shown who they are
/// needs more than a few keys, and a body is buffered before a handler sees
/// it.
#[tokio::test]
async fn sign_in_routes_take_no_large_body() {
    let url = common::start_server(|_| {});
    for path in [
        "/authentication/signup/",
        "/authentication/login_challenge/",
        "/authentication/login/",
        "/authentication/recover/",
        "/authentication/recover/complete/",
        "/mindstream/link/somelink/open/",
    ] {
        assert_eq!(post_junk(&url, path, "", 1024 * 1024).await, 413, "{path}");
    }
}

/// The time a sign-in has to take starts once its request is in. If it
/// started before, a caller could spend it sending the body, and time the
/// work after all.
#[tokio::test]
async fn sending_slowly_does_not_use_up_the_time_a_sign_in_takes() {
    let url = common::start_server(|_| {});
    let mut stream = TcpStream::connect(url.trim_start_matches("http://"))
        .await
        .unwrap();
    let body = rmp_serde::to_vec_named(&serde_json::json!({ "username": "nobody" })).unwrap();
    let head = format!(
        "POST /api/v1/authentication/login_challenge/ HTTP/1.1\r\nHost: test\r\n\
         Connection: close\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;

    stream.write_all(&body).await.unwrap();
    let sent = std::time::Instant::now();
    let mut status = [0u8; 12];
    stream.read_exact(&mut status).await.unwrap();
    assert_eq!(&status[9..12], b"200");
    assert!(sent.elapsed() >= Duration::from_millis(90));
}

/// Every part of a body takes room as it arrives and keeps it until the
/// request is done, so bodies cannot add up past what the server can hold by
/// arriving together or by arriving slowly.
#[tokio::test]
async fn bodies_are_held_to_the_room_the_server_has() {
    const MIB: usize = 1024 * 1024;
    let url = common::start_server(|config| {
        config.max_body_bytes_in_flight = 3 * MIB;
        config.max_body_bytes_in_flight_per_address = 2 * MIB;
    });
    let device = Device::signup(&url, "parked").await;
    let from = |address: &str| {
        format!(
            "X-Forwarded-For: {address}\r\nAuthorization: Token {}\r\n",
            device.token
        )
    };
    let first = from("203.0.113.1");
    let second = from("203.0.113.2");
    let post = async |headers: &str, size| post_junk(&url, "/collection/", headers, size).await;

    // Sends most of what it says it will and stops, which is one way to sit
    // on memory for as long as the deadlines let it.
    let mut parked = TcpStream::connect(url.trim_start_matches("http://"))
        .await
        .unwrap();
    let head = format!(
        "POST /api/v1/collection/ HTTP/1.1\r\nHost: test\r\n{first}Content-Length: {}\r\n\r\n",
        2 * MIB
    );
    parked.write_all(head.as_bytes()).await.unwrap();
    parked.write_all(&vec![0xc1u8; 3 * MIB / 2]).await.unwrap();

    // Once it has arrived, the same address has no room left for this.
    tokio::time::timeout(Duration::from_secs(5), async {
        while post(&first, MIB).await != 503 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the parked body took no room");
    // There is still room for something smaller, which reaches the handler.
    assert_eq!(post(&first, MIB / 4).await, 400);
    // Another address has its own share of what is left, and no more.
    assert_eq!(post(&second, MIB).await, 400);
    assert_eq!(post(&second, 2 * MIB).await, 503);

    // The room comes back with the request.
    drop(parked);
    tokio::time::timeout(Duration::from_secs(5), async {
        while post(&first, MIB).await != 400 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the room did not come back");
}

/// A promise of a body costs nothing: only what has arrived takes room, so
/// nobody can fill the room by saying they are about to send a lot.
#[tokio::test]
async fn saying_a_body_will_be_large_takes_no_room() {
    const MIB: usize = 1024 * 1024;
    let url = common::start_server(|config| {
        config.max_body_bytes_in_flight = 2 * MIB;
    });
    let device = Device::signup(&url, "promised").await;
    let token = format!("Authorization: Token {}\r\n", device.token);

    let mut promises = Vec::new();
    for _ in 0..8 {
        let mut stream = TcpStream::connect(url.trim_start_matches("http://"))
            .await
            .unwrap();
        let head = format!(
            "POST /api/v1/collection/ HTTP/1.1\r\nHost: test\r\n{token}\
             Content-Length: {}\r\n\r\n",
            50 * MIB
        );
        stream.write_all(head.as_bytes()).await.unwrap();
        promises.push(stream);
    }
    assert_eq!(post_junk(&url, "/collection/", &token, MIB).await, 400);
}
