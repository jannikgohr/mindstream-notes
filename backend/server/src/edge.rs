//! What a reverse proxy used to do for the old stack and this server now does
//! itself: work out who is really calling, hold callers to their share of
//! connections and to deadlines, and slow down password guessing.

use std::collections::HashMap;
use std::future::Future;
use std::hash::Hash;
use std::io;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::num::NonZeroU32;
use std::pin::{pin, Pin};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{ready, Context, Poll};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::{BoxError, Router};
use governor::clock::{Clock, DefaultClock};
use governor::middleware::NoOpMiddleware;
use governor::state::keyed::DashMapStateStore;
use governor::Quota;
use http_body::{Body as _, Frame, SizeHint};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use ipnet::IpNet;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::time::{Instant, Sleep};
use tower::ServiceExt;

use crate::error::{ApiError, ApiResult};
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
            &state.config.trusted_proxies(),
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

/// Places taken at a [`Gate`], given back when this is dropped.
pub struct Permit {
    gate: Arc<Gate>,
    /// Who the places are counted against, besides the total.
    caller: Option<IpAddr>,
    places: usize,
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
        let mut permit = self.holding_nothing(address);
        permit.take(1).then_some(permit)
    }

    /// A permit for `address` with no places yet, for what is counted as it
    /// grows, see [`Permit::take`].
    pub fn holding_nothing(self: &Arc<Self>, address: IpAddr) -> Permit {
        Permit {
            gate: Arc::clone(self),
            caller: Some(caller(address)),
            places: 0,
        }
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
            places: 1,
        })
    }
}

impl Permit {
    /// Take `places` more, all of them or none. Says whether it did.
    pub fn take(&mut self, places: usize) -> bool {
        let mut open = self.gate.open.lock().unwrap_or_else(|e| e.into_inner());
        if self.gate.total > 0 && open.total + places > self.gate.total {
            return false;
        }
        if let Some(caller) = self.caller {
            let held = open.by_caller.entry(caller).or_insert(0);
            if self.gate.per_caller > 0 && *held + places > self.gate.per_caller {
                if *held == 0 {
                    open.by_caller.remove(&caller);
                }
                return false;
            }
            *held += places;
        }
        open.total += places;
        self.places += places;
        true
    }

    /// Give `places` of those held back.
    fn give_back(&mut self, places: usize) {
        let places = places.min(self.places);
        self.places -= places;
        let mut open = self.gate.open.lock().unwrap_or_else(|e| e.into_inner());
        open.total = open.total.saturating_sub(places);
        let Some(caller) = self.caller else {
            return;
        };
        if let Some(held) = open.by_caller.get_mut(&caller) {
            *held = held.saturating_sub(places);
            if *held == 0 {
                open.by_caller.remove(&caller);
            }
        }
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.give_back(self.places);
    }
}

/// What a request's body has taken of the room for bodies in memory.
struct BodyRoom {
    permit: Mutex<Permit>,
    /// Whether the body ran out of room and was cut off.
    refused: AtomicBool,
}

/// A request body that takes room for each part as it arrives.
struct Counted {
    body: Body,
    room: Arc<BodyRoom>,
}

impl http_body::Body for Counted {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        let this = self.get_mut();
        let frame = match Pin::new(&mut this.body).poll_frame(cx) {
            Poll::Ready(Some(frame)) => frame?,
            Poll::Ready(None) => return Poll::Ready(None),
            Poll::Pending => return Poll::Pending,
        };
        if let Some(data) = frame.data_ref() {
            let mut permit = this.room.permit.lock().unwrap_or_else(|e| e.into_inner());
            if !permit.take(data.len()) {
                this.room.refused.store(true, Ordering::Relaxed);
                return Poll::Ready(Some(Err("no room for this body".into())));
            }
        }
        Poll::Ready(Some(Ok(frame)))
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.body.size_hint()
    }
}

