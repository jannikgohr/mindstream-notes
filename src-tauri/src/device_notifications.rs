//! Bounded invalidation delivery. Root documents and vault data stay off the wire.
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde_json::json;
use uuid::Uuid;

use crate::coordinator_ipc::{Endpoint, Request};

#[derive(Default)]
pub(crate) struct Notifications {
    generation: AtomicU64,
    running: AtomicBool,
}

impl Notifications {
    pub fn changed(&self, targets: impl Fn() -> Vec<(Uuid, Endpoint)>) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        if self.running.swap(true, Ordering::AcqRel) {
            return;
        }
        loop {
            let generation = self.generation.load(Ordering::Acquire);
            deliver(&targets());
            if self.generation.load(Ordering::Acquire) != generation {
                continue;
            }
            self.running.store(false, Ordering::Release);
            // A change can arrive while ownership is released. Either this
            // thread takes it or the new caller already owns delivery.
            if self.generation.load(Ordering::Acquire) == generation
                || self
                    .running
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_err()
            {
                return;
            }
        }
    }
}

fn deliver(targets: &[(Uuid, Endpoint)]) {
    for group in targets.chunks(8) {
        std::thread::scope(|scope| {
            let mut jobs = Vec::new();
            for (launch_id, endpoint) in group {
                let request = Request {
                    id: Uuid::new_v4(),
                    payload: json!({"command":"refreshDeviceSettings","launch_id":launch_id}),
                };
                match std::thread::Builder::new()
                    .name("device-settings-refresh".into())
                    .spawn_scoped(scope, move || {
                        if !matches!(endpoint.retry_call(&request), Ok(Ok(_))) {
                            log::warn!("[vaults] a worker could not refresh device settings");
                        }
                    }) {
                    Ok(job) => jobs.push(job),
                    Err(_) => log::warn!("[vaults] device settings refresh thread unavailable"),
                }
            }
            for job in jobs {
                if job.join().is_err() {
                    log::warn!("[vaults] device settings refresh failed");
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{coordinator_ipc::Coordinator, storage_locks::VaultLock};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;

    #[test]
    fn healthy_peer_is_not_blocked_and_changes_during_delivery_are_coalesced() {
        let root = std::env::temp_dir().join(format!("ms-device-notify-{}", Uuid::new_v4()));
        let slow_owner = VaultLock::acquire(&root.join("slow")).unwrap();
        let healthy_owner = VaultLock::acquire(&root.join("healthy")).unwrap();
        let slow = Coordinator::for_worker(&slow_owner).unwrap();
        let healthy = Coordinator::for_worker(&healthy_owner).unwrap();
        let slow_id = Uuid::new_v4();
        let healthy_id = Uuid::new_v4();
        let targets = vec![
            (slow_id, slow.endpoint().clone()),
            (healthy_id, healthy.endpoint().clone()),
        ];
        let (started, started_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let calls = AtomicU64::new(0);
        let slow_server = slow
            .serve(move |request| {
                assert_eq!(
                    request.payload,
                    json!({"command":"refreshDeviceSettings","launch_id":slow_id})
                );
                if calls.fetch_add(1, Ordering::Relaxed) == 0 {
                    started.send(()).unwrap();
                    release_rx
                        .lock()
                        .unwrap()
                        .recv_timeout(Duration::from_secs(3))
                        .unwrap();
                }
                Ok(json!({"accepted":true}))
            })
            .unwrap();
        let (delivered, delivered_rx) = mpsc::channel();
        let healthy_server = healthy
            .serve(move |request| {
                assert_eq!(
                    request.payload,
                    json!({"command":"refreshDeviceSettings","launch_id":healthy_id})
                );
                delivered.send(()).unwrap();
                Ok(json!({"accepted":true}))
            })
            .unwrap();
        let notifications = Arc::new(Notifications::default());
        let owner = notifications.clone();
        let snapshots = Arc::new(AtomicU64::new(0));
        let snapshot_count = snapshots.clone();
        let delivery = std::thread::spawn(move || {
            owner.changed(|| {
                snapshot_count.fetch_add(1, Ordering::Relaxed);
                targets.clone()
            })
        });
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        // This arrives while slow still owns its pending response.
        delivered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        for _ in 0..20 {
            notifications.changed(|| panic!("a second fanout must not start"));
        }
        release.send(()).unwrap();
        delivery.join().unwrap();
        assert_eq!(snapshots.load(Ordering::Relaxed), 2);
        delivered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(delivered_rx.try_recv().is_err());
        assert!(!notifications.running.load(Ordering::Acquire));
        drop(slow_server);
        drop(healthy_server);
        drop(slow_owner);
        drop(healthy_owner);
        std::fs::remove_dir_all(root).unwrap();
    }
}
