//! Root coordinator election and bounded authenticated loopback IPC. Endpoint
//! files survive exit/crashes and are replaced only by the next OS-lock owner.
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::aead::{KeyInit, OsRng};
use chacha20poly1305::ChaCha20Poly1305;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::storage_locks::RootLock;

const ENDPOINT: &str = "coordinator-endpoint.json";
const MAX_FRAME: usize = 64 * 1024;
const SOCKET_TIMEOUT: Duration = Duration::from_secs(2);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CONNECTIONS: usize = 16;

// Do not derive Debug: the endpoint/wire contain a credential, not diagnostics.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Endpoint {
    version: u32,
    address: SocketAddr,
    instance: Uuid,
    secret: String,
    // Activation metadata only. OS locks and authenticated identity determine
    // ownership; this PID must never participate in stale-owner decisions.
    #[serde(default)]
    process_id: Option<u32>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Wire {
    version: u32,
    secret: String,
    request: Request,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub id: Uuid,
    pub payload: Value,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    version: u32,
    instance: Uuid,
    id: Uuid,
    result: Result<Value, String>,
}

fn unavailable() -> AppError {
    AppError::InvalidArg("app coordinator is unavailable; ownership was not taken over".into())
}

fn validate_endpoint(endpoint: &Endpoint) -> AppResult<()> {
    if endpoint.version != 1
        || endpoint.address.ip() != std::net::IpAddr::V4(Ipv4Addr::LOCALHOST)
        || endpoint.address.port() == 0
        || endpoint
            .process_id
            .is_some_and(|id| id == 0 || id == u32::MAX)
        || endpoint.secret.len() != 44
        || STANDARD
            .decode(&endpoint.secret)
            .map_err(|_| unavailable())?
            .len()
            != 32
    {
        return Err(unavailable());
    }
    Ok(())
}

pub struct Coordinator {
    _ownership: Option<Arc<File>>,
    listener: TcpListener,
    endpoint: Endpoint,
}

pub enum Election {
    Owner(Coordinator),
    Existing,
}

pub fn elect(root: &Path) -> AppResult<Election> {
    fs::create_dir_all(root)?;
    let ownership = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join(".coordinator.lock"))?;
    match ownership.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => return Ok(Election::Existing),
        Err(TryLockError::Error(err)) => return Err(err.into()),
    }
    let mut coordinator = Coordinator::bind()?;
    coordinator._ownership = Some(Arc::new(ownership));
    let raw = serde_json::to_vec(&coordinator.endpoint).map_err(|_| unavailable())?;
    let _lock = RootLock::acquire(root)?;
    crate::atomic_file::write_private(&root.join(ENDPOINT), &raw)?;
    Ok(Election::Owner(coordinator))
}

fn remaining(deadline: Instant) -> AppResult<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|time| !time.is_zero())
        .ok_or_else(unavailable)
}

fn read_bytes(stream: &mut TcpStream, mut bytes: &mut [u8], deadline: Instant) -> AppResult<()> {
    while !bytes.is_empty() {
        stream.set_read_timeout(Some(remaining(deadline)?))?;
        match stream.read(bytes) {
            Ok(0) => return Err(unavailable()),
            Ok(count) => bytes = &mut bytes[count..],
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {}
            Err(err) => return Err(err.into()),
        }
    }
    Ok(())
}

fn write_bytes(stream: &mut TcpStream, mut bytes: &[u8], deadline: Instant) -> AppResult<()> {
    while !bytes.is_empty() {
        stream.set_write_timeout(Some(remaining(deadline)?))?;
        match stream.write(bytes) {
            Ok(0) => return Err(unavailable()),
            Ok(count) => bytes = &bytes[count..],
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {}
            Err(err) => return Err(err.into()),
        }
    }
    Ok(())
}

fn read_frame<T: for<'de> Deserialize<'de>>(
    stream: &mut TcpStream,
    deadline: Instant,
) -> AppResult<T> {
    let mut length = [0u8; 4];
    read_bytes(stream, &mut length, deadline)?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err(unavailable());
    }
    let mut bytes = vec![0; length];
    read_bytes(stream, &mut bytes, deadline)?;
    serde_json::from_slice(&bytes).map_err(|_| unavailable())
}

