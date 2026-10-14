//! What a reverse proxy used to do for the old stack and this server now does
//! itself: work out who is really calling, and slow down password guessing.

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::num::NonZeroU32;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::extract::connect_info::Connected;
use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::serve::{IncomingStream, Listener};
use governor::clock::{Clock, DefaultClock};
use governor::middleware::NoOpMiddleware;
use governor::state::keyed::DashMapStateStore;
use governor::Quota;
use ipnet::IpNet;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::{Instant, Sleep};

use crate::error::ApiError;
use crate::AppState;

/// The address a request came from, looking through proxies we trust.
///
/// A proxy appends the address it received a request from to
/// `X-Forwarded-For`. Walking that list from the right and skipping trusted
/// proxies ends at the first address nobody we trust vouches for, which is
/// the client. Anything left of it was supplied by the client and is
/// ignored, so a caller cannot pick its own address.
pub fn client_address(peer: IpAddr, forwarded_for: Option<&str>, trusted: &[IpNet]) -> IpAddr {
    let is_trusted = |ip: &IpAddr| trusted.iter().any(|net| net.contains(ip));
    if !is_trusted(&peer) {
        return peer;
    }
    let mut client = peer;
    for hop in forwarded_for.unwrap_or("").rsplit(',') {
        let Ok(ip) = hop.trim().parse::<IpAddr>() else {
            break;
        };
        client = ip;
        if !is_trusted(&ip) {
            break;
        }
    }
    client
}

pub struct ClientAddress(pub IpAddr);

impl FromRequestParts<AppState> for ClientAddress {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let peer = parts
            .extensions
            .get::<ConnectInfo<Peer>>()
            .map(|info| info.0 .0.ip())
            .ok_or_else(|| ApiError::internal("the peer address is not available"))?;
        let forwarded = parts
            .headers
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok());
        Ok(Self(client_address(
            peer,
            forwarded,
            &state.config.trusted_proxies,
        )))
    }
}

/// What a cap counts by. An IPv4 address is one caller. An IPv6 caller is
/// handed a whole /64 to pick addresses from, so the /64 is the caller.
fn caller(address: IpAddr) -> IpAddr {
    match address {
        IpAddr::V4(_) => address,
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => {
                let network = u128::from(v6) & (u128::MAX << 64);
                IpAddr::V6(Ipv6Addr::from(network))
            }
        },
    }
}

#[derive(Default)]
struct Open {
    by_caller: HashMap<IpAddr, usize>,
    total: usize,
}

/// Counts what is open, per caller and in all, and refuses past a cap on
/// either. The proxy in front of the old stack held each address to 128
/// connections. This does the same from inside the server, for connections
/// and again for sockets, which is where a caller can sit on resources for
/// a long time at no cost to itself.
pub struct Gate {
    per_caller: usize,
    total: usize,
    open: Mutex<Open>,
}

/// One place taken at a [`Gate`], given back when this is dropped.
pub struct Permit {
    gate: Arc<Gate>,
    /// Who the place is counted against, besides the total.
    caller: Option<IpAddr>,
}

impl Gate {
    /// A cap of zero is no cap.
    pub fn new(per_caller: usize, total: usize) -> Arc<Self> {
        Arc::new(Self {
            per_caller,
            total,
            open: Mutex::new(Open::default()),
        })
    }

    /// Take a place for `address`, or `None` when it or the server has as
    /// many open as it may.
    pub fn enter(self: &Arc<Self>, address: IpAddr) -> Option<Permit> {
        let caller = caller(address);
        let mut open = self.open.lock().unwrap_or_else(|e| e.into_inner());
        if self.total > 0 && open.total >= self.total {
            return None;
        }
        let held = open.by_caller.entry(caller).or_insert(0);
        if self.per_caller > 0 && *held >= self.per_caller {
            if *held == 0 {
                open.by_caller.remove(&caller);
            }
            return None;
        }
        *held += 1;
        open.total += 1;
        Some(Permit {
            gate: Arc::clone(self),
            caller: Some(caller),
        })
    }

