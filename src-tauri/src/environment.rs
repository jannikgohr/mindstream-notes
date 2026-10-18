//! Environment identity is explicit and does not depend on optimization level.
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

pub const ROOT_DIR_ENV: &str = "MINDSTREAM_ROOT_DIR";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Release,
    Dev,
    Test,
}

pub struct Environment {
    pub kind: Kind,
    pub root: PathBuf,
    pub credential_service: String,
}

pub fn os_integrations_enabled() -> bool {
    !cfg!(feature = "dev-environment")
        && !cfg!(feature = "e2e-data-dir")
        && !(crate::profiles::dir_override_allowed()
            && (std::env::var_os(ROOT_DIR_ENV).is_some()
                || crate::profiles::dir_override().is_some()))
}

impl Environment {
    /// Test processes must isolate the browser as well as backend files. The
    /// harness sets these before the native runtime starts, including popouts.
    pub fn validate_browser_isolation(&self, identifier: &str) -> AppResult<()> {
        self.validate_browser_isolation_with(identifier, |name| std::env::var_os(name))
    }

    fn validate_browser_isolation_with(
        &self,
        identifier: &str,
        var: impl Fn(&str) -> Option<OsString>,
    ) -> AppResult<()> {
        if self.kind == Kind::Dev && !identifier.ends_with(".dev") {
            return Err(AppError::InvalidArg(
                "dev-environment requires tauri.dev.conf.json; launch with pnpm tauri-dev".into(),
            ));
        }
        if self.kind == Kind::Test {
            #[cfg(target_os = "windows")]
            let required = &["WEBVIEW2_USER_DATA_FOLDER"];
            #[cfg(target_os = "linux")]
            let required = &["XDG_DATA_HOME", "XDG_CACHE_HOME"];
            #[cfg(not(any(target_os = "windows", target_os = "linux")))]
            let required: &[&str] = &[];
            for name in required {
                let value = var(name).ok_or_else(|| {
                    AppError::InvalidArg(format!(
                        "test environment requires {name} for browser isolation"
                    ))
                })?;
                if value.is_empty() || !Path::new(&value).is_absolute() {
                    return Err(AppError::InvalidArg(format!(
                        "{name} must be an absolute isolated test directory"
                    )));
                }
            }
        }
        Ok(())
    }

    pub fn resolve(os_root: PathBuf) -> AppResult<Self> {
        let permitted = crate::profiles::dir_override_allowed();
        Self::resolve_from(
            os_root,
            permitted.then(|| std::env::var_os(ROOT_DIR_ENV)).flatten(),
            crate::profiles::dir_override(),
        )
    }

    /// Pure core of [`Environment::resolve`]: the permitted overrides are read
    /// by the caller, so the decision is testable without process env.
    fn resolve_from(
        os_root: PathBuf,
        override_root: Option<OsString>,
        profile_override: Option<(String, PathBuf)>,
    ) -> AppResult<Self> {
        if cfg!(feature = "e2e-data-dir") && override_root.is_none() && profile_override.is_none() {
            return Err(AppError::InvalidArg(
                "test builds require MINDSTREAM_ROOT_DIR or MINDSTREAM_PROFILE_DIR".into(),
            ));
        }
        let kind = kind_for(override_root.is_some() || profile_override.is_some());
        let root = match override_root {
            Some(value) if value.is_empty() => {
                return Err(AppError::InvalidArg(
                    "MINDSTREAM_ROOT_DIR cannot be empty".into(),
                ))
            }
            Some(value) => PathBuf::from(value),
            None => match profile_override {
                Some((_, dir)) => dir.join(".app-root"),
                None => root_for_kind(&os_root, kind),
            },
        };
        std::fs::create_dir_all(&root)?;
        let root = std::fs::canonicalize(root)?;
        let credential_service = credential_service(kind, &root);
        Ok(Self {
            kind,
            root,
            credential_service,
        })
    }
}

/// The environment this process runs in, read before there is an app to
/// resolve its directories with. Only the kind; see [`Environment::resolve`].
pub fn kind() -> Kind {
    let override_root =
        crate::profiles::dir_override_allowed() && std::env::var_os(ROOT_DIR_ENV).is_some();
    kind_for(override_root || crate::profiles::dir_override().is_some())
}

fn kind_for(data_overridden: bool) -> Kind {
    if data_overridden {
        Kind::Test
    } else if cfg!(feature = "dev-environment") {
        Kind::Dev
    } else {
        Kind::Release
    }
}

