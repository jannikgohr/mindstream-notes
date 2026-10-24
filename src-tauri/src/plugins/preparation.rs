//! Bounded, serial compilation of approved packages. Never executes a guest.
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex, OnceLock};

use super::{discovery::DiscoveredPlugin, discovery::PluginFiles, precompiled, runtime};

type Key = ([u8; 32], PathBuf);
struct Job {
    key: Key,
    // Keeps an installed generation alive until preparation finishes.
    plugin: DiscoveredPlugin,
}
struct Worker {
    sender: mpsc::SyncSender<Job>,
    pending: Arc<Mutex<HashSet<Key>>>,
}

pub(super) fn schedule(plugin: DiscoveredPlugin, cache: PathBuf) {
    let Some(component) = plugin.entry_bytes.as_ref() else {
        return;
    };
    static WORKER: OnceLock<Option<Worker>> = OnceLock::new();
    let Some(worker) = WORKER.get_or_init(|| {
        let (sender, receiver) = mpsc::sync_channel::<Job>(8);
        let pending = Arc::new(Mutex::new(HashSet::new()));
        let active = pending.clone();
        std::thread::Builder::new()
            .name("plugin-prepare".into())
            .spawn(move || {
                while let Ok(job) = receiver.recv() {
                    let component = job
                        .plugin
                        .entry_bytes
                        .as_ref()
                        .expect("Wasm preparation job");
                    let bundled = matches!(job.plugin.files, PluginFiles::Embedded(_))
                        .then(|| precompiled::find(component))
                        .flatten();
                    let result = runtime::wasm::WasmRuntime::global().and_then(|runtime| {
                        runtime.prepare_component(component, Some(&job.key.1), bundled.as_ref())
                    });
                    if let Err(error) = result {
                        log::warn!("[plugins] preparation of {}: {error}", job.plugin.id);
                    }
                    active
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(&job.key);
                }
            })
            .ok()?;
        Some(Worker { sender, pending })
    }) else {
        return;
    };
    let key = (component.digest(), cache);
    let mut pending = worker.pending.lock().unwrap_or_else(|e| e.into_inner());
    if pending.insert(key.clone())
        && worker
            .sender
            .try_send(Job {
                key: key.clone(),
                plugin,
            })
            .is_err()
    {
        // A full queue is harmless: the call path still prepares on demand.
        pending.remove(&key);
    }
}
