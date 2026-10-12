//! Where chunks too large to keep in a database row are stored.
//!
//! Only the filesystem is implemented. The interface is a put and a get on
//! opaque keys so an S3-compatible store can replace it for the managed
//! service without touching the callers.

use std::io;
use std::path::{Path, PathBuf};

use tokio::io::AsyncWriteExt;

use crate::keys::{random_bytes, to_base64};

#[derive(Clone, Debug)]
pub struct BlobStore {
    root: PathBuf,
}

impl BlobStore {
    pub async fn open(root: impl Into<PathBuf>) -> io::Result<Self> {
        let root = root.into();
        tokio::fs::create_dir_all(&root).await?;
        Ok(Self { root })
    }

    /// The key for a chunk. Both uids were checked to be URL-safe base64, so
    /// neither can climb out of the root.
    pub fn chunk_key(collection_uid: &str, chunk_uid: &str) -> String {
        // Fan out by a prefix so no single directory collects every
        // collection on the server.
        let prefix = &collection_uid[..collection_uid.len().min(2)];
        format!("{prefix}/{collection_uid}/{chunk_uid}")
    }

    fn path(&self, key: &str) -> PathBuf {
        self.root.join(Path::new(key))
    }

    /// Store `data` under `key`, durably: the database row that will point at
    /// it must never outlive it. Written to a temporary name and renamed, so
    /// a reader sees the whole blob or none of it.
    pub async fn put(&self, key: &str, data: &[u8]) -> io::Result<()> {
        let path = self.path(key);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let temp = path.with_extension(format!("tmp-{}", to_base64(&random_bytes::<8>())));
        let mut file = tokio::fs::File::create(&temp).await?;
        file.write_all(data).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&temp, &path).await
    }

    pub async fn get(&self, key: &str) -> io::Result<Vec<u8>> {
        tokio::fs::read(self.path(key)).await
    }
}
