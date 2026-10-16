//! One persistent WebView identity per environment and physical indexed vault.
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{Manager, Runtime, WebviewWindowBuilder};

use crate::error::CommandResult;
use crate::error::{AppError, AppResult};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub directory: PathBuf,
    pub store_identifier: [u8; 16],
}

impl Identity {
    pub fn for_vault(root: &Path, vault_id: &str, vault: &Path) -> AppResult<Self> {
        if !crate::profiles::valid_id(vault_id) {
            return Err(AppError::InvalidArg("invalid browser vault ID".into()));
        }
        let root = fs::canonicalize(root)?;
        let vault = fs::canonicalize(vault)?;
        let mut digest = Sha256::new();
        for value in [
            root.as_os_str().as_encoded_bytes(),
            vault_id.as_bytes(),
            vault.as_os_str().as_encoded_bytes(),
        ] {
            digest.update((value.len() as u64).to_be_bytes());
            digest.update(value);
        }
        let digest = digest.finalize();
        let mut store_identifier = [0u8; 16];
        store_identifier.copy_from_slice(&digest[..16]);
        let directory = root.join("webview-stores").join(format!("{digest:x}"));
        fs::create_dir_all(&directory)?;
        Ok(Self {
            directory: webview_path(&directory),
            store_identifier,
        })
    }

    pub fn apply<'a, R: Runtime, M: Manager<R>>(
        &self,
        builder: WebviewWindowBuilder<'a, R, M>,
    ) -> WebviewWindowBuilder<'a, R, M> {
        #[cfg(target_os = "macos")]
        {
            builder.data_store_identifier(self.store_identifier)
        }
        #[cfg(not(target_os = "macos"))]
        {
            builder.data_directory(self.directory.clone())
        }
    }
}

fn webview_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(drive) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(drive);
        }
    }
    path.to_owned()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    data_directory: Option<PathBuf>,
    data_store_identifier: Option<[u8; 16]>,
    additional_browser_args: Option<String>,
}

impl Options {
    fn new(identity: Option<&Identity>, additional_browser_args: Option<String>) -> Self {
        Self {
            data_directory: identity.and_then(|identity| {
                (!cfg!(target_os = "macos")).then(|| identity.directory.clone())
            }),
            data_store_identifier: identity.and_then(|identity| {
                cfg!(target_os = "macos").then_some(identity.store_identifier)
            }),
            additional_browser_args,
        }
    }
}

#[tauri::command]
pub fn get_worker_browser_options(app: tauri::AppHandle) -> CommandResult<Option<Options>> {
    // WebView2 windows sharing a browser process must use identical environment
    // options, including in direct test instances without a worker identity.
    let additional_browser_args = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .and_then(|window| window.additional_browser_args.clone());
    Ok(Some(Options::new(
        app.try_state::<Identity>().as_deref(),
        additional_browser_args,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_and_alias_paths_keep_identity_while_environments_and_vaults_differ() {
        let root =
            std::env::temp_dir().join(format!("ms-browser-identity-{}", uuid::Uuid::new_v4()));
        let dev = root.join("dev");
        let release = root.join("release");
        let a = root.join("a");
        let b = root.join("b");
        for directory in [&dev, &release, &a, &b] {
            fs::create_dir_all(directory).unwrap();
        }
        let first = Identity::for_vault(&dev, "one", &a).unwrap();
        let alias = Identity::for_vault(&dev.join("..").join("dev"), "one", &a).unwrap();
        assert_eq!(first.store_identifier, alias.store_identifier);
        let restart = Identity::for_vault(&dev, "one", &a).unwrap();
        assert_eq!(first.directory, restart.directory);
        assert_eq!(first.store_identifier, restart.store_identifier);
        assert_ne!(
            first.store_identifier,
            Identity::for_vault(&release, "one", &a)
                .unwrap()
                .store_identifier
        );
        assert_ne!(
            first.store_identifier,
            Identity::for_vault(&dev, "one", &b)
                .unwrap()
                .store_identifier
        );
        assert_ne!(
            first.store_identifier,
            Identity::for_vault(&dev, "two", &a)
                .unwrap()
                .store_identifier
        );
        assert!(Identity::for_vault(&dev, "../unsafe", &a).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn popouts_get_the_worker_store_and_the_shared_browser_arguments() {
        let identity = Identity {
            directory: PathBuf::from("store"),
            store_identifier: [7; 16],
        };
        let options =
            serde_json::to_value(Options::new(Some(&identity), Some("--flag".into()))).unwrap();
        assert_eq!(options["additionalBrowserArgs"], "--flag");
        if cfg!(target_os = "macos") {
            assert_eq!(
                options["dataStoreIdentifier"],
                serde_json::to_value([7u8; 16]).unwrap()
            );
            assert!(options["dataDirectory"].is_null());
        } else {
            assert_eq!(options["dataDirectory"], "store");
            assert!(options["dataStoreIdentifier"].is_null());
        }
        let direct = serde_json::to_value(Options::new(None, None)).unwrap();
        assert!(direct["dataDirectory"].is_null());
        assert!(direct["dataStoreIdentifier"].is_null());
        assert!(direct["additionalBrowserArgs"].is_null());
    }

    #[cfg(windows)]
    #[test]
    fn webview2_receives_paths_without_the_verbatim_prefix() {
        assert_eq!(
            webview_path(Path::new(r"\\?\C:\Users\me\store")),
            PathBuf::from(r"C:\Users\me\store")
        );
        assert_eq!(
            webview_path(Path::new(r"\\?\UNC\server\share\store")),
            PathBuf::from(r"\\server\share\store")
        );
        assert_eq!(
            webview_path(Path::new(r"C:\plain")),
            PathBuf::from(r"C:\plain")
        );
    }
}
