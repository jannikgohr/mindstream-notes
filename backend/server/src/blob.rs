//! Where chunks too large to keep in a database row are stored.
//!
//! A blob holds all the large chunks of one upload, back to back, and a chunk
//! row records which blob and where in it. An attachment is hundreds of
//! chunks, so one blob per upload means one write and one flush to disk for
//! it, not hundreds, and one object in a bucket once this runs on S3.
//!
//! The storage itself is the `object_store` crate. Only its local filesystem
//! is switched on, with the option that makes a finished write survive a
//! power cut: the file is synced, and so is every directory whose entries
//! the write changed, the ones it had to create included. Callers see a put,
//! ranged gets and deletes on opaque keys, so a bucket can take the
//! filesystem's place without touching them.

use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::stream::BoxStream;
use futures_util::{StreamExt, TryStreamExt};
use object_store::local::LocalFileSystem;
use object_store::path::Path as Key;
use object_store::{ObjectStore, ObjectStoreExt, PutPayload};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::keys::{random_bytes, to_base64};
use crate::wire::valid_uid;

/// How many blobs one request reads at once.
const CONCURRENCY: usize = 16;

/// A chunk's place inside a blob.
#[derive(Clone, Copy, Debug)]
pub struct Range {
    pub offset: u64,
    pub len: usize,
}

#[derive(Clone, Debug)]
pub struct BlobStore {
    store: Arc<dyn ObjectStore>,
}

fn failed(err: impl std::error::Error + Send + Sync + 'static) -> io::Error {
    io::Error::other(err)
}

impl BlobStore {
    pub async fn open(root: impl Into<PathBuf>) -> io::Result<Self> {
        let root = root.into();
        tokio::fs::create_dir_all(&root).await?;
        let local = LocalFileSystem::new_with_prefix(&root)
            .map_err(failed)?
            // A chunk row that commits must never outlive the bytes it
            // points at, so a put has to be on disk when it returns, name
            // and all. On Unix this syncs directories too. Elsewhere it
            // cannot, which is fine for a development machine and nothing
            // to deploy on.
            .with_fsync(true)
            // A collection whose last blob goes leaves no empty directory.
            .with_automatic_cleanup(true);
        Ok(Self {
            store: Arc::new(local),
        })
    }

    /// A fresh key under the collection. The uid was checked to be URL-safe
    /// base64, so the key cannot climb out of the root.
    pub fn new_key(collection_uid: &str) -> String {
        format!(
            "{}/{}",
            Self::collection_dir(collection_uid),
            to_base64(&random_bytes::<16>())
        )
    }

    /// Where a collection's blobs are kept, relative to the root.
    fn collection_dir(collection_uid: &str) -> String {
        // Fan out by a prefix so no single directory collects every
        // collection on the server.
        let prefix = &collection_uid[..collection_uid.len().min(2)];
        format!("{prefix}/{collection_uid}")
    }

    /// Whether a key is one [`BlobStore::new_key`] could have made. Other
    /// files share the root, the server's secret key among them.
    fn is_blob_key(key: &str) -> bool {
        let mut parts = key.split('/');
        let (Some(prefix), Some(collection), Some(name), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return false;
        };
        valid_uid(collection)
            && collection.starts_with(prefix)
            && prefix.len() == collection.len().min(2)
            && name.len() == 22
            && valid_uid(name)
    }

