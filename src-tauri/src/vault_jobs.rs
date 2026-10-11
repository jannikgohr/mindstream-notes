//! Admission and draining for vault services before a controlled worker exit.
//! This is process state, not vault ownership. The vault OS lease remains held.
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use uuid::Uuid;

use crate::error::{AppError, AppResult};

#[derive(Default)]
struct Book {
    active: usize,
    pause: Option<Uuid>,
}

#[derive(Default)]
struct Shared {
    book: Mutex<Book>,
    changed: Condvar,
}

#[derive(Default)]
pub struct Jobs(Arc<Shared>);

struct Active(Arc<Shared>);

/// Clones share one job registration. A blocking task keeps its clone even if
/// its async caller is cancelled before the task finishes.
#[must_use]
pub struct Job(Arc<Active>);

impl Clone for Job {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl Drop for Active {
    fn drop(&mut self) {
        let mut book = self
            .0
            .book
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        book.active -= 1;
        self.0.changed.notify_all();
    }
}

#[must_use]
pub struct Pause {
    shared: Arc<Shared>,
    id: Uuid,
    committed: bool,
}

fn unavailable() -> AppError {
    AppError::InvalidArg("vault services are closing; the operation was not started".into())
}

impl Jobs {
    pub fn enter(&self) -> AppResult<Job> {
        let mut book = self.0.book.lock().map_err(|_| unavailable())?;
        if book.pause.is_some() {
            return Err(unavailable());
        }
        book.active = book.active.checked_add(1).ok_or_else(unavailable)?;
        Ok(Job(Arc::new(Active(self.0.clone()))))
    }

    /// Stop admission immediately. Dropping an uncommitted pause resumes it.
    /// Waiting happens separately and never on the native event-loop thread.
    pub fn pause(&self) -> AppResult<Pause> {
        let mut book = self.0.book.lock().map_err(|_| unavailable())?;
        if book.pause.is_some() {
            return Err(unavailable());
        }
        let id = Uuid::new_v4();
        book.pause = Some(id);
        Ok(Pause {
            shared: self.0.clone(),
            id,
            committed: false,
        })
    }
}

impl Pause {
    pub fn wait(&self, timeout: Duration) -> AppResult<()> {
        let book = self.shared.book.lock().map_err(|_| unavailable())?;
        let (book, _) = self
            .shared
            .changed
            .wait_timeout_while(book, timeout, |book| {
                book.pause == Some(self.id) && book.active != 0
            })
            .map_err(|_| unavailable())?;
        if book.pause != Some(self.id) || book.active != 0 {
            return Err(AppError::InvalidArg(
                "vault services did not finish; the vault remains open".into(),
            ));
        }
        Ok(())
    }

    pub fn commit(mut self) -> AppResult<()> {
        self.wait(Duration::ZERO)?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for Pause {
    fn drop(&mut self) {
        if !self.committed {
            if let Ok(mut book) = self.shared.book.lock() {
                if book.pause == Some(self.id) {
                    book.pause = None;
                    self.shared.changed.notify_all();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn cancelled_async_caller_cannot_untrack_a_running_blocking_job() {
        let jobs = Jobs::default();
        let job = jobs.enter().unwrap();
        let blocking_job = job.clone();
        let (finish, finished) = mpsc::channel();
        let task = std::thread::spawn(move || {
            let _job = blocking_job;
            finished.recv_timeout(Duration::from_secs(2)).unwrap();
        });
        drop(job);
        let pause = jobs.pause().unwrap();
        assert!(jobs.enter().is_err());
        assert!(jobs.pause().is_err());
        assert!(pause.wait(Duration::ZERO).is_err());
        finish.send(()).unwrap();
        pause.wait(Duration::from_secs(2)).unwrap();
        task.join().unwrap();
        assert!(jobs.enter().is_err());
        drop(pause);
        assert!(jobs.enter().is_ok());
    }

    #[test]
    fn failed_close_resumes_admission_and_successful_close_keeps_it_stopped() {
        let jobs = Jobs::default();
        let job = jobs.enter().unwrap();
        let pause = jobs.pause().unwrap();
        assert!(pause.commit().is_err());
        let next_job = jobs.enter().unwrap();
        let pause = jobs.pause().unwrap();
        drop(job);
        assert!(pause.wait(Duration::ZERO).is_err());
        drop(next_job);
        pause.commit().unwrap();
        assert!(jobs.enter().is_err());
        assert!(jobs.pause().is_err());
    }
}
