fn main() {
    println!(
        "cargo:rustc-env=MINDSTREAM_WASM_TARGET={}",
        std::env::var("TARGET").unwrap()
    );
    println!("cargo:rerun-if-env-changed=MINDSTREAM_PROBE_PRECOMPILED");
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let source = if let Some(path) = std::env::var_os("MINDSTREAM_PROBE_PRECOMPILED") {
        println!(
            "cargo:rerun-if-changed={}",
            std::path::Path::new(&path).display()
        );
        std::fs::read_to_string(path).unwrap()
    } else {
        "&[]".into()
    };
    std::fs::write(out.join("probe-precompiled.rs"), source).unwrap();
}