    /// The keys of the blobs written more than `age` ago.
    pub fn written_before(&self, age: Duration) -> BoxStream<'static, io::Result<String>> {
        let cutoff = SystemTime::now()
            .checked_sub(age)
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map_or(i64::MIN, |since| since.as_millis() as i64);
        self.store
            .list(None)
            .map_err(failed)
            .try_filter_map(move |blob| async move {
                let key = blob.location.to_string();
                let old = blob.last_modified.timestamp_millis() <= cutoff;
                Ok((old && Self::is_blob_key(&key)).then_some(key))
            })
            .boxed()
    }

    /// Remove every blob of a collection. Call it once the rows that
    /// pointed into them are gone for good: a blob that outlives its rows
    /// wastes space, and rows that outlive their blob lose data.
    pub async fn remove_collection(&self, collection_uid: &str) -> io::Result<()> {
        if !valid_uid(collection_uid) {
            // The directory below is built from this uid. Refuse anything
            // that is not a uid rather than listing from a name that could
            // point anywhere under the root.
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "not a collection uid",
            ));
        }
        let dir = Key::from(Self::collection_dir(collection_uid));
        let blobs = self
            .store
            .list(Some(&dir))
            .map_ok(|blob| blob.location)
            .boxed();
        self.remove_all(blobs).await
    }

    /// Remove blobs by key. One that is already gone is not an error. Keys
    /// that could never have come from [`BlobStore::new_key`] are skipped
    /// with a warning instead of removed: they name rows that do not point
    /// at blobs, and deleting by them could take the server's own files.
    pub async fn remove(&self, keys: Vec<String>) -> io::Result<()> {
        let kept: Vec<String> = keys
            .into_iter()
            .filter(|key| {
                if Self::is_blob_key(key) {
                    true
                } else {
                    tracing::warn!("not removing a file that is no blob: {key}");
                    false
                }
            })
            .collect();
        let blobs = futures_util::stream::iter(kept.into_iter().map(|key| Ok(Key::from(key))));
        self.remove_all(blobs.boxed()).await
    }

    async fn remove_all(
        &self,
        blobs: BoxStream<'static, object_store::Result<Key>>,
    ) -> io::Result<()> {
        let mut removed = self.store.delete_stream(blobs);
        while let Some(outcome) = removed.next().await {
            match outcome {
                Ok(_) | Err(object_store::Error::NotFound { .. }) => {}
                Err(err) => return Err(failed(err)),
            }
        }
        Ok(())
    }

    /// Store `data` under `key`, durably: the database rows that will point
    /// into it must never outlive it. A reader sees the whole blob or none
    /// of it.
    pub async fn put(&self, key: &str, data: Vec<u8>) -> io::Result<()> {
        debug_assert!(
            Self::is_blob_key(key),
            "blobs are only ever stored under keys BlobStore::new_key made"
        );
        self.store
            .put(&Key::from(key), PutPayload::from(data))
            .await
            .map(|_| ())
            .map_err(failed)
    }

    /// Read several ranges of one blob, returned in the order asked for.
    /// Only keys [`BlobStore::new_key`] could have made are read: a chunk
    /// row pointing anywhere else names damage, not a blob.
    pub async fn get_ranges(&self, key: &str, ranges: Vec<Range>) -> io::Result<Vec<Vec<u8>>> {
        if !Self::is_blob_key(key) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "not a blob key",
            ));
        }        let wanted: Vec<std::ops::Range<u64>> = ranges
            .iter()
            .map(|range| range.offset..range.offset + range.len as u64)
            .collect();
        let parts = self
            .store
            .get_ranges(&Key::from(key), &wanted)
            .await
            .map_err(failed)?;
        parts
            .into_iter()
            .zip(&ranges)
            .map(|(part, range)| {
                // A blob shorter than its rows say is damage, and must not
                // go out as a chunk that is merely short.
                if part.len() != range.len {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "a blob is shorter than the chunk it should hold",
                    ));
                }
                Ok(Vec::from(part))
            })
            .collect()
    }

    /// Read ranges out of several blobs at once. The result lines up with
    /// `requests`.
    pub async fn get_many(
        &self,
        requests: Vec<(String, Vec<Range>)>,
    ) -> io::Result<Vec<Vec<Vec<u8>>>> {
        let limit = Arc::new(Semaphore::new(CONCURRENCY));
        let mut tasks = JoinSet::new();
        for (index, (key, ranges)) in requests.into_iter().enumerate() {
            let store = self.clone();
            let limit = Arc::clone(&limit);
            tasks.spawn(async move {
                let _permit = limit.acquire().await.map_err(io::Error::other)?;
                Ok::<_, io::Error>((index, store.get_ranges(&key, ranges).await?))
            });
        }
        let mut blobs = vec![Vec::new(); tasks.len()];
        while let Some(done) = tasks.join_next().await {
            let (index, data) = done.map_err(io::Error::other)??;
            blobs[index] = data;
        }
        Ok(blobs)
    }
}

