//! Surviving workers may restart an absent coordinator. OS leases alone grant
//! permission; the separate launch lease coalesces simultaneous workers.
use std::fs::{File, OpenOptions, TryLockError};
use std::path::Path;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::coordinator_ipc;
use crate::error::AppResult;

pub(crate) const BACKGROUND_ARG: &str = "--coordinator-recovery";

struct Claim {
    _file: File,
}

fn claim(root: &Path) -> AppResult<Option<Claim>> {
    if coordinator_ipc::is_owned(root)? {
        return Ok(None);
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join(".coordinator-revival.lock"))?;
    match file.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => return Ok(None),
        Err(TryLockError::Error(error)) => return Err(error.into()),
    }
    if coordinator_ipc::is_owned(root)? {
        return Ok(None);
    }
    Ok(Some(Claim { _file: file }))
}

pub(crate) fn background_launch() -> bool {
    std::env::args().any(|arg| arg == BACKGROUND_ARG)
}

pub(crate) fn start(app: &AppHandle) -> AppResult<()> {
    // tauri dev owns Vite's lifetime. Restarting its native child cannot revive
    // that server after the CLI tears it down. Packaged/embedded apps can revive.
    if tauri::is_dev()
        || app.state::<crate::environment::Environment>().kind == crate::environment::Kind::Dev
    {
        return Ok(());
    }
    let app = app.clone();
    std::thread::Builder::new()
        .name("coordinator-revival".into())
        .spawn(move || {
            let mut children: Vec<Child> = Vec::new();
            let mut next_attempt = Instant::now();
            let mut last_error = None;
            loop {
                std::thread::sleep(Duration::from_secs(2));
                children.retain_mut(|child| !matches!(child.try_wait(), Ok(Some(_))));
                if !crate::worker_shutdown::coordinator_revival_allowed(&app)
                    || Instant::now() < next_attempt
                {
                    continue;
                }
                let result = (|| -> AppResult<()> {
                    let root = crate::paths::app_data_root(&app)?;
                    let Some(_claim) = claim(&root)? else {
                        return Ok(());
                    };
                    next_attempt = Instant::now() + Duration::from_secs(30);
                    if children.len() >= 8 {
                        return Err(crate::error::AppError::InvalidArg(
                            "coordinator launch observers are unavailable; relaunch manually"
                                .into(),
                        ));
                    }
                    let mut command = Command::new(std::env::current_exe()?);
                    command
                        .args(["--supervised-vaults", BACKGROUND_ARG])
                        .env_remove(crate::profiles::PROFILE_DIR_ENV)
                        .env_remove(crate::profiles::PROFILE_ID_ENV);
                    #[cfg(windows)]
                    {
                        use std::os::windows::process::CommandExt;
                        command.env(
                            "WEBVIEW2_USER_DATA_FOLDER",
                            root.join("coordinator-recovery-webview"),
                        );
                        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
                    }
                    children.push(command.spawn()?);
                    log::info!(
                        "[vaults] coordinator OS lease released; starting background recovery"
                    );
                    // Retain launch admission until the replacement owns the root,
                    // or until a bounded failed startup can be retried. Never hold
                    // RootLock or a vault lease mutex while waiting.
                    let deadline = Instant::now() + Duration::from_secs(60);
                    while !coordinator_ipc::is_owned(&root)? {
                        if children
                            .last_mut()
                            .is_some_and(|child| matches!(child.try_wait(), Ok(Some(_))))
                            || Instant::now() >= deadline
                        {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    Ok(())
                })();
                let error = result.err().map(|error| error.to_string());
                if error != last_error {
                    if let Some(error) = &error {
                        log::warn!(
                            "[vaults] coordinator revival unavailable; vault retained: {error}"
                        );
                    }
                    last_error = error;
                }
            }
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_files_do_not_own_the_root_and_launch_claims_coalesce_until_os_release() {
        let root = std::env::temp_dir().join(format!("ms-revival-{}", uuid::Uuid::new_v4()));
        assert!(
            coordinator_ipc::is_owned(&root).is_err(),
            "missing lease evidence cannot authorize recovery"
        );
        assert!(!root.exists());
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("coordinator-endpoint.json"),
            b"stale/corrupt endpoint retained",
        )
        .unwrap();
        std::fs::write(root.join(".coordinator.lock"), b"old lock file").unwrap();
        let first = claim(&root).unwrap().unwrap();
        assert!(claim(&root).unwrap().is_none());
        drop(first);
        let second = claim(&root).unwrap().unwrap();
        let crate::coordinator_ipc::Election::Owner(owner) = coordinator_ipc::elect(&root).unwrap()
        else {
            panic!("free coordinator lease");
        };
        drop(second);
        assert!(coordinator_ipc::is_owned(&root).unwrap());
        assert!(
            claim(&root).unwrap().is_none(),
            "a live lease without a listening server still owns the root"
        );
        drop(owner);
        assert!(claim(&root).unwrap().is_some());
        std::fs::remove_dir_all(root).unwrap();
    }
}