    /// Take a place in the total only, for a connection that stands for
    /// callers who are counted on their own: a trusted proxy's.
    pub fn enter_shared(self: &Arc<Self>) -> Option<Permit> {
        let mut open = self.open.lock().unwrap_or_else(|e| e.into_inner());
        if self.total > 0 && open.total >= self.total {
            return None;
        }
        open.total += 1;
        Some(Permit {
            gate: Arc::clone(self),
            caller: None,
        })
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        let mut open = self.gate.open.lock().unwrap_or_else(|e| e.into_inner());
        open.total = open.total.saturating_sub(1);
        let Some(caller) = self.caller else {
            return;
        };
        if let Some(held) = open.by_caller.get_mut(&caller) {
            *held = held.saturating_sub(1);
            if *held == 0 {
                open.by_caller.remove(&caller);
            }
        }
    }
}

/// The address a connection came from. Its own type so the listener below
/// can say how to find it.
#[derive(Clone, Copy, Debug)]
pub struct Peer(pub SocketAddr);

impl Connected<IncomingStream<'_, CappedListener>> for Peer {
    fn connect_info(stream: IncomingStream<'_, CappedListener>) -> Self {
        Peer(*stream.remote_addr())
    }
}

/// A listener that holds each address to a number of connections, and the
/// server to a number in all.
///
/// A connection past a cap is closed as soon as it is accepted, before
/// anything is read from it. A trusted proxy is exempt from the cap per
/// address: every client behind it shares its address, and the proxy is
/// where those are to be capped. Its connections still count towards the
/// total, which is what keeps the server within the files it may open.
pub struct CappedListener {
    inner: TcpListener,
    gate: Arc<Gate>,
    trusted: Vec<IpNet>,
}

impl CappedListener {
    pub fn new(inner: TcpListener, gate: Arc<Gate>, trusted: Vec<IpNet>) -> Self {
        Self {
            inner,
            gate,
            trusted,
        }
    }
}

impl Listener for CappedListener {
    type Io = CappedStream;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            let (stream, address) = match self.inner.accept().await {
                Ok(accepted) => accepted,
                Err(err) => {
                    accept_failed(err).await;
                    continue;
                }
            };
            let ip = address.ip();
            let permit = if self.trusted.iter().any(|net| net.contains(&ip)) {
                self.gate.enter_shared()
            } else {
                self.gate.enter(ip)
            };
            // Without a place, dropping the stream closes it.
            if let Some(permit) = permit {
                return (CappedStream::new(stream, permit), address);
            }
        }
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        self.inner.local_addr()
    }
}

/// A connection that could not be taken. Most such failures are the
/// caller's, and the caller is gone. Any other means the server is short
/// of something, open files most likely, and trying again at once would
/// fail the same way.
async fn accept_failed(err: io::Error) {
    use io::ErrorKind::{ConnectionAborted, ConnectionRefused, ConnectionReset};
    if matches!(
        err.kind(),
        ConnectionAborted | ConnectionRefused | ConnectionReset
    ) {
        return;
    }
    tracing::error!("cannot accept connections: {err}");
    tokio::time::sleep(Duration::from_secs(1)).await;
}

/// How long a connection may go without a byte moving either way. Rooms
/// and the change feed ping well within it. Without it a caller could keep
/// connections open for nothing, and every one of them holds a file.
const IDLE_CONNECTION: Duration = Duration::from_secs(120);

/// A connection that keeps its place at the gate for as long as it is open,
/// and is closed when it goes quiet for too long.
pub struct CappedStream {
    stream: TcpStream,
    _permit: Permit,
    /// How long it may go quiet.
    idle: Duration,
    /// When bytes last moved, either way.
    moved: Instant,
    /// Wakes the connection to see whether it has been quiet for too long.
    check: Pin<Box<Sleep>>,
}

impl CappedStream {
    fn new(stream: TcpStream, permit: Permit) -> Self {
        Self::quiet_for(stream, permit, IDLE_CONNECTION)
    }

    fn quiet_for(stream: TcpStream, permit: Permit, idle: Duration) -> Self {
        let now = Instant::now();
        Self {
            stream,
            _permit: permit,
            idle,
            moved: now,
            check: Box::pin(tokio::time::sleep_until(now + idle)),
        }
    }

