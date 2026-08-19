//! The dictionaries the app offers to download, and how it fetches them.
//!
//! Dictionaries are downloaded on demand rather than bundled. Two reasons,
//! and the second is the binding one:
//!
//!   1. Size. The German dictionary alone is 4.3MB; a useful spread of
//!      languages would dwarf the rest of the installer.
//!   2. Licensing. Hunspell dictionaries are a patchwork — `de_DE_frami` is
//!      GPLv2/GPLv3 ONLY (no MPL option, unlike upstream igerman98), while
//!      others are MPL, BSD or CC-BY. Shipping them inside the installer
//!      would mean shipping GPL data with the application; fetching them at
//!      the user's request, with the licence shown first, does not.
//!
//! Sourced from LibreOffice's dictionaries repository, pinned to a COMMIT
//! rather than a tag or branch. The repo's tags are ancient (the newest is
//! from a 2011 SUSE build) and `master` is a moving target that could change
//! or remove a path under a shipped release. A commit SHA is immutable and
//! content-addressed, which is also why there are no per-file checksums
//! here: the URL already names the exact bytes.
//!
//! What IS verified after download is stronger than a checksum — the pair is
//! handed to spellbook and must parse and load. A file that hashes correctly
//! but cannot be loaded is no use; one that loads is, by definition, usable.

use std::path::Path;

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// Pinned upstream revision. Bumping this is a deliberate, reviewable act:
/// re-check that every `path` below still exists at the new revision.
const PINNED_REVISION: &str = "f2ff99058268502bdcf4cad25c1ca2935ad8aa7d";

const RAW_BASE: &str = "https://raw.githubusercontent.com/LibreOffice/dictionaries";

/// A dictionary the user can install.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueEntry {
    /// Basename shared by the `.aff`/`.dic` pair; also the on-disk name and
    /// the identifier the frontend passes back as an enabled "language".
    pub id: &'static str,
    /// BCP-47 tag, for labelling in the UI.
    pub bcp47: &'static str,
    /// Path within the upstream repo, without extension.
    pub path: &'static str,
    /// SPDX-ish licence, exactly as stated in the dictionary's own header.
    ///
    /// Empty means the header states none. It is deliberately NOT guessed:
    /// showing the user an invented licence is worse than showing none and
    /// linking them to the source.
    pub license: &'static str,
}

/// The offered set. Ordered roughly by expected demand.
///
/// Danish is deliberately absent. `da_DK` declares `FLAG num`, and line 61
/// of its `.dic` is `"A/S"` — an unescaped `/` that Hunspell's format
/// treats as the flag separator, leaving `S"` where a number belongs.
/// spellbook rejects the whole dictionary, so it fails install validation
/// every time. Offering a dictionary that provably cannot install is worse
/// than not offering it; restore this entry once the parse succeeds.
pub const CATALOGUE: &[CatalogueEntry] = &[
    CatalogueEntry {
        id: "en_US",
        bcp47: "en-US",
        path: "en/en_US",
        license: "",
    },
    CatalogueEntry {
        id: "en_GB",
        bcp47: "en-GB",
        path: "en/en_GB",
        license: "",
    },
    CatalogueEntry {
        id: "de_DE_frami",
        bcp47: "de-DE",
        path: "de/de_DE_frami",
        license: "GPL-2.0 OR GPL-3.0",
    },
    CatalogueEntry {
        id: "de_AT_frami",
        bcp47: "de-AT",
        path: "de/de_AT_frami",
        license: "GPL-2.0 OR GPL-3.0",
    },
    CatalogueEntry {
        id: "de_CH_frami",
        bcp47: "de-CH",
        path: "de/de_CH_frami",
        license: "GPL-2.0 OR GPL-3.0",
    },
    // Upstream keeps French and Swedish one level deeper than every other
    // language — worth noticing before assuming `<lang>/<id>`.
    CatalogueEntry {
        id: "fr",
        bcp47: "fr-FR",
        path: "fr_FR/dictionaries/fr",
        license: "MPL-2.0",
    },
    CatalogueEntry {
        id: "es_ES",
        bcp47: "es-ES",
        path: "es/es_ES",
        license: "",
    },
    CatalogueEntry {
        id: "it_IT",
        bcp47: "it-IT",
        path: "it_IT/it_IT",
        license: "GPL-3.0",
    },
    CatalogueEntry {
        id: "nl_NL",
        bcp47: "nl-NL",
        path: "nl_NL/nl_NL",
        license: "BSD-3-Clause OR CC-BY-3.0",
    },
    CatalogueEntry {
        id: "pt_PT",
        bcp47: "pt-PT",
        path: "pt_PT/pt_PT",
        license: "",
    },
    CatalogueEntry {
        id: "pt_BR",
        bcp47: "pt-BR",
        path: "pt_BR/pt_BR",
        license: "",
    },
    CatalogueEntry {
        id: "pl_PL",
        bcp47: "pl-PL",
        path: "pl_PL/pl_PL",
        license: "",
    },
    CatalogueEntry {
        id: "sv_SE",
        bcp47: "sv-SE",
        path: "sv_SE/dictionaries/sv_SE",
        license: "",
    },
    CatalogueEntry {
        id: "cs_CZ",
        bcp47: "cs-CZ",
        path: "cs_CZ/cs_CZ",
        license: "",
    },
    CatalogueEntry {
        id: "ru_RU",
        bcp47: "ru-RU",
        path: "ru_RU/ru_RU",
        license: "",
    },
];

pub fn find(id: &str) -> Option<&'static CatalogueEntry> {
    CATALOGUE.iter().find(|entry| entry.id == id)
}

