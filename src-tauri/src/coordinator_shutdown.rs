//! Graceful close waits for ownership evidence, never socket failure or a PID.
use std::time::{Duration, Instant};

use serde_json::json;
use uuid::Uuid;

use crate::coordinator_ipc::{Endpoint, Request};
use crate::error::{AppError, AppResult};
use crate::worker_shutdown::CloseProgress;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Owner {
    Present,
    Released,
    Changed,
}

pub(crate) fn close(
    endpoint: &Endpoint,
    launch_id: Uuid,
    operation_id: Uuid,
    deadline: Instant,
    ownership: impl Fn() -> AppResult<Owner>,
) -> AppResult<()> {
    let request = Request {
        id: operation_id,
        payload: json!({"command":"close","launch_id":launch_id}),
    };
    let mut accepted = false;
    loop {
        match ownership()? {
            Owner::Released => return Ok(()),
            Owner::Changed => {
                return Err(AppError::InvalidArg(
                    "vault ownership changed during quit".into(),
                ))
            }
            Owner::Present => {}
        }
        if Instant::now() >= deadline {
            return Err(AppError::InvalidArg(
                "vault still owns its files and could not finish closing".into(),
            ));
        }
        if !accepted {
            match endpoint.retry_call(&request) {
                Ok(Ok(_)) => accepted = true,
                Ok(Err(message)) => return Err(AppError::InvalidArg(message)),
                Err(_) => {} // A lost reply retries this exact ID.
            }
        } else {
            let poll = Request {
                id: Uuid::new_v4(),
                payload: json!({"command":"closeStatus","launch_id":launch_id,"operation_id":operation_id}),
            };
            match endpoint.retry_call(&poll) {
                Ok(Ok(value)) => {
                    let progress: CloseProgress = serde_json::from_value(value).map_err(|_| {
                        AppError::InvalidArg(
                            "invalid worker close status; ownership retained".into(),
                        )
                    })?;
                    if let CloseProgress::Failed { message } = progress {
                        return Err(AppError::InvalidArg(message));
                    }
                }
                Ok(Err(message)) => return Err(AppError::InvalidArg(message)),
                Err(_) => {} // Committing and lost sockets still need release.
            }
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coordinator_ipc::Coordinator;
    use crate::storage_locks::VaultLock;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    #[test]
    fn committing_does_not_complete_until_the_os_releases_ownership() {
        let root = std::env::temp_dir().join(format!("ms-quit-close-{}", Uuid::new_v4()));
        let owner = Arc::new(Mutex::new(Some(VaultLock::acquire(&root).unwrap())));
        let listener = Coordinator::for_worker(owner.lock().unwrap().as_ref().unwrap()).unwrap();
        let endpoint = listener.endpoint().clone();
        let launch = Uuid::new_v4();
        let operation = Uuid::new_v4();
        let polled = Arc::new(AtomicBool::new(false));
        let observed = polled.clone();
        let server = listener
            .serve(
                move |request| match request.payload["command"].as_str().unwrap() {
                    "close" => {
                        assert_eq!(request.id, operation);
                        assert_eq!(request.payload["launch_id"], launch.to_string());
                        Ok(json!({"accepted":true}))
                    }
                    "closeStatus" => {
                        assert_eq!(request.payload["operation_id"], operation.to_string());
                        observed.store(true, Ordering::Release);
                        Ok(json!({"state":"committing"}))
                    }
                    _ => panic!("unexpected command"),
                },
            )
            .unwrap();
        assert!(close(
            &endpoint,
            launch,
            operation,
            Instant::now() + Duration::from_millis(300),
            || {
                Ok(if VaultLock::try_acquire(&root)?.is_some() {
                    Owner::Released
                } else {
                    Owner::Present
                })
            }
        )
        .is_err());
        assert!(polled.load(Ordering::Acquire));
        assert!(VaultLock::try_acquire(&root).unwrap().is_none());
        owner.lock().unwrap().take();
        // Accepted IPC handlers also retain the vault lease. Dropping only the
        // original owner must not count as a released worker.
        assert!(VaultLock::try_acquire(&root).unwrap().is_none());
        server.stop();
        close(&endpoint, launch, operation, Instant::now(), || {
            Ok(if VaultLock::try_acquire(&root)?.is_some() {
                Owner::Released
            } else {
                Owner::Present
            })
        })
        .unwrap();
        drop(owner);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancellation_and_changed_owners_fail_without_releasing_the_lease() {
        let root = std::env::temp_dir().join(format!("ms-quit-cancel-{}", Uuid::new_v4()));
        let owner = VaultLock::acquire(&root).unwrap();
        let listener = Coordinator::for_worker(&owner).unwrap();
        let endpoint = listener.endpoint().clone();
        let server = listener
            .serve(|request| {
                Ok(if request.payload["command"] == "close" {
                    json!({"accepted":true})
                } else {
                    json!({"state":"failed","message":"editor save failed"})
                })
            })
            .unwrap();
        let error = close(
            &endpoint,
            Uuid::new_v4(),
            Uuid::new_v4(),
            Instant::now() + Duration::from_secs(1),
            || Ok(Owner::Present),
        )
        .unwrap_err();
        assert!(error.to_string().contains("editor save failed"));
        assert!(VaultLock::try_acquire(&root).unwrap().is_none());
        assert!(close(
            &endpoint,
            Uuid::new_v4(),
            Uuid::new_v4(),
            Instant::now(),
            || Ok(Owner::Changed)
        )
        .unwrap_err()
        .to_string()
        .contains("changed"));
        server.stop();
        drop(owner);
        std::fs::remove_dir_all(root).unwrap();
    }
}