    /// Called whenever the connection waits. Ready with an error once
    /// nothing has moved for as long as it may be quiet; until then it
    /// arranges to be woken when that would be.
    fn poll_quiet(&mut self, cx: &mut Context<'_>) -> Poll<io::Error> {
        while self.check.as_mut().poll(cx).is_ready() {
            let due = self.moved + self.idle;
            if Instant::now() >= due {
                return Poll::Ready(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "nothing moved on the connection for too long",
                ));
            }
            self.check.as_mut().reset(due);
        }
        Poll::Pending
    }

    fn written(
        &mut self,
        outcome: Poll<io::Result<usize>>,
        cx: &mut Context<'_>,
    ) -> Poll<io::Result<usize>> {
        match outcome {
            Poll::Ready(Ok(written)) => {
                if written > 0 {
                    self.moved = Instant::now();
                }
                Poll::Ready(Ok(written))
            }
            Poll::Pending => self.poll_quiet(cx).map(Err),
            failed => failed,
        }
    }
}

impl AsyncRead for CappedStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let before = buf.filled().len();
        match Pin::new(&mut this.stream).poll_read(cx, buf) {
            Poll::Ready(Ok(())) => {
                if buf.filled().len() > before {
                    this.moved = Instant::now();
                }
                Poll::Ready(Ok(()))
            }
            Poll::Pending => this.poll_quiet(cx).map(Err),
            failed => failed,
        }
    }
}

impl AsyncWrite for CappedStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let outcome = Pin::new(&mut this.stream).poll_write(cx, buf);
        this.written(outcome, cx)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        match Pin::new(&mut this.stream).poll_flush(cx) {
            Poll::Pending => this.poll_quiet(cx).map(Err),
            done => done,
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_shutdown(cx)
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let outcome = Pin::new(&mut this.stream).poll_write_vectored(cx, bufs);
        this.written(outcome, cx)
    }

    fn is_write_vectored(&self) -> bool {
        self.stream.is_write_vectored()
    }
}

/// Raise the number of files the process may open as far as it is allowed
/// to, and return what it may open now. Every connection is a file, and a
/// process that runs out cannot take another: for anyone. Many systems
/// start a process with a low soft limit and a much higher hard one.
#[cfg(unix)]
pub fn raise_open_file_limit() -> Option<u64> {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: getrlimit writes the limits into the struct it is given.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return None;
    }
    if limit.rlim_cur < limit.rlim_max {
        let raised = libc::rlimit {
            rlim_cur: limit.rlim_max,
            rlim_max: limit.rlim_max,
        };
        // SAFETY: setrlimit reads the struct it is given. Asking for no
        // more than the hard limit is allowed to any process.
        if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &raised) } == 0 {
            limit = raised;
        }
    }
    // rlim_t is a u64 here and narrower on some systems.
    #[allow(clippy::unnecessary_cast)]
    let files = limit.rlim_cur as u64;
    (limit.rlim_cur != libc::RLIM_INFINITY).then_some(files)
}

#[cfg(not(unix))]
pub fn raise_open_file_limit() -> Option<u64> {
    None
}

/// Files kept back from connections: the database pool, blobs being read
/// and written, the listener itself.
const FILES_KEPT_BACK: usize = 256;

/// The cap on connections in all that the server can keep: what is
/// configured, but never more than it can open files for. Past that it
/// could take nothing at all, which is worse than refusing the newest.
pub fn connection_room(configured: usize, file_limit: Option<u64>, database: u32) -> usize {
    let Some(files) = file_limit else {
        return configured;
    };
    let room = usize::try_from(files)
        .unwrap_or(usize::MAX)
        .saturating_sub(FILES_KEPT_BACK + database as usize)
        .max(1);
    if configured == 0 {
        room
    } else {
        configured.min(room)
    }
}

/// Add to a socket's handler to count the socket against its caller. The
/// place is given back when the returned permit is dropped, so the handler
/// keeps it for as long as the socket lives.
pub struct SocketPermit {
    _held: Permit,
}

impl FromRequestParts<AppState> for SocketPermit {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let ClientAddress(address) = ClientAddress::from_request_parts(parts, state).await?;
        let held = state.sockets.enter(address).ok_or_else(|| {
            ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "too_many_connections",
                "Too many connections are open from this address.",
            )
        })?;
        Ok(Self { _held: held })
    }
}

