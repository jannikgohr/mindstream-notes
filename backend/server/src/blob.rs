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

use futures_util::{StreamExt, TryStreamExt};
use object_store::local::LocalFileSystem;
use object_store::path::Path as Key;
use object_store::{ObjectStore, ObjectStoreExt, PutPayload};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::keys::{random_bytes, to_base64};

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

    /// Remove every blob of a collection. Call it once the rows that
    /// pointed into them are gone for good: a blob that outlives its rows
    /// wastes space, and rows that outlive their blob lose data.
    pub async fn remove_collection(&self, collection_uid: &str) -> io::Result<()> {
        let dir = Key::from(Self::collection_dir(collection_uid));
        let blobs = self
            .store
            .list(Some(&dir))
            .map_ok(|blob| blob.location)
            .boxed();
        self.remove_all(blobs).await
    }

    /// Remove blobs by key. One that is already gone is not an error.
    pub async fn remove(&self, keys: Vec<String>) -> io::Result<()> {
        let blobs = futures_util::stream::iter(keys.into_iter().map(|key| Ok(Key::from(key))));
        self.remove_all(blobs.boxed()).await
    }

    async fn remove_all(
        &self,
        blobs: futures_util::stream::BoxStream<'static, object_store::Result<Key>>,
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
        self.store
            .put(&Key::from(key), PutPayload::from(data))
            .await
            .map(|_| ())
            .map_err(failed)
    }

    /// Read several ranges of one blob, returned in the order asked for.
    pub async fn get_ranges(&self, key: &str, ranges: Vec<Range>) -> io::Result<Vec<Vec<u8>>> {
        let wanted: Vec<std::ops::Range<u64>> = ranges
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
