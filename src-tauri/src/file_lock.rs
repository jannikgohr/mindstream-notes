//! File ownership on desktop and Android. Rust's std file locks currently
//! return Unsupported on Android, where bionic provides flock instead.
use std::fs::{File, TryLockError};

pub(crate) fn try_lock_exclusive(file: &File) -> Result<(), TryLockError> {
    #[cfg(not(target_os = "android"))]
    {
        file.try_lock()
    }
    #[cfg(target_os = "android")]
    {
        android_lock(file, 2) // LOCK_EX from <sys/file.h>.
    }
}

pub(crate) fn try_lock_shared(file: &File) -> Result<(), TryLockError> {
    #[cfg(not(target_os = "android"))]
    {
        file.try_lock_shared()
    }
    #[cfg(target_os = "android")]
    {
        android_lock(file, 1) // LOCK_SH from <sys/file.h>.
    }
}

#[cfg(target_os = "android")]
fn android_lock(file: &File, operation: std::ffi::c_int) -> Result<(), TryLockError> {
    use std::os::fd::AsRawFd;
    unsafe extern "C" {
        fn flock(fd: std::ffi::c_int, operation: std::ffi::c_int) -> std::ffi::c_int;
    }
    loop {
        // SAFETY: File owns a live descriptor for this call. flock does not
        // retain pointers or take ownership. LOCK_NB keeps both operations
        // nonblocking, matching std's try_lock methods on desktop.
        if unsafe { flock(file.as_raw_fd(), operation | 4) } == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        match error.kind() {
            std::io::ErrorKind::Interrupted => continue,
            std::io::ErrorKind::WouldBlock => return Err(TryLockError::WouldBlock),
            _ => return Err(TryLockError::Error(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::OpenOptions;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn files() -> (std::path::PathBuf, File, File) {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "mindstream-file-lock-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let open = || {
            OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(&path)
                .unwrap()
        };
        let first = open();
        let second = open();
        (path, first, second)
    }

    #[test]
    fn exclusive_ownership_blocks_other_readers_and_writers_until_close() {
        let (path, owner, other) = files();
        try_lock_exclusive(&owner).unwrap();
        assert!(matches!(
            try_lock_exclusive(&other),
            Err(TryLockError::WouldBlock)
        ));
        assert!(matches!(
            try_lock_shared(&other),
            Err(TryLockError::WouldBlock)
        ));
        drop(owner);
        try_lock_exclusive(&other).unwrap();
        drop(other);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn shared_package_leases_block_cleanup_until_every_reader_closes() {
        let (path, first, second) = files();
        let cleanup = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        try_lock_shared(&first).unwrap();
        try_lock_shared(&second).unwrap();
        assert!(matches!(
            try_lock_exclusive(&cleanup),
            Err(TryLockError::WouldBlock)
        ));
        drop(first);
        assert!(matches!(
            try_lock_exclusive(&cleanup),
            Err(TryLockError::WouldBlock)
        ));
        drop(second);
        try_lock_exclusive(&cleanup).unwrap();
        drop(cleanup);
        std::fs::remove_file(path).unwrap();
    }
}