fn root_for_kind(os_root: &Path, kind: Kind) -> PathBuf {
    if kind == Kind::Dev
        && !os_root
            .file_name()
            .is_some_and(|name| name.to_string_lossy().ends_with(".dev"))
    {
        os_root.with_file_name(format!(
            "{}.dev",
            os_root.file_name().unwrap_or_default().to_string_lossy()
        ))
    } else {
        os_root.to_path_buf()
    }
}

fn credential_service(kind: Kind, root: &Path) -> String {
    if kind == Kind::Release {
        return "mindstream-notes".into();
    }
    let hash = Sha256::digest(root.as_os_str().as_encoded_bytes());
    format!("mindstream-notes-{kind:?}-{:x}", hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dev_root_is_a_stable_sibling_and_not_nested_twice() {
        let root = Path::new("data").join("com.app");
        let dev = root_for_kind(&root, Kind::Dev);
        assert_eq!(dev, Path::new("data").join("com.app.dev"));
        assert_eq!(root_for_kind(&dev, Kind::Dev), dev);
        assert_eq!(root_for_kind(&root, Kind::Release), root);
    }
    #[test]
    fn credential_names_preserve_release_and_isolate_environment_and_device() {
        assert_eq!(
            credential_service(Kind::Release, Path::new("release")),
            "mindstream-notes"
        );
        assert_ne!(
            credential_service(Kind::Dev, Path::new("one")),
            credential_service(Kind::Test, Path::new("one"))
        );
        assert_ne!(
            credential_service(Kind::Test, Path::new("one")),
            credential_service(Kind::Test, Path::new("two"))
        );
    }

    #[test]
    fn dev_feature_cannot_use_the_release_browser_identity() {
        let environment = Environment {
            kind: Kind::Dev,
            root: PathBuf::from("dev"),
            credential_service: "dev".into(),
        };
        assert!(environment.validate_browser_isolation("com.app").is_err());
        assert!(environment
            .validate_browser_isolation("com.app.dev")
            .is_ok());
    }

    #[test]
    fn test_environment_requires_absolute_isolated_browser_directories() {
        let environment = Environment {
            kind: Kind::Test,
            root: PathBuf::from("test"),
            credential_service: "test".into(),
        };
        let absolute = std::env::temp_dir().into_os_string();
        assert!(environment
            .validate_browser_isolation_with("com.app", |_| Some(absolute.clone()))
            .is_ok());
        #[cfg(any(target_os = "windows", target_os = "linux"))]
        {
            assert!(environment
                .validate_browser_isolation_with("com.app", |_| None)
                .is_err());
            assert!(environment
                .validate_browser_isolation_with("com.app", |_| Some(OsString::new()))
                .is_err());
            assert!(environment
                .validate_browser_isolation_with("com.app", |_| Some("relative".into()))
                .is_err());
        }
        let release = Environment {
            kind: Kind::Release,
            ..environment
        };
        assert!(release
            .validate_browser_isolation_with("com.app", |_| None)
            .is_ok());
    }

    #[test]
    fn overrides_select_an_isolated_test_root_with_its_own_credentials() {
        let base = std::env::temp_dir().join(format!("ms-environment-{}", uuid::Uuid::new_v4()));
        let os_root = base.join("os");
        assert!(Environment::resolve_from(os_root.clone(), Some(OsString::new()), None).is_err());

        let root = base.join("override");
        let environment =
            Environment::resolve_from(os_root.clone(), Some(root.clone().into()), None).unwrap();
        assert_eq!(environment.kind, Kind::Test);
        assert_eq!(environment.root, std::fs::canonicalize(&root).unwrap());
        assert_eq!(
            environment.credential_service,
            credential_service(Kind::Test, &environment.root)
        );

        let profile = base.join("profile");
        let environment = Environment::resolve_from(
            os_root.clone(),
            None,
            Some(("default".into(), profile.clone())),
        )
        .unwrap();
        assert_eq!(environment.kind, Kind::Test);
        assert_eq!(
            environment.root,
            std::fs::canonicalize(profile.join(".app-root")).unwrap()
        );

        if !cfg!(feature = "e2e-data-dir") {
            let environment = Environment::resolve_from(os_root.clone(), None, None).unwrap();
            assert_eq!(environment.kind, kind_for(false));
            assert_eq!(
                environment.root,
                std::fs::canonicalize(root_for_kind(&os_root, environment.kind)).unwrap()
            );
        }
        std::fs::remove_dir_all(base).unwrap();
    }
}