type Buckets<C> = governor::RateLimiter<
    IpAddr,
    DashMapStateStore<IpAddr>,
    C,
    NoOpMiddleware<<C as Clock>::Instant>,
>;

/// A token bucket per caller. The buckets are `governor`'s. Who a caller
/// is, is decided here: see [`ClientAddress`] and [`caller`].
pub struct RateLimiter<C: Clock = DefaultClock> {
    /// Nothing when limiting is off.
    buckets: Option<Buckets<C>>,
}

impl RateLimiter {
    /// `per_minute` of zero turns limiting off.
    pub fn new(per_minute: u32, burst: u32) -> Self {
        Self::with_clock(per_minute, burst, DefaultClock::default())
    }
}

impl<C: Clock> RateLimiter<C> {
    fn with_clock(per_minute: u32, burst: u32, clock: C) -> Self {
        let buckets = NonZeroU32::new(per_minute).map(|rate| {
            let burst = NonZeroU32::new(burst).unwrap_or(NonZeroU32::MIN);
            let quota = Quota::per_minute(rate).allow_burst(burst);
            governor::RateLimiter::dashmap_with_clock(quota, clock)
        });
        Self { buckets }
    }

    pub fn allow(&self, address: IpAddr) -> bool {
        match &self.buckets {
            Some(buckets) => buckets.check_key(&caller(address)).is_ok(),
            None => true,
        }
    }

    /// Forget every caller whose bucket has refilled. A full bucket says
    /// nothing a new one would not, and the limiter keeps a caller until it
    /// is told to let go.
    pub fn forget_idle(&self) {
        if let Some(buckets) = &self.buckets {
            buckets.retain_recent();
            buckets.shrink_to_fit();
        }
    }

    #[cfg(test)]
    fn remembered(&self) -> usize {
        self.buckets.as_ref().map_or(0, |buckets| buckets.len())
    }
}

/// How often callers that are no longer held back are forgotten. Between
/// two rounds the limiter remembers one entry for each caller that tried to
/// sign in, and a caller is an address the connection caps have let in.
const FORGET_IDLE_EVERY: Duration = Duration::from_secs(60);

/// Keep what the sign-in limiter remembers to the callers it is holding
/// back, for as long as the process runs.
pub fn forget_idle_callers(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(FORGET_IDLE_EVERY);
        loop {
            tick.tick().await;
            state.auth_limiter.forget_idle();
        }
    });
}

/// Add to a handler to subject it to the limit on credential guessing.
pub struct AuthAttempt;

impl FromRequestParts<AppState> for AuthAttempt {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let ClientAddress(address) = ClientAddress::from_request_parts(parts, state).await?;
        if state.auth_limiter.allow(address) {
            Ok(Self)
        } else {
            Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "throttled",
                "Too many sign-in attempts. Wait a minute and try again.",
            ))
        }
    }
}

#[cfg(test)]
mod gate_tests {
    use super::*;

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn each_caller_is_held_to_its_cap_and_gets_places_back() {
        let gate = Gate::new(2, 0);
        let first = gate.enter(ip("203.0.113.5")).unwrap();
        let _second = gate.enter(ip("203.0.113.5")).unwrap();
        assert!(gate.enter(ip("203.0.113.5")).is_none());
        // Somebody else is not affected.
        let _other = gate.enter(ip("203.0.113.6")).unwrap();

        drop(first);
        assert!(gate.enter(ip("203.0.113.5")).is_some());
    }

    #[test]
    fn everything_together_is_capped_too() {
        let gate = Gate::new(0, 2);
        let _a = gate.enter(ip("203.0.113.1")).unwrap();
        let b = gate.enter(ip("203.0.113.2")).unwrap();
        assert!(gate.enter(ip("203.0.113.3")).is_none());
        drop(b);
        assert!(gate.enter(ip("203.0.113.3")).is_some());
        // A refusal leaves nothing behind to count.
        assert!(gate.open.lock().unwrap().by_caller.len() <= 2);
    }

    #[test]
    fn ipv6_callers_are_counted_by_their_network() {
        let gate = Gate::new(1, 0);
        let _one = gate.enter(ip("2001:db8:1:2::1")).unwrap();
        // Another address out of the same /64 is the same caller.
        assert!(gate.enter(ip("2001:db8:1:2:ffff::9")).is_none());
        assert!(gate.enter(ip("2001:db8:1:3::1")).is_some());
        // An IPv4 address written as IPv6 is the IPv4 caller.
        let _mapped = gate.enter(ip("::ffff:203.0.113.7")).unwrap();
        assert!(gate.enter(ip("203.0.113.7")).is_none());
    }

