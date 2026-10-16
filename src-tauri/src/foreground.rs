//! Foreground permission is separate from vault ownership. Call only after an
//! authenticated peer reply, and never grant permission to all processes.
use crate::coordinator_ipc::{Endpoint, Request};
use crate::error::{AppError, AppResult};

pub fn after_probe(endpoint: &Endpoint, probe: &Request) -> AppResult<()> {
    after_probe_with(endpoint, probe, transfer)
}

fn after_probe_with(
    endpoint: &Endpoint,
    probe: &Request,
    grant: impl FnOnce(&Endpoint),
) -> AppResult<()> {
    endpoint.retry_call(probe)?.map_err(AppError::InvalidArg)?;
    grant(endpoint);
    Ok(())
}

pub fn transfer(endpoint: &Endpoint) {
    #[cfg(windows)]
    if let Some(process_id) = endpoint.activation_process_id() {
        // SAFETY: a validated nonzero process ID is a value, not a pointer.
        // u32::MAX/ASFW_ANY is excluded by endpoint validation and the getter.
        let granted = unsafe {
            windows::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(process_id)
        }
        .is_ok();
        log::debug!("[vaults] foreground permission transferred={granted}");
    }
    #[cfg(not(windows))]
    let _ = endpoint;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use uuid::Uuid;

    #[test]
    fn rejected_peers_never_receive_a_foreground_grant() {
        let root = std::env::temp_dir().join(format!("ms-foreground-{}", Uuid::new_v4()));
        let crate::coordinator_ipc::Election::Owner(owner) =
            crate::coordinator_ipc::elect(&root).unwrap()
        else {
            panic!("new root");
        };
        let endpoint = owner.endpoint().clone();
        let allow = Arc::new(AtomicBool::new(false));
        let gate = allow.clone();
        let server = owner
            .serve(move |_| {
                if gate.load(Ordering::Acquire) {
                    Ok(serde_json::Value::Null)
                } else {
                    Err("not authorized".into())
                }
            })
            .unwrap();
        let probe = Request {
            id: Uuid::new_v4(),
            payload: serde_json::Value::Null,
        };
        let granted = AtomicBool::new(false);
        assert!(after_probe_with(&endpoint, &probe, |_| granted
            .store(true, Ordering::Release))
        .is_err());
        assert!(!granted.load(Ordering::Acquire));
        allow.store(true, Ordering::Release);
        after_probe_with(&endpoint, &probe, |_| {
            granted.store(true, Ordering::Release)
        })
        .unwrap();
        assert!(granted.load(Ordering::Acquire));
        assert_eq!(endpoint.activation_process_id(), Some(std::process::id()));
        server.stop();
        std::fs::remove_dir_all(root).unwrap();
    }
}