fn write_frame<T: Serialize>(
    stream: &mut TcpStream,
    value: &T,
    deadline: Instant,
) -> AppResult<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| unavailable())?;
    if bytes.is_empty() || bytes.len() > MAX_FRAME {
        return Err(unavailable());
    }
    write_bytes(stream, &(bytes.len() as u32).to_be_bytes(), deadline)?;
    write_bytes(stream, &bytes, deadline)?;
    Ok(())
}

fn socket_options(stream: &TcpStream) -> AppResult<()> {
    stream.set_read_timeout(Some(SOCKET_TIMEOUT))?;
    stream.set_write_timeout(Some(SOCKET_TIMEOUT))?;
    stream.set_nodelay(true)?;
    Ok(())
}

impl Endpoint {
    pub fn activation_process_id(&self) -> Option<u32> {
        self.process_id.filter(|id| *id != 0 && *id != u32::MAX)
    }
    pub fn instance(&self) -> Uuid {
        self.instance
    }

    pub fn read(root: &Path) -> AppResult<Self> {
        // Bound the actual read, including growth/replacement during discovery.
        let mut raw = Vec::new();
        File::open(root.join(ENDPOINT))?
            .take(4097)
            .read_to_end(&mut raw)?;
        if raw.len() > 4096 {
            return Err(unavailable());
        }
        let endpoint: Self = serde_json::from_slice(&raw).map_err(|_| unavailable())?;
        validate_endpoint(&endpoint)?;
        Ok(endpoint)
    }

    pub(crate) fn validate(&self) -> AppResult<()> {
        validate_endpoint(self)
    }

    pub fn call(&self, request: &Request) -> AppResult<Result<Value, String>> {
        self.call_until(request, Instant::now() + SOCKET_TIMEOUT)
    }

    /// Retry transient transport failure against the same authenticated
    /// instance. Preserve the operation ID; an explicit rejection is final.
    pub fn retry_call(&self, request: &Request) -> AppResult<Result<Value, String>> {
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        loop {
            if let Ok(reply) =
                self.call_until(request, deadline.min(Instant::now() + SOCKET_TIMEOUT))
            {
                return Ok(reply);
            }
            if Instant::now() >= deadline {
                return Err(unavailable());
            }
            thread::sleep(Duration::from_millis(40));
        }
    }

    fn call_until(&self, request: &Request, deadline: Instant) -> AppResult<Result<Value, String>> {
        validate_endpoint(self)?;
        let mut stream = TcpStream::connect_timeout(&self.address, remaining(deadline)?)?;
        socket_options(&stream)?;
        write_frame(
            &mut stream,
            &Wire {
                version: 1,
                secret: self.secret.clone(),
                request: request.clone(),
            },
            deadline,
        )?;
        let reply: Reply = read_frame(&mut stream, deadline)?;
        if reply.version != 1 || reply.instance != self.instance || reply.id != request.id {
            return Err(unavailable());
        }
        Ok(reply.result)
    }
}

/// Retain the operation ID across retries. The dispatcher must deduplicate
/// mutations by this ID; transport failure does not prove a request was unapplied.
pub fn request(root: &Path, request: &Request) -> AppResult<Result<Value, String>> {
    request_with_endpoint(root, request).map(|(_, reply)| reply)
}

/// Return the endpoint that actually authenticated and correlated the reply,
/// so foreground transfer never trusts discovery-file presence alone.
pub fn request_with_endpoint(
    root: &Path,
    request: &Request,
) -> AppResult<(Endpoint, Result<Value, String>)> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    loop {
        if let Ok(endpoint) = Endpoint::read(root) {
            if let Ok(reply) =
                endpoint.call_until(request, deadline.min(Instant::now() + SOCKET_TIMEOUT))
            {
                return Ok((endpoint, reply));
            }
        }
        if Instant::now() >= deadline {
            return Err(unavailable());
        }
        thread::sleep(Duration::from_millis(40));
    }
}