    #[test]
    fn a_trusted_proxy_counts_towards_the_total_only() {
        let gate = Gate::new(1, 3);
        let proxied: Vec<Permit> = (0..2).map(|_| gate.enter_shared().unwrap()).collect();
        // The proxy's places are nobody's, so a caller still gets its own.
        let caller = gate.enter(ip("203.0.113.5")).unwrap();
        // And then the server is full, for the proxy too.
        assert!(gate.enter_shared().is_none());
        assert!(gate.enter(ip("203.0.113.6")).is_none());
        drop(proxied);
        assert!(gate.enter_shared().is_some());
        drop(caller);
        assert!(gate.open.lock().unwrap().by_caller.is_empty());
    }

    #[test]
    fn connections_fit_under_the_open_file_limit() {
        // Kept back: 256 files and the database pool.
        assert_eq!(connection_room(10_000, Some(1024), 10), 758);
        assert_eq!(connection_room(10_000, Some(1_048_576), 10), 10_000);
        assert_eq!(connection_room(500, Some(1024), 10), 500);
        // No cap configured is still no more than the files allow.
        assert_eq!(connection_room(0, Some(1024), 10), 758);
        // An unknown limit leaves the setting as it is.
        assert_eq!(connection_room(0, None, 10), 0);
        assert_eq!(connection_room(10_000, Some(64), 10), 1);
    }

    #[cfg(unix)]
    #[test]
    fn the_open_file_limit_is_raised_as_far_as_allowed() {
        let raised = raise_open_file_limit().unwrap_or(u64::MAX);
        let mut limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: as in raise_open_file_limit.
        assert_eq!(
            unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) },
            0
        );
        assert_eq!(limit.rlim_cur, limit.rlim_max);
        #[allow(clippy::unnecessary_cast)]
        let files = limit.rlim_cur as u64;
        assert!(raised == u64::MAX || raised == files);
    }

    #[test]
    fn no_cap_means_no_cap() {
        let gate = Gate::new(0, 0);
        let held: Vec<Permit> = (0..500)
            .map(|_| gate.enter(ip("203.0.113.5")).unwrap())
            .collect();
        assert_eq!(held.len(), 500);
    }
}

#[cfg(test)]
mod stream_tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    const QUIET: Duration = Duration::from_millis(300);

    async fn connection() -> (CappedStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (server, _) = listener.accept().await.unwrap();
        let permit = Gate::new(0, 0).enter_shared().unwrap();
        (CappedStream::quiet_for(server, permit, QUIET), client)
    }

    #[tokio::test]
    async fn a_connection_that_sends_nothing_is_closed() {
        let (mut server, _client) = connection().await;
        let started = Instant::now();
        let failed = server.read(&mut [0u8; 8]).await.unwrap_err();
        assert_eq!(failed.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() >= QUIET);
    }

    #[tokio::test]
    async fn a_connection_that_keeps_talking_stays_open() {
        let (mut server, mut client) = connection().await;
        let talker = tokio::spawn(async move {
            for _ in 0..6 {
                tokio::time::sleep(QUIET / 3).await;
                client.write_all(b"x").await.unwrap();
            }
            client
        });
        let mut byte = [0u8; 1];
        for _ in 0..6 {
            server.read_exact(&mut byte).await.unwrap();
        }
        // Well past the quiet period in all, and still open.
        let mut client = talker.await.unwrap();
        server.write_all(b"y").await.unwrap();
        client.read_exact(&mut byte).await.unwrap();
        assert_eq!(&byte, b"y");
    }

    /// A caller that stops reading what it asked for holds the server's
    /// writes up, and is closed for it just the same.
    #[tokio::test]
    async fn a_connection_that_stops_reading_is_closed() {
        let (mut server, _client) = connection().await;
        let chunk = vec![0u8; 1024 * 1024];
        let failed = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Err(err) = server.write_all(&chunk).await {
                    return err;
                }
            }
        })
        .await
        .expect("the writes never stopped");
        assert_eq!(failed.kind(), io::ErrorKind::TimedOut);
    }
}

