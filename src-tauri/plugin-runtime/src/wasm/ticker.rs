//! The clock that lets a running guest be stopped.
//!
//! Wasmtime checks an "epoch" counter at function entries and loop back-edges
//! and calls back into the host when it passes a store's deadline. Nothing
//! advances it on its own: this ticker does, on one thread, every [`TICK`]
//! while at least one call is running, and parks while none is, so an idle
//! app pays nothing for it.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::Thread;
use std::time::Duration;

use wasmtime::Engine;

/// How often a running guest is checked. It bounds how far past its deadline
/// or a cancellation a guest can run.
pub const TICK: Duration = Duration::from_millis(5);

#[derive(Debug)]
struct Shared {
    active: AtomicUsize,
}

#[derive(Debug)]
pub struct Ticker {
    shared: Arc<Shared>,
    thread: Thread,
}

/// Keeps the ticker running while a call is in progress.
#[derive(Debug)]
pub struct Running<'a> {
    ticker: &'a Ticker,
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.ticker.shared.active.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Ticker {
    /// Start the ticker thread for `engine`. It exits when the engine is
    /// dropped.
    pub fn start(engine: &Engine) -> std::io::Result<Self> {
        let weak = engine.weak();
        let shared = Arc::new(Shared {
            active: AtomicUsize::new(0),
        });
        let worker = shared.clone();
        let handle = std::thread::Builder::new()
            .name("plugin-epoch".into())
            .spawn(move || loop {
                if worker.active.load(Ordering::SeqCst) == 0 {
                    // Spurious wakeups just go round the loop again.
                    std::thread::park_timeout(Duration::from_secs(60));
                    if weak.upgrade().is_none() {
                        return;
                    }
                    continue;
                }
                std::thread::sleep(TICK);
                match weak.upgrade() {
                    Some(engine) => engine.increment_epoch(),
                    None => return,
                }
            })?;
        Ok(Self {
            shared,
            thread: handle.thread().clone(),
        })
    }

    /// Mark a call as running until the returned guard is dropped.
    pub fn enter(&self) -> Running<'_> {
        self.shared.active.fetch_add(1, Ordering::SeqCst);
        self.thread.unpark();
        Running { ticker: self }
    }

    pub fn running(&self) -> usize {
        self.shared.active.load(Ordering::SeqCst)
    }
}