/// Hold request bodies to what the server keeps in memory at once.
///
/// A body is buffered whole before its handler runs, and stays in memory
/// while the handler decodes it and waits for the database. Caps on
/// connections do not bound that, since each may carry the largest body
/// there is. So every part of a body takes room as it arrives, and keeps it
/// until the handler is done. Past that the answer is 503, which a client
/// tries again later.
///
/// Room is taken for what has come, not for what a request says will come,
/// so a promise costs nothing to anyone else. A handler reads the body after
/// it has checked who is calling, so someone without a session takes no room
/// on the routes that want one, and on those that do not, as much as they
/// can send there, see `SIGN_IN_BODY_BYTES`. Counting by caller keeps one of
/// them from filling the room for everybody.
pub async fn hold_body_room(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    if request.body().is_end_stream() {
        return next.run(request).await;
    }
    let (mut parts, body) = request.into_parts();
    let address = match ClientAddress::from_request_parts(&mut parts, &state).await {
        Ok(ClientAddress(address)) => address,
        Err(err) => return err.into_response(),
    };
    let room = Arc::new(BodyRoom {
        permit: Mutex::new(state.bodies.holding_nothing(address)),
        refused: AtomicBool::new(false),
    });
    let body = Body::new(Counted {
        body,
        room: Arc::clone(&room),
    });
    let response = next.run(Request::from_parts(parts, body)).await;
    if room.refused.load(Ordering::Relaxed) {
        return ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "server_busy",
            "The server is taking in too much right now. Try again in a moment.",
        )
        .into_response();
    }
    response
}

/// A response this small is in the connection's own buffers as soon as it
/// leaves the handler, and is not worth counting. So the health check and
/// small pages still get through when the room is full.
const SMALL_RESPONSE_BYTES: usize = 64 * 1024;

/// How much larger than it was weighed a page can go out, for the names and
/// the framing of its rows, of which there are 1000 at most.
pub const PAGE_FRAMING_BYTES: usize = 1024 * 1024;

/// How much of a response is handed to the connection at a time.
const RESPONSE_PIECE_BYTES: usize = 64 * 1024;

fn no_room_for_response() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "server_busy",
        "The server is sending out too much right now. Try again in a moment.",
    )
}

/// What a request's response has taken of the room for responses in memory.
/// A handler takes room as it learns what it is about to read, before it
/// reads it, see [`hold_response_room`].
#[derive(Clone)]
pub struct ResponseRoom(Arc<Mutex<Permit>>);

impl ResponseRoom {
    /// Take room for `bytes` more of this response, or refuse it with `503`.
    pub fn take(&self, bytes: i64) -> ApiResult<()> {
        let bytes = usize::try_from(bytes).unwrap_or(0);
        if bytes <= SMALL_RESPONSE_BYTES {
            return Ok(());
        }
        let mut permit = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if permit.take(bytes) {
            Ok(())
        } else {
            Err(no_room_for_response())
        }
    }

    /// Hold what the finished response weighs, in place of what was taken on
    /// the way there. Says whether there was room for it.
    fn settle(&self, bytes: usize) -> bool {
        let mut permit = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if bytes > permit.places {
            let more = bytes - permit.places;
            return permit.take(more);
        }
        let less = permit.places - bytes;
        permit.give_back(less);
        true
    }
}

impl FromRequestParts<AppState> for ResponseRoom {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _: &AppState) -> Result<Self, ApiError> {
        parts
            .extensions
            .get::<ResponseRoom>()
            .cloned()
            .ok_or_else(|| ApiError::internal("no room was set aside for this response"))
    }
}

/// A response on its way out, which keeps its room until the last of it has
/// gone to the connection.
///
/// A body handed over in one piece is dropped at once, with all of it still
/// waiting in the connection's buffers, and the room would be free again
/// long before the memory is. So it goes in pieces, each a copy, which the
/// connection only asks for as it gets rid of the one before.
struct Sending {
    body: Body,
    rest: Bytes,
    _room: ResponseRoom,
}

