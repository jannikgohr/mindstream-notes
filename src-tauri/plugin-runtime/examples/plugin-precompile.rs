//! Trusted build tool, never called on downloaded plugin artifacts.
#[cfg(feature = "aot-build")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 3 {
        return Err("usage: plugin-precompile TARGET PLUGINS_DIR OUTPUT_DIR".into());
    }
    mindstream_plugin_runtime::wasm::precompiled::build_bundled(
        std::path::Path::new(&args[1]),
        std::path::Path::new(&args[2]),
        &args[0],
    )
}

#[cfg(not(feature = "aot-build"))]
fn main() {
    panic!("plugin-precompile requires --features aot-build");
}
