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

#[tauri::command]
pub fn get_worker_browser_options(app: tauri::AppHandle) -> CommandResult<Option<Options>> {
    let identity = app.try_state::<Identity>();
    // WebView2 windows sharing a browser process must use identical environment
    // options, including in direct test instances without a worker identity.
    let additional_browser_args = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .and_then(|window| window.additional_browser_args.clone());
    Ok(Some(Options {
        data_directory: identity
            .as_ref()
            .and_then(|identity| (!cfg!(target_os = "macos")).then(|| identity.directory.clone())),
        data_store_identifier: identity
            .as_ref()
            .and_then(|identity| cfg!(target_os = "macos").then_some(identity.store_identifier)),
        additional_browser_args,
    }))
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
}