#[cfg(test)]
mod tests {
    use governor::clock::FakeRelativeClock;

    use super::*;

    fn nets(list: &[&str]) -> Vec<IpNet> {
        list.iter().map(|net| net.parse().unwrap()).collect()
    }

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn untrusted_peer_cannot_name_its_own_address() {
        let trusted = nets(&["10.0.0.0/8"]);
        assert_eq!(
            client_address(ip("203.0.113.9"), Some("198.51.100.1"), &trusted),
            ip("203.0.113.9")
        );
    }

    #[test]
    fn client_is_the_first_hop_no_trusted_proxy_vouches_for() {
        let trusted = nets(&["10.0.0.0/8", "127.0.0.0/8"]);
        // client -> edge proxy (10.0.0.2) -> local proxy (10.0.0.3) -> us
        assert_eq!(
            client_address(ip("10.0.0.3"), Some("203.0.113.9, 10.0.0.2"), &trusted),
            ip("203.0.113.9")
        );
        // The client put a forged entry in front; it is left of the real
        // one and never reached.
        assert_eq!(
            client_address(
                ip("10.0.0.3"),
                Some("198.51.100.1, 203.0.113.9, 10.0.0.2"),
                &trusted
            ),
            ip("203.0.113.9")
        );
        // No header at all: the proxy itself is the best answer there is.
        assert_eq!(
            client_address(ip("10.0.0.3"), None, &trusted),
            ip("10.0.0.3")
        );
        // Garbage ends the walk where it stands.
        assert_eq!(
            client_address(ip("10.0.0.3"), Some("nonsense, 10.0.0.2"), &trusted),
            ip("10.0.0.2")
        );
    }

    #[test]
    fn bucket_allows_a_burst_then_refills_at_the_rate() {
        let clock = FakeRelativeClock::default();
        let limiter = RateLimiter::with_clock(60, 3, clock.clone());
        let caller = ip("203.0.113.9");
        assert!(limiter.allow(caller));
        assert!(limiter.allow(caller));
        assert!(limiter.allow(caller));
        assert!(!limiter.allow(caller));
        // Another address has its own bucket.
        assert!(limiter.allow(ip("203.0.113.10")));
        // One token a second at 60 a minute.
        clock.advance(Duration::from_millis(500));
        assert!(!limiter.allow(caller));
        clock.advance(Duration::from_millis(600));
        assert!(limiter.allow(caller));
        clock.advance(Duration::from_millis(100));
        assert!(!limiter.allow(caller));
    }

    #[test]
    fn addresses_of_one_ipv6_network_share_a_bucket() {
        let limiter = RateLimiter::with_clock(60, 2, FakeRelativeClock::default());
        assert!(limiter.allow(ip("2001:db8:1:2::1")));
        assert!(limiter.allow(ip("2001:db8:1:2:aaaa:bbbb:cccc:dddd")));
        // The /64 has used its two, whichever address asks.
        assert!(!limiter.allow(ip("2001:db8:1:2::3")));
        // The network next to it has not.
        assert!(limiter.allow(ip("2001:db8:1:3::1")));
    }

    #[test]
    fn callers_whose_bucket_has_refilled_are_forgotten() {
        let clock = FakeRelativeClock::default();
        let limiter = RateLimiter::with_clock(60, 3, clock.clone());
        for last in 1..=40u8 {
            assert!(limiter.allow(IpAddr::from([203, 0, 113, last])));
        }
        let busy = ip("198.51.100.7");
        limiter.forget_idle();
        assert_eq!(limiter.remembered(), 40);

        // Two seconds on, a bucket that gave one token out is full again.
        // One that is still being drawn on is not.
        clock.advance(Duration::from_secs(2));
        for _ in 0..3 {
            assert!(limiter.allow(busy));
        }
        limiter.forget_idle();
        assert_eq!(limiter.remembered(), 1);
        assert!(!limiter.allow(busy));
    }

    #[test]
    fn zero_rate_means_no_limit() {
        let limiter = RateLimiter::new(0, 1);
        let caller = ip("203.0.113.9");
        assert!((0..1000).all(|_| limiter.allow(caller)));
    }
}