impl http_body::Body for Sending {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        let this = self.get_mut();
        if this.rest.is_empty() {
            let Some(frame) = ready!(Pin::new(&mut this.body).poll_frame(cx)) else {
                return Poll::Ready(None);
            };
            match frame?.into_data() {
                Ok(data) => this.rest = data,
                Err(frame) => return Poll::Ready(Some(Ok(frame))),
            }
        }
        let piece = this.rest.len().min(RESPONSE_PIECE_BYTES);
        let frame = Frame::data(Bytes::copy_from_slice(&this.rest[..piece]));
        this.rest = this.rest.slice(piece..);
        Poll::Ready(Some(Ok(frame)))
    }

    fn is_end_stream(&self) -> bool {
        self.rest.is_empty() && self.body.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        let body = self.body.size_hint();
        let rest = self.rest.len() as u64;
        let mut hint = SizeHint::new();
        hint.set_lower(body.lower() + rest);
        if let Some(upper) = body.upper() {
            hint.set_upper(upper + rest);
        }
        hint
    }
}

/// Hold responses to what the server keeps in memory at once.
///
/// A response is built whole in memory and stays there until the client has
/// taken it, and a client that takes it slowly holds on to it for as long as
/// it likes. Caps on connections do not bound that: a trusted proxy is exempt
/// from the cap per address, and each connection may be waiting for the
/// largest page there is. So a handler takes room for what it is about to
/// read, before it reads it, and the response keeps room for what it weighs
/// until it is gone. Past that the answer is 503, which a client tries again
/// later. Counting by caller keeps one of them from filling the room for
/// everybody, and what a client may hold on to and for how long is settled
/// by [`PATIENCE`].
pub async fn hold_response_room(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let (mut parts, body) = request.into_parts();
    let address = match ClientAddress::from_request_parts(&mut parts, &state).await {
        Ok(ClientAddress(address)) => address,
        Err(err) => return err.into_response(),
    };
    let room = ResponseRoom(Arc::new(Mutex::new(
        state.responses.holding_nothing(address),
    )));
    parts.extensions.insert(room.clone());
    let response = next.run(Request::from_parts(parts, body)).await;
    let bytes = response.body().size_hint().exact().unwrap_or(0) as usize;
    if bytes <= SMALL_RESPONSE_BYTES {
        return response;
    }
    if !room.settle(bytes) {
        return no_room_for_response().into_response();
    }
    let (parts, body) = response.into_parts();
    let body = Body::new(Sending {
        body,
        rest: Bytes::new(),
        _room: room,
    });
    Response::from_parts(parts, body)
}

/// The address a connection came from, which [`serve`] hands every request
/// on it.
#[derive(Clone, Copy, Debug)]
pub struct Peer(pub SocketAddr);

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

impl CappedListener {
    /// The next connection that fits under the caps.
    pub async fn accept(&mut self) -> (CappedStream, SocketAddr) {
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

/// How long what a client asked for may wait for it to be taken.
///
/// A connection starts with `grace`. Every byte the client takes earns it
/// time, at `rate` bytes a second and up to `longest`, and time spent with
/// output waiting for it to make room is paid out of that. A client that
/// takes less than `rate` for long enough runs out and is cut off, so it
/// cannot hold on to a response by keeping the connection barely alive.
#[derive(Clone, Copy)]
struct Patience {
    grace: Duration,
    rate: u64,
    longest: Duration,
}

/// At this rate the largest page there is goes out in about half an hour,
/// which is what a client can make it stay in memory for.
const PATIENCE: Patience = Patience {
    grace: Duration::from_secs(30),
    rate: 16 * 1024,
    longest: Duration::from_secs(30 * 60),
};

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
    patience: Patience,
    /// What the client has left of its patience.
    earned: Duration,
    /// Since when output has been waiting for the client, if it is.
    waiting: Option<Instant>,
}

impl CappedStream {
    fn new(stream: TcpStream, permit: Permit) -> Self {
        Self::with(stream, permit, IDLE_CONNECTION, PATIENCE)
    }