/// The upstream URL for one half of a dictionary pair.
pub fn file_url(entry: &CatalogueEntry, extension: &str) -> String {
    format!("{RAW_BASE}/{PINNED_REVISION}/{}.{extension}", entry.path)
}

/// The upstream folder, shown in the UI so a user can read the licence and
/// provenance before installing.
pub fn source_url(entry: &CatalogueEntry) -> String {
    let folder = entry
        .path
        .rsplit_once('/')
        .map(|(dir, _)| dir)
        .unwrap_or("");
    format!("https://github.com/LibreOffice/dictionaries/tree/{PINNED_REVISION}/{folder}")
}

/// Download a dictionary pair and install it into `dir`.
///
/// Writes to temporary files first and only publishes them once the pair has
/// been loaded successfully, so an interrupted or corrupt download can never
/// leave a half-installed dictionary that fails at check time instead of at
/// install time.
pub async fn install(dir: &Path, id: &str) -> AppResult<()> {
    let entry = find(id).ok_or_else(|| AppError::NotFound(format!("dictionary {id}")))?;

    std::fs::create_dir_all(dir)?;
    let aff_bytes = fetch(&file_url(entry, "aff")).await?;
    let dic_bytes = fetch(&file_url(entry, "dic")).await?;

    let staged_aff = dir.join(format!("{id}.aff.part"));
    let staged_dic = dir.join(format!("{id}.dic.part"));
    std::fs::write(&staged_aff, &aff_bytes)?;
    std::fs::write(&staged_dic, &dic_bytes)?;

    // Prove it works before it counts as installed. This subsumes a checksum:
    // it catches truncation, a moved upstream path serving an HTML error page,
    // and an encoding we cannot handle — all of which would otherwise surface
    // much later as "the spellchecker thinks every word is wrong".
    let validation = super::dictionary::load_dictionary(&staged_aff, &staged_dic);
    if let Err(err) = validation {
        let _ = std::fs::remove_file(&staged_aff);
        let _ = std::fs::remove_file(&staged_dic);
        return Err(err);
    }

    std::fs::rename(&staged_aff, dir.join(format!("{id}.aff")))?;
    std::fs::rename(&staged_dic, dir.join(format!("{id}.dic")))?;
    Ok(())
}

async fn fetch(url: &str) -> AppResult<Vec<u8>> {
    let response = reqwest::get(url)
        .await
        .map_err(|err| AppError::InvalidArg(format!("dictionary download failed: {err}")))?;

    if !response.status().is_success() {
        return Err(AppError::InvalidArg(format!(
            "dictionary download failed: {} for {url}",
            response.status()
        )));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|err| AppError::InvalidArg(format!("dictionary download failed: {err}")))?;
    Ok(bytes.to_vec())
}

/// Remove an installed dictionary's files.
pub fn remove(dir: &Path, id: &str) -> AppResult<()> {
    for extension in ["aff", "dic"] {
        let path = dir.join(format!("{id}.{extension}"));
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_entry_has_a_unique_id() {
        let mut ids: Vec<_> = CATALOGUE.iter().map(|e| e.id).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "duplicate dictionary id in the catalogue");
    }

    #[test]
    fn ids_are_safe_as_filenames() {
        // Ids become paths under the dictionary directory, so a separator or
        // a traversal sequence would be a write-anywhere primitive.
        for entry in CATALOGUE {
            assert!(
                entry
                    .id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'),
                "unsafe dictionary id: {}",
                entry.id
            );
        }
    }

    #[test]
    fn urls_are_pinned_to_a_commit() {
        let entry = find("de_DE_frami").unwrap();
        let url = file_url(entry, "aff");
        assert!(url.contains(PINNED_REVISION));
        assert!(url.ends_with("de/de_DE_frami.aff"));
        // A branch name here would silently un-pin every install.
        assert!(!url.contains("/master/"));
    }

    #[test]
    fn handles_the_nested_upstream_layout() {
        // French and Swedish sit one level deeper than every other language.
        assert!(file_url(find("fr").unwrap(), "dic").ends_with("fr_FR/dictionaries/fr.dic"));
        assert!(source_url(find("fr").unwrap()).ends_with("fr_FR/dictionaries"));
    }

    #[test]
    fn unknown_ids_are_rejected() {
        assert!(find("../../etc/passwd").is_none());
        assert!(find("kl_KL").is_none());
    }

    fn tempdir(name: &str) -> std::path::PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "mindstream-catalogue-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn removes_both_halves_of_a_pair() {
        let dir = tempdir("remove");
        std::fs::write(dir.join("de_DE_frami.aff"), b"SET UTF-8\n").unwrap();
        std::fs::write(dir.join("de_DE_frami.dic"), b"1\nhaus\n").unwrap();

        remove(&dir, "de_DE_frami").unwrap();

        assert!(!dir.join("de_DE_frami.aff").exists());
        assert!(!dir.join("de_DE_frami.dic").exists());
    }

    #[test]
    fn removing_what_is_not_installed_succeeds() {
        // Removal has to be idempotent: a half-installed pair is exactly the
        // state a user reaches for "remove" in.
        let dir = tempdir("remove-absent");
        std::fs::write(dir.join("de_DE_frami.aff"), b"SET UTF-8\n").unwrap();

        remove(&dir, "de_DE_frami").unwrap();
        remove(&dir, "de_DE_frami").unwrap();

        assert!(!dir.join("de_DE_frami.aff").exists());
    }

    #[test]
    fn installing_an_unknown_id_fails_before_any_network_call() {
        let dir = tempdir("install-unknown");
        let err = tauri::async_runtime::block_on(install(&dir, "kl_KL")).unwrap_err();
        assert!(format!("{err}").contains("kl_KL"), "{err}");
    }
}
