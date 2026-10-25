//! Plugin components the runtime and app tests run. `build.rs` builds them
//! from the sources in `plugin-sdk` when the tests compile; none of them ship.
//! The shipped Templates and Typst components stay committed under `plugins/`.

macro_rules! fixture {
    ($name:literal) => {
        include_bytes!(concat!(env!("OUT_DIR"), "/", $name, ".wasm"))
    };
}

/// The conformance plugin in Rust, `plugin-sdk/conformance/rust`.
pub const CONFORMANCE_RUST: &[u8] = fixture!("conformance-rust");
/// The same conformance plugin in TypeScript, built with the SDK.
pub const CONFORMANCE_TS: &[u8] = fixture!("conformance-ts");
/// The TypeScript Templates example, `plugin-sdk/examples/templates-typescript`.
pub const TEMPLATES_TYPESCRIPT: &[u8] = fixture!("templates-typescript");
/// The TypeScript Typst example, `plugin-sdk/examples/typst-typescript`.
pub const TYPST_TYPESCRIPT: &[u8] = fixture!("typst-typescript");
/// The Rust Templates prototype, `plugin-sdk/prototypes/templates-rust`.
pub const TEMPLATES_RUST: &[u8] = fixture!("templates-rust");
/// The prototype built with `batch-host`, which sends its date work to the host
/// as one batch of commands.
pub const TEMPLATES_RUST_BATCH: &[u8] = fixture!("templates-rust-batch");
/// The prototype built with `local-calendar`, which does date arithmetic and
/// formatting in the guest.
pub const TEMPLATES_RUST_LOCAL_CALENDAR: &[u8] = fixture!("templates-rust-local-calendar");