/// Blobs written for a transaction that has not committed. Dropped without
/// [`Uncommitted::keep`], it removes them: the transaction failed or the
/// request was abandoned, and no row will ever point into them.
///
/// Once the commit has been asked for they stay, whatever its answer: a
/// commit whose answer was lost may have happened all the same, and a blob
/// removed under committed rows is lost data. What is left behind that way,
/// or by a crash, is for `chunks::reclaim_blobs` to find.
pub struct Uncommitted {
    store: BlobStore,
    keys: Vec<String>,
}

impl Uncommitted {
    pub fn new(store: &BlobStore) -> Self {
        Self {
            store: store.clone(),
            keys: Vec::new(),
        }
    }

    /// Store a blob, see [`BlobStore::put`].
    pub async fn put(&mut self, key: String, data: Vec<u8>) -> io::Result<()> {
        // Noted before the write: if the request is abandoned while the
        // write is under way, the file may still appear.
        self.keys.push(key);
        let key = self.keys.last().expect("just pushed");
        self.store.put(key, data).await
    }

    /// The transaction is about to commit, and the blobs are its to keep.
    pub fn keep(mut self) {
        self.keys.clear();
    }
}

impl Drop for Uncommitted {
    fn drop(&mut self) {
        if self.keys.is_empty() {
            return;
        }
        let keys = std::mem::take(&mut self.keys);
        let store = self.store.clone();
        // Dropped while a request unwinds, which cannot wait for the disk.
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        runtime.spawn(async move {
            if let Err(err) = store.remove(keys).await {
                tracing::warn!("could not remove the blobs of a write that failed: {err}");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir() -> PathBuf {
        std::env::temp_dir().join(format!(
            "mindstream-blob-test-{}",
            to_base64(&random_bytes::<8>())
        ))
    }

    #[tokio::test]
    async fn ranges_come_back_in_the_order_asked() {
        let dir = scratch_dir();
        let store = BlobStore::open(&dir).await.unwrap();
        let key = BlobStore::new_key("AbCdEf");
        assert!(key.starts_with("Ab/AbCdEf/"));

        store.put(&key, b"0123456789".to_vec()).await.unwrap();
        let read = |offset, len| Range { offset, len };
        let parts = store
            .get_ranges(&key, vec![read(7, 3), read(0, 2), read(2, 5)])
            .await
            .unwrap();
        assert_eq!(
            parts,
            vec![b"789".to_vec(), b"01".to_vec(), b"23456".to_vec()]
        );

        // Reading past the end is an error, never a short answer.
        assert!(store.get_ranges(&key, vec![read(8, 5)]).await.is_err());
        assert!(store.get_ranges(&key, vec![read(40, 1)]).await.is_err());

        let many = store
            .get_many(vec![
                (key.clone(), vec![read(1, 1)]),
                (key.clone(), vec![read(9, 1), read(0, 1)]),
            ])
            .await
            .unwrap();
        assert_eq!(many[0], vec![b"1".to_vec()]);
        assert_eq!(many[1], vec![b"9".to_vec(), b"0".to_vec()]);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn put_leaves_the_blob_and_nothing_else_behind() {
        let dir = scratch_dir();
        let store = BlobStore::open(&dir).await.unwrap();
        let key = BlobStore::new_key("AbCdEf");
        store.put(&key, vec![7; 100_000]).await.unwrap();

        // No temporary file survives a finished write, where a reader or a
        // later listing could take it for a blob.
        let files: Vec<String> = std::fs::read_dir(dir.join("Ab").join("AbCdEf"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(files.len(), 1, "{files:?}");
        assert!(key.ends_with(&files[0]));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn removing_a_collection_takes_its_blobs_and_no_others() {
        let dir = scratch_dir();
        let store = BlobStore::open(&dir).await.unwrap();
        // The two share a prefix directory.
        let gone = [BlobStore::new_key("AbCdEf"), BlobStore::new_key("AbCdEf")];
        let kept = BlobStore::new_key("AbXyZw");
        for key in gone.iter().chain([&kept]) {
            store.put(key, b"data".to_vec()).await.unwrap();
        }
        let whole = || vec![Range { offset: 0, len: 4 }];

        store.remove_collection("AbCdEf").await.unwrap();
        for key in &gone {
            assert!(store.get_ranges(key, whole()).await.is_err());
        }
        assert_eq!(
            store.get_ranges(&kept, whole()).await.unwrap(),
            vec![b"data".to_vec()]
        );
        // A collection that never had a blob, or has none left, is fine.
        store.remove_collection("AbCdEf").await.unwrap();
        store.remove_collection("never-stored").await.unwrap();

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_what_new_key_makes_is_taken_for_a_blob() {
        assert!(BlobStore::is_blob_key(&BlobStore::new_key("AbCdEf")));
        assert!(BlobStore::is_blob_key(&BlobStore::new_key("A")));
        for other in [
            "secret.key",
            "Ab/secret.key",
            "Ab/AbCdEf/secret.key",
            "Xy/AbCdEf/AAAAAAAAAAAAAAAAAAAAAA",
            "Ab/AbCdEf/AAAAAAAAAAAAAAAAAAAAAA/deeper",
            "Ab/AbCdEf/AAAAAAAAAAAAAAAAAAAAA",
        ] {
            assert!(!BlobStore::is_blob_key(other), "{other}");
        }
    }

    #[tokio::test]
    async fn blobs_of_a_write_that_never_committed_go() {
        let dir = scratch_dir();
        let store = BlobStore::open(&dir).await.unwrap();
        let whole = || vec![Range { offset: 0, len: 4 }];
        let (failed, kept) = (BlobStore::new_key("AbCdEf"), BlobStore::new_key("AbCdEf"));

        let mut written = Uncommitted::new(&store);
        written.put(failed.clone(), b"data".to_vec()).await.unwrap();
        drop(written);
        let mut written = Uncommitted::new(&store);
        written.put(kept.clone(), b"data".to_vec()).await.unwrap();
        written.keep();

        // The removal is left to run on its own.
        tokio::time::timeout(Duration::from_secs(5), async {
            while store.get_ranges(&failed, whole()).await.is_ok() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the blob of the failed write went");
        assert!(store.get_ranges(&kept, whole()).await.is_ok());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn removing_blobs_by_key_spares_the_rest_and_forgives_the_missing() {
        let dir = scratch_dir();
        let store = BlobStore::open(&dir).await.unwrap();
        let gone = BlobStore::new_key("AbCdEf");
        let kept = BlobStore::new_key("AbCdEf");
        for key in [&gone, &kept] {
            store.put(key, b"data".to_vec()).await.unwrap();
        }
        let whole = || vec![Range { offset: 0, len: 4 }];

        store
            .remove(vec![gone.clone(), BlobStore::new_key("AbCdEf")])
            .await
            .unwrap();
        assert!(store.get_ranges(&gone, whole()).await.is_err());
        assert_eq!(
            store.get_ranges(&kept, whole()).await.unwrap(),
            vec![b"data".to_vec()]
        );
        // Removing it again changes nothing and is no error.
        store.remove(vec![gone]).await.unwrap();

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