pub struct Running {
    // Keep the host's lease even if its listener unexpectedly stops. A network
    // failure cannot let another live host duplicate tray/shortcut ownership.
    _ownership: Option<Arc<File>>,
    stopping: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Running {
    /// Call during controlled shutdown/test cleanup, outside the UI thread.
    pub fn stop(mut self) {
        self.stopping.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
    }
}

impl Coordinator {
    fn bind() -> AppResult<Self> {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let key = ChaCha20Poly1305::generate_key(&mut OsRng);
        let endpoint = Endpoint {
            version: 1,
            address: listener.local_addr()?,
            instance: Uuid::new_v4(),
            secret: STANDARD.encode(key),
            process_id: Some(std::process::id()),
        };
        Ok(Self {
            _ownership: None,
            listener,
            endpoint,
        })
    }

    /// Worker replies use their own listener and retain the physical vault
    /// lease until accepted calls finish; its endpoint is registered over root
    /// IPC rather than overwriting the coordinator's endpoint document.
    pub fn for_worker(ownership: &crate::storage_locks::VaultLock) -> AppResult<Self> {
        let mut coordinator = Self::bind()?;
        coordinator._ownership = Some(ownership.retain_lease());
        Ok(coordinator)
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    /// The handler must queue UI work and return promptly. At most 16 incoming
    /// frames are processed at once; slow/malformed peers get bounded sockets.
    /// Election ownership stays in this thread until every accepted call exits.
    pub fn serve(
        self,
        handler: impl Fn(Request) -> Result<Value, String> + Send + Sync + 'static,
    ) -> AppResult<Running> {
        let stopping = Arc::new(AtomicBool::new(false));
        let ownership = self._ownership.clone();
        let signal = stopping.clone();
        let handler = Arc::new(handler);
        let thread = thread::Builder::new()
            .name("vault-coordinator-ipc".into())
            .spawn(move || {
                let active = Arc::new(AtomicUsize::new(0));
                let mut connections: Vec<JoinHandle<()>> = Vec::new();
                while !signal.load(Ordering::Acquire) {
                    match self.listener.accept() {
                        Ok((mut stream, peer)) => {
                            if !peer.ip().is_loopback()
                                || active.load(Ordering::Acquire) >= MAX_CONNECTIONS
                            {
                                continue;
                            }
                            let endpoint = self.endpoint.clone();
                            let handler = handler.clone();
                            let count = active.clone();
                            count.fetch_add(1, Ordering::AcqRel);
                            let worker = thread::Builder::new()
                                .name("vault-ipc-request".into())
                                .spawn(move || {
                                    struct Active(Arc<AtomicUsize>);
                                    impl Drop for Active {
                                        fn drop(&mut self) {
                                            self.0.fetch_sub(1, Ordering::AcqRel);
                                        }
                                    }
                                    let _active = Active(count);
                                    let result = (|| -> AppResult<()> {
                                        socket_options(&stream)?;
                                        let deadline = Instant::now() + SOCKET_TIMEOUT;
                                        let wire: Wire = read_frame(&mut stream, deadline)?;
                                        if wire.version != 1 || wire.secret != endpoint.secret {
                                            return Err(unavailable());
                                        }
                                        let id = wire.request.id;
                                        let result = handler(wire.request);
                                        write_frame(
                                            &mut stream,
                                            &Reply {
                                                version: 1,
                                                instance: endpoint.instance,
                                                id,
                                                result,
                                            },
                                            deadline,
                                        )
                                    })();
                                    // No credentials, payloads or malformed peer bytes in logs.
                                    let _ = result;
                                });
                            match worker {
                                Ok(worker) => connections.push(worker),
                                Err(_) => {
                                    active.fetch_sub(1, Ordering::AcqRel);
                                }
                            }
                        }
                        Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(20))
                        }
                        Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                    // Prune completed calls so normal use cannot grow the handle list.
                    let mut i = 0;
                    while i < connections.len() {
                        if connections[i].is_finished() {
                            let _ = connections.swap_remove(i).join();
                        } else {
                            i += 1;
                        }
                    }
                }
                for connection in connections {
                    let _ = connection.join();
                }
                // Explicit drop keeps the OS lease through accepted request shutdown.
                drop(self);
            })?;
        Ok(Running {
            _ownership: ownership,
            stopping,
            thread: Some(thread),
        })
    }
}

#[cfg(test)]
mod tests;
