//! Where chunks too large to keep in a database row are stored.
//!
//! A blob holds all the large chunks of one upload, back to back, and a chunk
//! row records which blob and where in it. An attachment is hundreds of
//! chunks, so one blob per upload means one write and one flush to disk for
//! it, not hundreds, and one object in a bucket once this runs on S3.
//!
//! Only the filesystem is implemented. Callers see a put and ranged gets on
//! opaque keys, so another store can replace it without touching them.

use std::fs;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

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
    root: Arc<PathBuf>,
}

fn join_error(err: tokio::task::JoinError) -> io::Error {
    io::Error::other(err)
}

impl BlobStore {
    pub async fn open(root: impl Into<PathBuf>) -> io::Result<Self> {
        let root = root.into();
        tokio::fs::create_dir_all(&root).await?;
        Ok(Self {
            root: Arc::new(root),
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
        let dir = self.path(&Self::collection_dir(collection_uid));
        tokio::task::spawn_blocking(move || match fs::remove_dir_all(&dir) {
            Err(err) if err.kind() != io::ErrorKind::NotFound => Err(err),
            _ => Ok(()),
        })
        .await
        .map_err(join_error)?
    }

    fn path(&self, key: &str) -> PathBuf {
        self.root.join(Path::new(key))
    }

    /// Store `data` under `key`, durably: the database rows that will point
    /// into it must never outlive it. Written to a temporary name and
    /// renamed, so a reader sees the whole blob or none of it.
    pub async fn put(&self, key: &str, data: Vec<u8>) -> io::Result<()> {
        let path = self.path(key);
        tokio::task::spawn_blocking(move || {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            let temp = path.with_extension("tmp");
            let mut file = fs::File::create(&temp)?;
            file.write_all(&data)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temp, &path)
        })
        .await
        .map_err(join_error)?
    }

    /// Read several ranges of one blob, returned in the order asked for.
    pub async fn get_ranges(&self, key: &str, ranges: Vec<Range>) -> io::Result<Vec<Vec<u8>>> {
        let path = self.path(key);
        tokio::task::spawn_blocking(move || {
            let mut file = fs::File::open(&path)?;
            ranges
                .into_iter()
                .map(|range| {
                    let mut buffer = vec![0u8; range.len];
                    file.seek(SeekFrom::Start(range.offset))?;
                    file.read_exact(&mut buffer)?;
                    Ok(buffer)
                })
                .collect()
        })
        .await
        .map_err(join_error)?
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
            let (index, data) = done.map_err(join_error)??;
            blobs[index] = data;
        }
        Ok(blobs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ranges_come_back_in_the_order_asked() {
        let dir = std::env::temp_dir().join(format!(
            "mindstream-blob-test-{}",
            to_base64(&random_bytes::<8>())
        ));
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
    async fn removing_a_collection_takes_its_blobs_and_no_others() {
        let dir = std::env::temp_dir().join(format!(
            "mindstream-blob-test-{}",
            to_base64(&random_bytes::<8>())
        ));
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
}
