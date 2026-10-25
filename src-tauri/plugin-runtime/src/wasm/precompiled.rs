//! Native code from the application's own build, never from plugin packages.
use std::io::Read;
use std::sync::Arc;

use super::cache::{self, Digest32};

/// Immutable component bytes with a digest computed once at verification time.
#[derive(Clone, Debug)]
pub struct VerifiedComponent {
    bytes: ComponentBytes,
    digest: Digest32,
}

#[derive(Clone, Debug)]
enum ComponentBytes {
    Owned(Arc<Vec<u8>>),
    Embedded(&'static [u8]),
}

impl VerifiedComponent {
    pub fn new(bytes: Vec<u8>) -> Self {
        let digest = cache::digest(&bytes);
        Self {
            bytes: ComponentBytes::Owned(Arc::new(bytes)),
            digest,
        }
    }

    pub fn from_static(bytes: &'static [u8]) -> Self {
        Self {
            bytes: ComponentBytes::Embedded(bytes),
            digest: cache::digest(bytes),
        }
    }

    pub fn digest(&self) -> Digest32 {
        self.digest
    }
    pub fn as_slice(&self) -> &[u8] {
        match &self.bytes {
            ComponentBytes::Owned(bytes) => bytes,
            ComponentBytes::Embedded(bytes) => bytes,
        }
    }
}

impl std::ops::Deref for VerifiedComponent {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        self.as_slice()
    }
}

/// A gzip-compressed artifact embedded in the signed application binary.
pub struct TrustedPrecompiled<'a> {
    wasm: Digest32,
    compiled: Digest32,
    engine: &'a str,
    gzip: &'a [u8],
}

impl<'a> TrustedPrecompiled<'a> {
    /// # Safety
    /// `gzip` must contain ONLY code produced by this application's trusted
    /// Wasmtime build pipeline. A plugin author's signature is not sufficient:
    /// serialized artifacts are native code and bypass Wasm verification.
    pub unsafe fn new(wasm: Digest32, compiled: Digest32, engine: &'a str, gzip: &'a [u8]) -> Self {
        Self {
            wasm,
            compiled,
            engine,
            gzip,
        }
    }

    pub(super) fn decode(&self, wasm: Digest32, engine: &wasmtime::Engine) -> Option<Vec<u8>> {
        if self.wasm != wasm || self.engine != cache::engine_key(engine) {
            return None;
        }
        let mut bytes = Vec::new();
        // Protect against corrupt build output. This is not a guest memory cap.
        let max = 128 * 1024 * 1024;
        flate2::read::GzDecoder::new(self.gzip)
            .take(max + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() as u64 > max || cache::digest(&bytes) != self.compiled {
            return None;
        }
        Some(bytes)
    }
}

/// Same baseline settings for release compilation and runtime loading.
pub fn engine_for_target(target: &str) -> Result<wasmtime::Engine, wasmtime::Error> {
    let mut config = wasmtime::Config::new();
    config.epoch_interruption(true);
    config.wasm_backtrace_details(wasmtime::WasmBacktraceDetails::Disable);
    config.max_wasm_stack(1024 * 1024);
    // Unsupported native backends use Pulley, as in the app's fallback path.
    let target = if target.starts_with("armv7-") || target.starts_with("i686-") {
        "pulley32"
    } else {
        target
    };
    // Explicit targets disable build-machine CPU feature inference.
    config.target(target)?;
    wasmtime::Engine::new(&config)
}

#[cfg(feature = "aot-build")]
pub fn build_bundled(
    plugins: &std::path::Path,
    out: &std::path::Path,
    target: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    use std::io::Write;
    std::fs::create_dir_all(out)?;
    let engine = engine_for_target(target)?;
    let mut rust = String::from("&[\n");
    let mut report = Vec::new();
    let mut dirs: Vec<_> = std::fs::read_dir(plugins)?.collect::<Result<_, _>>()?;
    dirs.sort_by_key(|dir| dir.path());
    for dir in dirs {
        let manifest = dir.path().join("manifest.json");
        if !manifest.is_file() {
            continue;
        }
        let manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(manifest)?)?;
        if manifest["runtime"] != "wasm" {
            continue;
        }
        let entry = manifest["entry"].as_str().ok_or("missing bundled entry")?;
        let bytes = std::fs::read(dir.path().join(entry))?;
        let wasm = cache::digest(&bytes);
        let compiled = engine.precompile_component(&bytes)?;
        let compiled_hash = cache::digest(&compiled);
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
        gzip.write_all(&compiled)?;
        let gzip = gzip.finish()?;
        let path = out.join(format!("{}.cwasm.gz", cache::hex(&wasm)));
        std::fs::write(&path, &gzip)?;
        rust.push_str(&format!(
            "({wasm:?}, {compiled_hash:?}, {:?}, include_bytes!({:?}).as_slice()),\n",
            cache::engine_key(&engine),
            path.to_string_lossy()
        ));
        report.push(serde_json::json!({"id":manifest["id"],"target":target,"wasmSha256":cache::hex(&wasm),"compiledSha256":cache::hex(&compiled_hash),"engine":cache::engine_key(&engine),"wasmBytes":bytes.len(),"compiledBytes":compiled.len(),"gzipBytes":gzip.len()}));
    }
    rust.push(']');
    std::fs::write(out.join("precompiled.rs"), rust)?;
    std::fs::write(
        out.join("manifest.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(())
}
