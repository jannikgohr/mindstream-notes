fn main() {
    println!(
        "cargo:rustc-env=MINDSTREAM_WASM_TARGET={}",
        std::env::var("TARGET").unwrap()
    );
}
