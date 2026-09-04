fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rustc-check-cfg=cfg(coverage)");
    generate_i18n_bundle_list()?;
    track_builtin_plugins()?;
    tauri_build::build();
    Ok(())
}

/// The builtin plugins are `include_dir!`-embedded from the repo-root `plugins/`
/// tree (see src/plugins/discovery.rs). `include_dir!` doesn't emit its own
/// rebuild triggers, so re-embed whenever any file under `plugins/` changes.
fn track_builtin_plugins() -> Result<(), Box<dyn std::error::Error>> {
    use std::{env, path::PathBuf};

    let plugins_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?)
        .join("..")
        .join("plugins");

    fn emit_rerun(dir: &std::path::Path) {
        println!("cargo:rerun-if-changed={}", dir.display());
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    emit_rerun(&path);
                } else {
                    println!("cargo:rerun-if-changed={}", path.display());
                }
            }
        }
    }
    emit_rerun(&plugins_dir);
    Ok(())
}

fn generate_i18n_bundle_list() -> Result<(), Box<dyn std::error::Error>> {
    use std::{env, fs, path::PathBuf};

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?);
    let i18n_dir = manifest_dir
        .join("..")
        .join("src")
        .join("lib")
        .join("settings")
        .join("i18n");
    println!("cargo:rerun-if-changed={}", i18n_dir.display());

    let mut entries = Vec::new();
    if let Ok(files) = fs::read_dir(&i18n_dir) {
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            println!("cargo:rerun-if-changed={}", path.display());
            let Some(code) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            entries.push((code.to_string(), path));
        }
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    let mut generated = String::from("const I18N_BUNDLES: &[(&str, &str)] = &[\n");
    for (code, path) in entries {
        let path = path.to_string_lossy().replace('\\', "\\\\");
        generated.push_str(&format!("    (\"{code}\", include_str!(\"{path}\")),\n"));
    }
    generated.push_str("];\n");

    let out_dir = PathBuf::from(env::var("OUT_DIR")?);
    fs::write(out_dir.join("i18n_bundles.rs"), generated)?;
    Ok(())
}