    fn with(stream: TcpStream, permit: Permit, idle: Duration, patience: Patience) -> Self {
        let now = Instant::now();
        Self {
            stream,
            _permit: permit,
            idle,
            moved: now,
            check: Box::pin(tokio::time::sleep_until(now + idle)),
            patience,
            earned: patience.grace,
            waiting: None,
        }
    }

    /// When a connection that goes on waiting is to be closed.
    fn due(&self) -> Instant {
        let quiet = self.moved + self.idle;
        match self.waiting {
            Some(since) => quiet.min(since + self.earned),
            None => quiet,
        }
    }

    /// Called whenever the connection waits. Ready with an error once it
    /// has been quiet for as long as it may be, or the client has used up
    /// its patience; until then it arranges to be woken when that would be.
    fn poll_quiet(&mut self, cx: &mut Context<'_>) -> Poll<io::Error> {
        if self.due() < self.check.deadline() {
            let due = self.due();
            self.check.as_mut().reset(due);
        }
        while self.check.as_mut().poll(cx).is_ready() {
            let due = self.due();
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
                let now = Instant::now();
                if written > 0 {
                    self.moved = now;
                }
                if let Some(since) = self.waiting.take() {
                    self.earned = self.earned.saturating_sub(now - since);
                }
                let bought = written as u64 * 1000 / self.patience.rate;
                self.earned =
                    (self.earned + Duration::from_millis(bought)).min(self.patience.longest);
                Poll::Ready(Ok(written))
            }
            Poll::Pending => {
                self.waiting.get_or_insert_with(Instant::now);
                self.poll_quiet(cx).map(Err)
            }
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

/// How long a caller may take to send a request.
#[derive(Clone, Copy)]
struct Deadlines {
    /// For a request's head, from when the server starts waiting for it: as
    /// soon as a connection is open, and again after each answer on it.
    head: Duration,
    /// For a body to get going, from when the server first asks for it.
    body_grace: Duration,
    /// Bytes a second a body has to have come at since, on average.
    body_rate: u64,
    /// The most time what has already come can buy. Without this a body
    /// sent almost whole could sit in memory for as long as it would have
    /// taken at `body_rate`, which for the largest there is comes to a day.
    body_longest: Duration,
}

impl Deadlines {
    /// When a body has to have sent more, given what it sent so far.
    fn body_due(&self, started: Instant, received: u64) -> Instant {
        let earned = Duration::from_millis(received.saturating_mul(1000) / self.body_rate);
        started + self.body_grace + earned.min(self.body_longest)
    }
}

/// Lenient to the slowest connection a phone still gets anywhere with. A
/// caller who sends less than this is either not there or wasting a file.
const DEADLINES: Deadlines = Deadlines {
    head: Duration::from_secs(30),
    body_grace: Duration::from_secs(30),
    body_rate: 1024,
    body_longest: Duration::from_secs(30 * 60),
};

/// Serve `router` on `listener` until `shutdown` resolves, then let what is
/// under way finish.
///
/// This is `axum::serve` with the deadlines it does not set. Going quiet
/// for too long is caught by [`CappedStream`]. A caller that keeps sending
/// a byte now and then is not quiet, and these catch it: a request has to
/// arrive in good time, head and body. HTTP/2 is not offered, because hyper
/// sets it no such deadline. A proxy in front speaks HTTP/1.1 to the server
/// whatever it speaks to clients.
pub async fn serve(listener: CappedListener, router: Router, shutdown: impl Future<Output = ()>) {
    serve_with(listener, router, shutdown, DEADLINES).await;
}

async fn serve_with(
    mut listener: CappedListener,
    router: Router,
    shutdown: impl Future<Output = ()>,
    deadlines: Deadlines,
) {
    let mut http = http1::Builder::new();
    http.timer(TokioTimer::new())
        .header_read_timeout(deadlines.head);
    // Every connection holds a receiver of `open`, so it is closed once the
    // last of them is.
    let (open, _) = watch::channel(());
    let (stop, stopping) = watch::channel(false);
    let mut shutdown = pin!(shutdown);
    loop {
        let (stream, address) = tokio::select! {
            accepted = listener.accept() => accepted,
            () = &mut shutdown => break,
        };
        let router = router.clone();
        let requests = service_fn(move |request: hyper::Request<Incoming>| {
            let mut request: Request = request.map(|body| Body::new(Paced::new(body, deadlines)));
            request.extensions_mut().insert(ConnectInfo(Peer(address)));
            router.clone().oneshot(request)
        });
        let connection = http
            .serve_connection(TokioIo::new(stream), requests)
            .with_upgrades();
        let held = open.subscribe();
        let mut stopping = stopping.clone();
        tokio::spawn(async move {
            let mut connection = pin!(connection);
            let stopped = async {
                let _ = stopping.wait_for(|stop| *stop).await;
            };
            tokio::select! {
                _ = connection.as_mut() => {}
                () = stopped => {
                    connection.as_mut().graceful_shutdown();
                    let _ = connection.await;
                }
            }
            drop(held);
        });
    }
    drop(listener);
    stop.send_replace(true);
    open.closed().await;
}

/// A request body that has to keep coming: after a grace period, at an
/// average rate since the server first asked for it. Averaged, so a fast
/// caller whose connection stalls has the time it saved to spare.
struct Paced<B> {
    body: B,
    deadlines: Deadlines,
    /// When the server first asked for the body.
    started: Option<Instant>,
    received: u64,
    /// Made the first time the body is waited for. Most come in one piece.
    check: Option<Pin<Box<Sleep>>>,
}

impl<B> Paced<B> {
    fn new(body: B, deadlines: Deadlines) -> Self {
        Self {
            body,
            deadlines,
            started: None,
            received: 0,
            check: None,
        }
    }
}

impl<B> http_body::Body for Paced<B>
where
    B: http_body::Body<Data = Bytes> + Unpin,
    B::Error: Into<BoxError>,
{
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        let this = self.get_mut();
        let started = *this.started.get_or_insert_with(Instant::now);
        match Pin::new(&mut this.body).poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(data) = frame.data_ref() {
                    this.received += data.len() as u64;
                }
                Poll::Ready(Some(Ok(frame)))
            }
            Poll::Ready(Some(Err(err))) => Poll::Ready(Some(Err(err.into()))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => {
                let due = this.deadlines.body_due(started, this.received);
                let check = this
                    .check
                    .get_or_insert_with(|| Box::pin(tokio::time::sleep_until(due)));
                check.as_mut().reset(due);
                if check.as_mut().poll(cx).is_ready() {
                    let late =
                        io::Error::new(io::ErrorKind::TimedOut, "the request body came too slowly");
                    return Poll::Ready(Some(Err(late.into())));
                }
                Poll::Pending
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.body.size_hint()
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

type Buckets<C, K> =
    governor::RateLimiter<K, DashMapStateStore<K>, C, NoOpMiddleware<<C as Clock>::Instant>>;

/// A token bucket per caller. The buckets are `governor`'s. Who a caller
/// is, is decided here: see [`ClientAddress`] and [`caller`], or an account
/// where the request is signed in, see [`AccountLimiter`].
pub struct RateLimiter<C: Clock = DefaultClock, K: Clone + Eq + Hash = IpAddr> {
    /// Nothing when limiting is off.
    buckets: Option<Buckets<C, K>>,
}

/// A [`RateLimiter`] that counts by account id.
pub type AccountLimiter = RateLimiter<DefaultClock, i64>;

impl<K: Clone + Eq + Hash> RateLimiter<DefaultClock, K> {
    /// `per_minute` of zero turns limiting off.
    pub fn new(per_minute: u32, burst: u32) -> Self {
        Self::with_clock(per_minute, burst, DefaultClock::default())
    }
}

impl<C: Clock> RateLimiter<C> {
    pub fn allow(&self, address: IpAddr) -> bool {
        self.allow_key(&caller(address))
    }
}

impl<C: Clock, K: Clone + Eq + Hash> RateLimiter<C, K> {
    fn with_clock(per_minute: u32, burst: u32, clock: C) -> Self {
        let buckets = NonZeroU32::new(per_minute).map(|rate| {
            let burst = NonZeroU32::new(burst).unwrap_or(NonZeroU32::MIN);
            let quota = Quota::per_minute(rate).allow_burst(burst);
            governor::RateLimiter::dashmap_with_clock(quota, clock)
        });
        Self { buckets }
    }

    pub fn allow_key(&self, key: &K) -> bool {
        match &self.buckets {
            Some(buckets) => buckets.check_key(key).is_ok(),
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
/// two rounds a limiter remembers one entry for each caller that tried, and
/// a caller is an address the connection caps have let in or an account.
const FORGET_IDLE_EVERY: Duration = Duration::from_secs(60);

/// Keep what the limiters remember to the callers they are holding back,
/// for as long as the process runs.
pub fn forget_idle_callers(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(FORGET_IDLE_EVERY);
        loop {
            tick.tick().await;
            state.auth_limiter.forget_idle();
            state.lookup_limiter.forget_idle();
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
    fn a_permit_can_grow_and_gives_everything_back_at_once() {
        let gate = Gate::new(10, 15);
        let mut first = gate.holding_nothing(ip("203.0.113.5"));
        assert!(first.take(8));
        // All of it or none, and nothing is left held by trying.
        assert!(!first.take(3));
        assert!(first.take(2));
        // Someone else has what is left of the total, and no more.
        let mut other = gate.holding_nothing(ip("203.0.113.6"));
        assert!(!other.take(6));
        assert!(other.take(5));

        drop(first);
        let mut again = gate.holding_nothing(ip("203.0.113.5"));
        assert!(again.take(10));
    }

    #[test]
    fn a_response_ends_up_holding_what_it_weighs() {
        const LARGE: usize = SMALL_RESPONSE_BYTES + 1;
        let gate = Gate::new(0, 3 * LARGE);
        let room = ResponseRoom(Arc::new(Mutex::new(
            gate.holding_nothing(ip("203.0.113.5")),
        )));
        let held = || gate.open.lock().unwrap().total;

        room.take(2 * LARGE as i64).unwrap();
        assert_eq!(held(), 2 * LARGE);
        // Not all of what was taken for was in the end.
        assert!(room.settle(LARGE));
        assert_eq!(held(), LARGE);
        // A response may also come out larger than what was taken for it.
        assert!(room.settle(3 * LARGE));
        assert_eq!(held(), 3 * LARGE);
        assert!(!room.settle(3 * LARGE + 1));
        assert_eq!(held(), 3 * LARGE);

        // Small ones are not counted, and get through with the room full.
        room.take(SMALL_RESPONSE_BYTES as i64).unwrap();
        assert_eq!(held(), 3 * LARGE);
        let refused = room.take(LARGE as i64).unwrap_err().into_response();
        assert_eq!(refused.status(), StatusCode::SERVICE_UNAVAILABLE);

        drop(room);
        assert_eq!(held(), 0);
        assert!(gate.open.lock().unwrap().by_caller.is_empty());
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

    async fn connection_with(patience: Patience) -> (CappedStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (server, _) = listener.accept().await.unwrap();
        let permit = Gate::new(0, 0).enter_shared().unwrap();
        (CappedStream::with(server, permit, QUIET, patience), client)
    }

    async fn connection() -> (CappedStream, TcpStream) {
        connection_with(PATIENCE).await
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

    /// Talking keeps a connection from going quiet, and reading only now and
    /// then keeps it from going quiet too. Neither gets a client out of
    /// taking what it asked for, or a response would stay in memory for as
    /// long as it liked.
    #[tokio::test]
    async fn a_client_that_keeps_talking_and_takes_nothing_is_cut_off() {
        let (mut server, mut client) = connection_with(Patience {
            grace: QUIET,
            rate: 1024 * 1024 * 1024,
            longest: QUIET,
        })
        .await;
        tokio::spawn(async move {
            while client.write_all(b"x").await.is_ok() {
                tokio::time::sleep(QUIET / 3).await;
            }
        });
        let chunk = vec![0u8; 1024 * 1024];
        let mut heard = [0u8; 8];
        // The way the connection's task does it, reading and writing in turn.
        let writing = std::future::poll_fn(|cx| {
            let mut read = ReadBuf::new(&mut heard);
            if let Poll::Ready(Err(err)) = Pin::new(&mut server).poll_read(cx, &mut read) {
                return Poll::Ready(err);
            }
            match Pin::new(&mut server).poll_write(cx, &chunk) {
                Poll::Ready(Err(err)) => Poll::Ready(err),
                Poll::Ready(Ok(_)) => {
                    cx.waker().wake_by_ref();
                    Poll::Pending
                }
                Poll::Pending => Poll::Pending,
            }
        });
        let failed = tokio::time::timeout(Duration::from_secs(10), writing)
            .await
            .expect("the client was never cut off");
        assert_eq!(failed.kind(), io::ErrorKind::TimedOut);
    }

    /// What a client takes pays for the time it takes, so a large response
    /// to a client that keeps reading goes out however long it runs.
    #[tokio::test]
    async fn a_client_that_keeps_taking_is_not_cut_off() {
        let (mut server, mut client) = connection_with(Patience {
            grace: Duration::from_millis(100),
            rate: 1024 * 1024,
            longest: Duration::from_millis(500),
        })
        .await;
        const SENT: usize = 8 * 1024 * 1024;
        let reader = tokio::spawn(async move {
            let mut taken = 0;
            let mut buffer = vec![0u8; 256 * 1024];
            while taken < SENT {
                let got = client.read(&mut buffer).await.unwrap();
                assert!(got > 0, "the connection was closed");
                taken += got;
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        });
        server.write_all(&vec![0u8; SENT]).await.unwrap();
        tokio::time::timeout(Duration::from_secs(10), reader)
            .await
            .expect("the client never got it all")
            .unwrap();
    }
}

#[cfg(test)]
mod serve_tests {
    use axum::routing::{get, post};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    const SOON: Deadlines = Deadlines {
        head: Duration::from_millis(400),
        body_grace: Duration::from_millis(400),
        body_rate: 1000,
        body_longest: Duration::from_secs(5),
    };

    #[tokio::test]
    async fn what_a_body_sent_buys_only_so_much_time() {
        let started = Instant::now();
        let due = |received| DEADLINES.body_due(started, received) - started;
        assert_eq!(due(0), DEADLINES.body_grace);
        assert_eq!(
            due(60 * 1024),
            DEADLINES.body_grace + Duration::from_secs(60)
        );
        // At the slowest it may come, this much would buy most of a day.
        assert_eq!(
            due(75 * 1024 * 1024),
            DEADLINES.body_grace + DEADLINES.body_longest
        );
    }

    /// A server with `SOON` for deadlines, and what stops it.
    async fn server() -> (
        SocketAddr,
        tokio::sync::oneshot::Sender<()>,
        tokio::task::JoinHandle<()>,
    ) {
        let router = Router::new().route("/", get(|| async { "ok" })).route(
            "/upload",
            post(|body: Bytes| async move { body.len().to_string() }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let listener = CappedListener::new(listener, Gate::new(0, 0), Vec::new());
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let shutdown = async {
            let _ = stopped.await;
        };
        let served = tokio::spawn(serve_with(listener, router, shutdown, SOON));
        (address, stop, served)
    }

    /// Send `parts` a pause apart, and return everything that comes back
    /// before the server closes the connection, and when it did.
    async fn trickle(address: SocketAddr, parts: &[&[u8]], pause: Duration) -> (String, Duration) {
        let mut stream = TcpStream::connect(address).await.unwrap();
        let started = Instant::now();
        let (mut reader, mut writer) = stream.split();
        let writes = async {
            for part in parts {
                if writer.write_all(part).await.is_err() {
                    return;
                }
                tokio::time::sleep(pause).await;
            }
            // Then sit and wait to be thrown out.
            std::future::pending::<()>().await;
        };
        let mut answer = Vec::new();
        let reads = async {
            let _ = reader.read_to_end(&mut answer).await;
        };
        let closed = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::select! {
                () = writes => {}
                () = reads => {}
            }
        });
        closed.await.expect("the connection was never closed");
        (
            String::from_utf8_lossy(&answer).into_owned(),
            started.elapsed(),
        )
    }

    #[tokio::test]
    async fn a_head_sent_a_line_at_a_time_runs_out_of_time() {
        let (address, _stop, _) = server().await;
        let mut parts: Vec<&[u8]> = vec![b"GET / HTTP/1.1\r\nHost: x\r\n"];
        parts.extend(std::iter::repeat_n(b"X-Slow: y\r\n".as_slice(), 50));
        let (answer, took) = trickle(address, &parts, Duration::from_millis(100)).await;
        assert!(!answer.contains("200 OK"), "{answer}");
        assert!(took < Duration::from_secs(2), "open for {took:?}");
    }

    #[tokio::test]
    async fn a_kept_connection_has_as_long_for_its_next_request() {
        let (address, _stop, _) = server().await;
        let request: &[u8] = b"GET / HTTP/1.1\r\nHost: x\r\n\r\n";
        let (answer, took) = trickle(address, &[request], Duration::ZERO).await;
        assert!(answer.starts_with("HTTP/1.1 200 OK"), "{answer}");
        assert!(
            took >= SOON.head && took < Duration::from_secs(2),
            "open for {took:?}"
        );
    }

    #[tokio::test]
    async fn a_body_that_dawdles_is_refused() {
        let (address, _stop, _) = server().await;
        let mut parts: Vec<&[u8]> =
            vec![b"POST /upload HTTP/1.1\r\nHost: x\r\nContent-Length: 10000\r\n\r\n"];
        // A hundred bytes a second, against a thousand asked for.
        parts.extend(std::iter::repeat_n([b'x'; 10].as_slice(), 100));
        let (answer, took) = trickle(address, &parts, Duration::from_millis(100)).await;
        assert!(!answer.contains("200 OK"), "{answer}");
        assert!(took < Duration::from_secs(2), "open for {took:?}");
    }

    #[tokio::test]
    async fn a_body_at_a_fair_pace_gets_through() {
        let (address, _stop, _) = server().await;
        let mut parts: Vec<&[u8]> =
            vec![b"POST /upload HTTP/1.1\r\nHost: x\r\nContent-Length: 2000\r\n\r\n"];
        // Two thousand bytes a second, over a second in all.
        parts.extend(std::iter::repeat_n([b'x'; 100].as_slice(), 20));
        let (answer, _) = trickle(address, &parts, Duration::from_millis(50)).await;
        assert!(answer.starts_with("HTTP/1.1 200 OK"), "{answer}");
        assert!(answer.ends_with("2000"), "{answer}");
    }

    #[tokio::test]
    async fn stopping_lets_the_request_under_way_finish() {
        let (address, stop, served) = server().await;
        let mut stream = TcpStream::connect(address).await.unwrap();
        stream
            .write_all(b"POST /upload HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\n\r\nab")
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        stop.send(()).unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!served.is_finished());
        stream.write_all(b"cd").await.unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).await.unwrap();
        assert!(answer.starts_with("HTTP/1.1 200 OK"), "{answer}");
        tokio::time::timeout(Duration::from_secs(2), served)
            .await
            .expect("still serving after the last request")
            .unwrap();
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
