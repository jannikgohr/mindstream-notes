//! The files the user picked, as the importer reads them.
//!
//! The bytes stay in the browser's file handles, and each read asks for one
//! range through a `FileReaderSync` on the worker, so a large export is never
//! held in memory whole.

use std::collections::BTreeSet;
use std::io::{self, BufReader, Read};

use mindstream_storage_core::import::{walk_paths, ImportEntry, ImportFiles};
use wasm_bindgen::prelude::*;

/// The size of each read when a file is streamed.
const STREAM_CHUNK_BYTES: usize = 1 << 20;

#[wasm_bindgen]
extern "C" {
    /// `src/lib/browser/picked-files.ts`
    #[derive(Clone)]
    pub type PickedFiles;

    #[wasm_bindgen(method)]
    fn paths(this: &PickedFiles) -> Vec<String>;

    #[wasm_bindgen(method)]
    fn size(this: &PickedFiles, path: &str) -> Option<f64>;

    #[wasm_bindgen(method)]
    fn modified(this: &PickedFiles, path: &str) -> Option<f64>;

    #[wasm_bindgen(method, catch, js_name = readRange)]
    fn read_range(
        this: &PickedFiles,
        path: &str,
        start: f64,
        length: f64,
    ) -> Result<Vec<u8>, JsValue>;
}

fn read_picked(picked: &PickedFiles, path: &str, start: u64, length: usize) -> io::Result<Vec<u8>> {
    picked
        .read_range(path, start as f64, length as f64)
        .map_err(|err| {
            io::Error::new(
                io::ErrorKind::NotFound,
                err.as_string().unwrap_or_else(|| path.to_string()),
            )
        })
}

pub struct BrowserFiles {
    picked: PickedFiles,
    paths: BTreeSet<String>,
}

impl BrowserFiles {
    pub fn new(picked: PickedFiles) -> Self {
        let paths = picked.paths().into_iter().collect();
        Self { picked, paths }
    }
}

struct PickedStream {
    picked: PickedFiles,
    path: String,
    position: u64,
}

impl Read for PickedStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let bytes = read_picked(&self.picked, &self.path, self.position, buffer.len())?;
        buffer[..bytes.len()].copy_from_slice(&bytes);
        self.position += bytes.len() as u64;
        Ok(bytes.len())
    }
}

impl ImportFiles for BrowserFiles {
    fn walk(&self, skip: &dyn Fn(&str) -> bool) -> Vec<ImportEntry> {
        walk_paths(self.paths.iter().map(String::as_str), skip)
    }

    fn root_files(&self) -> io::Result<Vec<String>> {
        Ok(self
            .paths
            .iter()
            .filter(|path| !path.contains('/'))
            .cloned()
            .collect())
    }

    fn read(&self, path: &str) -> io::Result<Vec<u8>> {
        let size = self.picked.size(path).unwrap_or(0.0) as usize;
        read_picked(&self.picked, path, 0, size)
    }

    fn read_range(&self, path: &str, start: u64, length: usize) -> io::Result<Vec<u8>> {
        read_picked(&self.picked, path, start, length)
    }

    fn stream(&self, path: &str) -> io::Result<Box<dyn Read>> {
        Ok(Box::new(BufReader::with_capacity(
            STREAM_CHUNK_BYTES,
            PickedStream {
                picked: self.picked.clone(),
                path: path.to_string(),
                position: 0,
            },
        )))
    }

    fn is_file(&self, path: &str) -> bool {
        self.paths.contains(path)
    }

    fn is_dir(&self, path: &str) -> bool {
        let prefix = format!("{path}/");
        self.paths.iter().any(|entry| entry.starts_with(&prefix))
    }

    fn modified(&self, path: &str) -> Option<String> {
        chrono::DateTime::from_timestamp_millis(self.picked.modified(path)? as i64)
            .map(|time| time.to_rfc3339())
    }
}
