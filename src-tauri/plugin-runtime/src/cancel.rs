//! Stopping a plugin call from outside it.
//!
//! A call checks its token wherever it already waits or polls: the Wasm epoch
//! callback, the Luau interrupt hook, and the loop that waits for a native
//! tool. Cancelling is therefore prompt, around 10 ms, including in the middle
//! of a long native tool run, which the token kills.
//!
//! [`Registry`] is how the host finds the calls to cancel when a plugin is
//! disabled, removed or replaced while one of its calls is still running.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Shared "stop now" flag for one call.
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// The calls currently running, by plugin id.
#[derive(Debug, Default)]
pub struct Registry {
    next: AtomicU64,
    running: Mutex<BTreeMap<String, Vec<(u64, CancelToken)>>>,
}

/// Keeps one call registered while it runs. Dropping it unregisters the call.
#[derive(Debug)]
pub struct Registration<'a> {
    registry: &'a Registry,
    plugin_id: String,
    id: u64,
    token: CancelToken,
}

impl Registration<'_> {
    pub fn token(&self) -> &CancelToken {
        &self.token
    }
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        let mut running = self
            .registry
            .running
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(calls) = running.get_mut(&self.plugin_id) {
            calls.retain(|(id, _)| *id != self.id);
            if calls.is_empty() {
                running.remove(&self.plugin_id);
            }
        }
    }
}

impl Registry {
    pub const fn new() -> Self {
        Self {
            next: AtomicU64::new(0),
            running: Mutex::new(BTreeMap::new()),
        }
    }

    /// Register a call for `plugin_id` and hand back its token.
    pub fn register(&self, plugin_id: &str) -> Registration<'_> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let token = CancelToken::new();
        self.running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(plugin_id.to_string())
            .or_default()
            .push((id, token.clone()));
        Registration {
            registry: self,
            plugin_id: plugin_id.to_string(),
            id,
            token,
        }
    }

    /// Cancel every running call of one plugin. Returns how many there were.
    pub fn cancel_plugin(&self, plugin_id: &str) -> usize {
        let running = self.running.lock().unwrap_or_else(|e| e.into_inner());
        let calls = running
            .get(plugin_id)
            .map(Vec::as_slice)
            .unwrap_or_default();
        for (_, token) in calls {
            token.cancel();
        }
        calls.len()
    }

    /// Cancel every running call of every plugin.
    pub fn cancel_all(&self) -> usize {
        let running = self.running.lock().unwrap_or_else(|e| e.into_inner());
        let mut count = 0;
        for (_, token) in running.values().flatten() {
            token.cancel();
            count += 1;
        }
        count
    }

    /// How many calls of `plugin_id` are running.
    pub fn running(&self, plugin_id: &str) -> usize {
        self.running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(plugin_id)
            .map_or(0, Vec::len)
    }
}

/// The registry the app uses for every plugin call.
pub static CALLS: Registry = Registry::new();

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_starts_live_and_stays_cancelled() {
        let token = CancelToken::new();
        let copy = token.clone();
        assert!(!token.is_cancelled());
        copy.cancel();
        assert!(token.is_cancelled());
    }

    #[test]
    fn cancelling_a_plugin_reaches_only_its_calls() {
        let registry = Registry::new();
        let a1 = registry.register("com.a");
        let a2 = registry.register("com.a");
        let b = registry.register("com.b");
        assert_eq!(registry.running("com.a"), 2);

        assert_eq!(registry.cancel_plugin("com.a"), 2);
        assert!(a1.token().is_cancelled());
        assert!(a2.token().is_cancelled());
        assert!(!b.token().is_cancelled());
        assert_eq!(registry.cancel_plugin("com.missing"), 0);
    }

    #[test]
    fn finished_calls_unregister_themselves() {
        let registry = Registry::new();
        {
            let _call = registry.register("com.a");
            assert_eq!(registry.running("com.a"), 1);
        }
        assert_eq!(registry.running("com.a"), 0);
        // A call that starts after a cancellation is not affected by it.
        registry.cancel_plugin("com.a");
        let later = registry.register("com.a");
        assert!(!later.token().is_cancelled());
    }

    #[test]
    fn cancel_all_reaches_every_plugin() {
        let registry = Registry::new();
        let a = registry.register("com.a");
        let b = registry.register("com.b");
        assert_eq!(registry.cancel_all(), 2);
        assert!(a.token().is_cancelled() && b.token().is_cancelled());
    }
}
