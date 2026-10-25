//! Builds the test components with `plugin-sdk/fixtures.mjs` into `OUT_DIR`.
//! The script prints the `rerun-if-changed` lines for every source it reads.

use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let script = manifest.join("../../plugin-sdk/fixtures.mjs");
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let node = env::var_os("NODE").unwrap_or_else(|| "node".into());
    println!("cargo:rerun-if-env-changed=NODE");
    let output = Command::new(&node)
        .arg(&script)
        .args(["--cargo", "--out"])
        .arg(&out)
        .output()
        .unwrap_or_else(|err| {
            panic!(
                "could not run {}: {err}. Plugin test fixtures are built with Node.",
                node.to_string_lossy()
            )
        });
    print!("{}", String::from_utf8_lossy(&output.stdout));
    if !output.status.success() {
        eprint!("{}", String::from_utf8_lossy(&output.stderr));
        panic!(
            "building the plugin test fixtures failed. They need `pnpm install` \
             and `rustup target add wasm32-unknown-unknown`."
        );
    }
}
