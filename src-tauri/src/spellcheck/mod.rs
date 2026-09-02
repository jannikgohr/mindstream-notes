//! Spellchecking backend.
//!
//! The app checks spelling itself rather than leaving it to the webview.
//! The native checker differs on every platform, its dictionary set is not
//! selectable from inside the app, and in PROD builds its suggestion menu is
//! unreachable anyway because the root layout suppresses the native context
//! menu. Owning it gives one behaviour everywhere and one place to add a
//! synced personal dictionary.
//!
//! Why the backend and not the webview: dictionaries are tens of megabytes
//! resident, they are read from disk, and `spellbook` is a Rust crate. Doing
//! it here keeps the dictionary bytes out of the WebView entirely — only
//! words and verdicts cross the IPC boundary.
//!
//! COST MODEL, which shapes the API: checking a word is ~10µs, but asking
//! for suggestions is tens of milliseconds and superlinear in word length
//! (a 34-character misspelling measured at 840ms). So the frontend checks
//! continuously and asks for suggestions only when the user opens the
//! popover — hence two commands rather than one that returns both.
//!
//! Multilingual rule: a word is correct if ANY enabled dictionary accepts
//! it. No language detection, no per-paragraph guessing.

mod catalogue;
mod custom;
mod dictionary;
pub mod http_checker;

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::db::Db;
use crate::error::{AppError, AppResult, CommandResult};
use crate::paths::app_data_root;

pub use catalogue::{CatalogueEntry, CATALOGUE};
pub use dictionary::{
    decode_dictionary_file, load_dictionary, read_word_chars, retag_utf8, sniff_encoding,
};

/// How many dictionaries stay resident.
///
/// Each is tens of megabytes once spellbook has built its lookup tables, so
/// this is a memory ceiling rather than a speed knob. Four covers a
/// realistic multilingual user with room to spare; loading is ~50ms, so
/// evicting and reloading is cheap if someone exceeds it.
const MAX_RESIDENT: usize = 4;

/// e2e/test seam: put the dictionary directory somewhere disposable.
///
/// Dictionaries deliberately sit outside the profile directory, so
/// `MINDSTREAM_PROFILE_DIR` does not isolate them — without this an e2e run
/// would read and write the developer's real dictionaries, and could only get
/// one installed by downloading it. Gated exactly like the profile override
/// (dev builds and `--features e2e-data-dir`), so a shipped binary ignores it.
pub const DICTIONARY_DIR_ENV: &str = "MINDSTREAM_DICTIONARY_DIR";

/// Pure core of the override: `None` means "no override, use the app-data
/// root". Split out so the gating is unit-testable without process env.
fn dictionary_dir_override(value: Option<OsString>, allowed: bool) -> Option<PathBuf> {
    if !allowed {
        return None;
    }
    value.filter(|raw| !raw.is_empty()).map(PathBuf::from)
}

/// Dictionaries live under the OS app-data ROOT, not the active profile's
/// directory: they are large, contain no user data, and a user with several
/// profiles should not download German four times.
fn dictionary_dir<R: Runtime>(app: &AppHandle<R>) -> AppResult<PathBuf> {
    if let Some(dir) = dictionary_dir_override(
        std::env::var_os(DICTIONARY_DIR_ENV),
        crate::profiles::dir_override_allowed(),
    ) {
        return Ok(dir);
    }
    Ok(app_data_root(app)?.join("dictionaries"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledDictionary {
    /// Basename shared by the `.aff`/`.dic` pair, e.g. `de_DE_frami`.
    pub id: String,
    /// Total on-disk size, shown in the settings UI.
    pub bytes: u64,
}

#[derive(Default)]
pub struct SpellcheckState {
    /// Behind an `Arc` so a blocking task can own a handle instead of
    /// borrowing from Tauri's managed state across an await point.
    inner: Arc<Mutex<Resident>>,
}

#[derive(Default)]
struct Resident {
    /// Most-recently-used first, so eviction is a `pop()`.
    order: Vec<String>,
    dictionaries: HashMap<String, spellbook::Dictionary>,
}

impl Resident {
    fn touch(&mut self, id: &str) {
        if let Some(at) = self.order.iter().position(|held| held == id) {
            let existing = self.order.remove(at);
            self.order.insert(0, existing);
        }
    }

    fn insert(&mut self, id: String, dictionary: spellbook::Dictionary) {
        self.dictionaries.insert(id.clone(), dictionary);
        self.order.insert(0, id);
        while self.order.len() > MAX_RESIDENT {
            if let Some(evicted) = self.order.pop() {
                self.dictionaries.remove(&evicted);
            }
        }
    }

    /// Load `id` if it is not already resident, then return it.
    fn get_or_load(&mut self, dir: &Path, id: &str) -> AppResult<&spellbook::Dictionary> {
        if self.dictionaries.contains_key(id) {
            self.touch(id);
        } else {
            let dictionary = dictionary::load_dictionary(
                &dir.join(format!("{id}.aff")),
                &dir.join(format!("{id}.dic")),
            )?;
            self.insert(id.to_string(), dictionary);
        }
        self.dictionaries
            .get(id)
            .ok_or_else(|| AppError::NotFound(format!("dictionary {id}")))
    }
}

/// Dictionaries present on disk, as `.aff`/`.dic` pairs.
///
/// A lone `.aff` is ignored rather than reported: it cannot be loaded, and
/// offering it in the UI would only produce an error when selected.
pub fn installed_dictionaries(dir: &Path) -> AppResult<Vec<InstalledDictionary>> {
    let mut found = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        // Nothing downloaded yet is a normal state, not a failure.
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(found),
        Err(err) => return Err(err.into()),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("aff") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let dic = dir.join(format!("{id}.dic"));
        if !dic.exists() {
            continue;
        }
        let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
            + std::fs::metadata(&dic).map(|m| m.len()).unwrap_or(0);
        found.push(InstalledDictionary {
            id: id.to_string(),
            bytes,
        });
    }

    found.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(found)
}

/// The subset of `words` that no LOADED dictionary recognises.
///
/// Split out of the command so it can be tested without a Tauri runtime.
///
/// Resolving the dictionaries up front is what makes the answer correct:
/// "nothing could be loaded" and "every dictionary rejected the word" are
/// opposite verdicts, and a per-word loop cannot tell them apart. Nothing is
/// bundled with the app, so a device where no dictionary has been downloaded
/// yet is the DEFAULT state, not an edge case — deciding it word by word
/// underlines the entire note.
fn unknown_words(
    resident: &mut Resident,
    dir: &Path,
    languages: &[String],
    words: Vec<String>,
) -> Vec<String> {
    let mut usable: Vec<&str> = Vec::new();
    for language in languages {
        match resident.get_or_load(dir, language) {
            Ok(_) => usable.push(language.as_str()),
            Err(err) => log::warn!("[spellcheck] {language} unavailable: {err}"),
        }
    }
    // No dictionary, no opinion. The frontend draws what it is given, so an
    // empty result is the only way to say "not checked" rather than "wrong".
    if usable.is_empty() {
        return Vec::new();
    }

    let mut unknown = Vec::new();
    for word in words {
        let mut known = false;
        for language in &usable {
            match resident.get_or_load(dir, language) {
                Ok(dictionary) => {
                    if dictionary.check(&word) {
                        known = true;
                        break;
                    }
                }
                // Reachable despite the pre-pass: loading a later language can
                // evict an earlier one when more than MAX_RESIDENT are enabled.
                Err(err) => log::warn!("[spellcheck] {language} unavailable: {err}"),
            }
        }
        if !known {
            unknown.push(word);
        }
    }
    unknown
}

/// The subset of `words` that no enabled dictionary recognises.
///
/// Takes a batch because the frontend checks a paragraph at a time; a
/// command per word would spend more time in IPC than in spellbook.
#[tauri::command]
pub async fn spellcheck_unknown_words(
    app: AppHandle,
    languages: Vec<String>,
    words: Vec<String>,
) -> CommandResult<Vec<String>> {
    let dir = dictionary_dir(&app)?;
    let resident = app.state::<SpellcheckState>().inner.clone();

    // Dictionary loading reads megabytes off disk and building the lookup
    // tables is CPU-bound, so keep it off the async runtime's threads.
    let unknown = tauri::async_runtime::spawn_blocking({
        move || -> AppResult<Vec<String>> {
            let mut guard = resident
                .lock()
                .map_err(|_| AppError::InvalidArg("spellcheck state poisoned".into()))?;

            Ok(unknown_words(&mut guard, &dir, &languages, words))
        }
    })
    .await
    .map_err(|err| AppError::InvalidArg(format!("spellcheck task failed: {err}")))??;

    Ok(unknown)
}

/// Corrections for one misspelled word, best first.
///
/// Separate from checking because it is 3-4 orders of magnitude more
/// expensive: only ever called when the user opens the popover.
#[tauri::command]
pub async fn spellcheck_suggest(
    app: AppHandle,
    languages: Vec<String>,
    word: String,
) -> CommandResult<Vec<String>> {
    let dir = dictionary_dir(&app)?;
    let resident = app.state::<SpellcheckState>().inner.clone();

    let suggestions = tauri::async_runtime::spawn_blocking(move || -> AppResult<Vec<String>> {
        let mut guard = resident
            .lock()
            .map_err(|_| AppError::InvalidArg("spellcheck state poisoned".into()))?;

        let mut out: Vec<String> = Vec::new();
        for language in &languages {
            let Ok(dictionary) = guard.get_or_load(&dir, language) else {
                continue;
            };
            let mut per_language = Vec::new();
            dictionary.suggest(&word, &mut per_language);
            for suggestion in per_language {
                if !out.contains(&suggestion) {
                    out.push(suggestion);
                }
            }
        }
        Ok(out)
    })
    .await
    .map_err(|err| AppError::InvalidArg(format!("suggest task failed: {err}")))??;

    Ok(suggestions)
}

#[tauri::command]
pub async fn spellcheck_installed_dictionaries(
    app: AppHandle,
) -> CommandResult<Vec<InstalledDictionary>> {
    let dir = dictionary_dir(&app)?;
    Ok(installed_dictionaries(&dir)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir(name: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("mindstream-spell-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_dictionary_dir_override_is_gated_to_test_builds() {
        // A stray env var must not redirect a shipped binary's dictionaries.
        assert_eq!(
            dictionary_dir_override(Some(OsString::from("C:/anywhere")), false),
            None
        );
    }

    #[test]
    fn the_dictionary_dir_override_ignores_an_empty_value() {
        assert_eq!(dictionary_dir_override(Some(OsString::new()), true), None);
        assert_eq!(dictionary_dir_override(None, true), None);
    }

    #[test]
    fn the_dictionary_dir_override_wins_when_set() {
        assert_eq!(
            dictionary_dir_override(Some(OsString::from("/tmp/dicts")), true),
            Some(PathBuf::from("/tmp/dicts"))
        );
    }

    #[test]
    fn reports_nothing_when_the_directory_does_not_exist() {
        let dir = std::env::temp_dir().join("mindstream-spell-absent");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(installed_dictionaries(&dir).unwrap().is_empty());
    }

    #[test]
    fn lists_only_complete_pairs() {
        let dir = tempdir("pairs");
        std::fs::write(dir.join("de_DE.aff"), b"SET UTF-8\n").unwrap();
        std::fs::write(dir.join("de_DE.dic"), b"1\nhaus\n").unwrap();
        // A half-finished download must not be offered as installed.
        std::fs::write(dir.join("fr_FR.aff"), b"SET UTF-8\n").unwrap();

        let found = installed_dictionaries(&dir).unwrap();
        assert_eq!(
            found.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(),
            ["de_DE"]
        );
        assert!(found[0].bytes > 0);
    }

    /// A minimal but real dictionary pair, written into `dir` under `id`.
    fn write_pair(dir: &Path, id: &str, word: &str) {
        std::fs::write(dir.join(format!("{id}.aff")), "SET UTF-8\nTRY esiao\n").unwrap();
        std::fs::write(dir.join(format!("{id}.dic")), format!("1\n{word}\n")).unwrap();
    }

    #[test]
    fn loads_a_dictionary_on_first_use_and_keeps_it_resident() {
        let dir = tempdir("resident");
        write_pair(&dir, "de_DE", "haus");

        let mut resident = Resident::default();
        assert!(resident.get_or_load(&dir, "de_DE").unwrap().check("haus"));
        assert_eq!(resident.order, ["de_DE"]);

        // Second use is served from memory: loading reads megabytes off disk.
        std::fs::remove_file(dir.join("de_DE.dic")).unwrap();
        assert!(resident.get_or_load(&dir, "de_DE").unwrap().check("haus"));
    }

    #[test]
    fn reports_a_dictionary_that_is_not_installed() {
        let dir = tempdir("missing");
        let mut resident = Resident::default();
        assert!(resident.get_or_load(&dir, "de_DE").is_err());
        assert!(resident.order.is_empty());
    }

    #[test]
    fn drops_the_evicted_dictionary_from_memory_as_well_as_from_the_order() {
        // The order alone is the eviction policy; the map is what holds the
        // tens of megabytes, so leaving an entry there would leak one.
        let dir = tempdir("evict");
        let mut resident = Resident::default();
        for i in 0..=MAX_RESIDENT {
            let id = format!("lang{i}");
            write_pair(&dir, &id, "haus");
            resident.get_or_load(&dir, &id).unwrap();
        }

        assert_eq!(resident.order.len(), MAX_RESIDENT);
        assert_eq!(resident.dictionaries.len(), MAX_RESIDENT);
        // lang0 was least recently used, so it is the one that went.
        assert!(!resident.dictionaries.contains_key("lang0"));
        assert!(resident.dictionaries.contains_key("lang1"));
    }

    #[test]
    fn keeps_a_recently_used_dictionary_through_an_eviction() {
        let dir = tempdir("evict-touch");
        let mut resident = Resident::default();
        for i in 0..MAX_RESIDENT {
            let id = format!("lang{i}");
            write_pair(&dir, &id, "haus");
            resident.get_or_load(&dir, &id).unwrap();
        }

        // Re-using the oldest makes it most recent, so the next load evicts
        // what is now last instead.
        resident.get_or_load(&dir, "lang0").unwrap();
        write_pair(&dir, "extra", "haus");
        resident.get_or_load(&dir, "extra").unwrap();

        assert!(resident.dictionaries.contains_key("lang0"));
        assert!(!resident.dictionaries.contains_key("lang1"));
    }

    #[test]
    fn counts_both_halves_of_a_pair_towards_its_size() {
        let dir = tempdir("bytes");
        write_pair(&dir, "de_DE", "haus");
        let expected = std::fs::metadata(dir.join("de_DE.aff")).unwrap().len()
            + std::fs::metadata(dir.join("de_DE.dic")).unwrap().len();

        let found = installed_dictionaries(&dir).unwrap();
        assert_eq!(found[0].bytes, expected);
    }

    #[test]
    fn says_nothing_is_unknown_when_no_dictionary_could_be_loaded() {
        // The state every device starts in: a language is selected (en_US is
        // the default) but nothing has been downloaded yet. Reported as a
        // misspelling per word, this underlines every word in the note.
        let dir = tempdir("no-dictionary");
        let mut resident = Resident::default();

        let unknown = unknown_words(
            &mut resident,
            &dir,
            &["en_US".to_string()],
            vec!["are".into(), "here".into(), "teh".into()],
        );

        assert!(unknown.is_empty(), "got {unknown:?}");
    }

    #[test]
    fn says_nothing_is_unknown_when_no_language_is_selected() {
        let dir = tempdir("no-language");
        write_pair(&dir, "en_US", "haus");
        let mut resident = Resident::default();

        let unknown = unknown_words(&mut resident, &dir, &[], vec!["are".into()]);

        assert!(unknown.is_empty(), "got {unknown:?}");
    }

    #[test]
    fn reports_only_the_words_a_loaded_dictionary_rejects() {
        let dir = tempdir("loaded");
        write_pair(&dir, "en_US", "haus");
        let mut resident = Resident::default();

        let unknown = unknown_words(
            &mut resident,
            &dir,
            &["en_US".to_string()],
            vec!["haus".into(), "teh".into()],
        );

        assert_eq!(unknown, ["teh"]);
    }

    #[test]
    fn a_missing_dictionary_does_not_veto_one_that_loaded() {
        // Multi-dictionary rule: a word is correct if ANY enabled dictionary
        // knows it, and a language that failed to load simply has no vote.
        let dir = tempdir("one-of-two");
        write_pair(&dir, "en_US", "haus");
        let mut resident = Resident::default();

        let unknown = unknown_words(
            &mut resident,
            &dir,
            &["en_US".to_string(), "de_DE_frami".to_string()],
            vec!["haus".into(), "teh".into()],
        );

        assert_eq!(unknown, ["teh"]);
    }

    #[test]
    fn a_dictionary_evicted_mid_check_does_not_flag_the_word() {
        // The one path the pre-pass cannot rule out. MAX_RESIDENT is 4, so a
        // fifth language pushes the first out of memory between the pre-pass
        // and the word loop; if its files are gone by then, the reload fails
        // there instead. That must stay a language with no vote, not a veto
        // over the dictionaries that did load.
        let dir = tempdir("evicted-mid-check");
        for id in ["gone", "l1", "l2", "l3", "l4"] {
            write_pair(&dir, id, "haus");
        }

        let mut resident = Resident::default();
        // Resident before the call, so the pre-pass sees it as usable...
        resident.get_or_load(&dir, "gone").unwrap();
        // ...and off disk, so the reload after eviction cannot succeed.
        std::fs::remove_file(dir.join("gone.aff")).unwrap();
        std::fs::remove_file(dir.join("gone.dic")).unwrap();

        let languages = ["gone", "l1", "l2", "l3", "l4"].map(String::from);
        let unknown = unknown_words(
            &mut resident,
            &dir,
            &languages,
            vec!["haus".into(), "teh".into()],
        );

        assert_eq!(unknown, ["teh"]);
        // Proves the word loop really did take the failing branch rather than
        // finding "gone" still in memory.
        assert!(!resident.dictionaries.contains_key("gone"));
    }

    #[test]
    fn sorts_installed_dictionaries_by_id() {
        let dir = tempdir("sorted");
        for id in ["fr_FR", "de_DE", "en_US"] {
            write_pair(&dir, id, "haus");
        }
        let found = installed_dictionaries(&dir).unwrap();
        assert_eq!(
            found.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(),
            ["de_DE", "en_US", "fr_FR"]
        );
    }
}

/// Everything the settings UI needs to offer a dictionary: what it is, its
/// licence, where it came from, and whether it is already installed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableDictionary {
    pub id: String,
    pub bcp47: String,
    pub license: String,
    pub source_url: String,
    pub installed: bool,
}

#[tauri::command]
pub async fn spellcheck_available_dictionaries(
    app: AppHandle,
) -> CommandResult<Vec<AvailableDictionary>> {
    let dir = dictionary_dir(&app)?;
    let installed = installed_dictionaries(&dir)?;

    Ok(catalogue::CATALOGUE
        .iter()
        .map(|entry| AvailableDictionary {
            id: entry.id.to_string(),
            bcp47: entry.bcp47.to_string(),
            license: entry.license.to_string(),
            source_url: catalogue::source_url(entry),
            installed: installed.iter().any(|held| held.id == entry.id),
        })
        .collect())
}

/// Download and install a dictionary. Network happens only here — checking
/// never touches the network.
#[tauri::command]
pub async fn spellcheck_install_dictionary(app: AppHandle, id: String) -> CommandResult<()> {
    let dir = dictionary_dir(&app)?;
    catalogue::install(&dir, &id).await?;
    Ok(())
}

#[tauri::command]
pub async fn spellcheck_remove_dictionary(app: AppHandle, id: String) -> CommandResult<()> {
    let dir = dictionary_dir(&app)?;
    catalogue::remove(&dir, &id)?;

    // Drop it from memory too, or it would keep answering checks until the
    // app restarts and the user would think the removal silently failed.
    let resident = app.state::<SpellcheckState>().inner.clone();
    if let Ok(mut guard) = resident.lock() {
        guard.dictionaries.remove(&id);
        guard.order.retain(|held| held != &id);
    }
    Ok(())
}

/// The user's personal dictionary, in the casing they typed.
#[tauri::command]
pub async fn custom_dictionary_list(db: tauri::State<'_, Db>) -> CommandResult<Vec<String>> {
    Ok(db.with_conn(custom::list)?)
}

/// Accept a word everywhere, in every language.
///
/// Applied in the frontend BEFORE a word is ever sent for checking, so it
/// takes effect on the next check with no dictionary reload.
#[tauri::command]
pub async fn custom_dictionary_add(db: tauri::State<'_, Db>, word: String) -> CommandResult<()> {
    Ok(db.with_conn(|conn| custom::add(conn, &word))?)
}

#[tauri::command]
pub async fn custom_dictionary_remove(db: tauri::State<'_, Db>, word: String) -> CommandResult<()> {
    Ok(db.with_conn(|conn| custom::remove(conn, &word))?)
}

/// The union of `WORDCHARS` across the given languages.
///
/// A union because the tokenizer runs once over text that may contain any
/// enabled language, and it cannot know which language a given word is in —
/// that is the same premise the "any enabled dictionary accepts it" rule
/// rests on. Over-inclusion is safe: the frontend falls back to checking a
/// token's segments individually when the joined form is unknown.
///
/// Missing or unreadable dictionaries contribute nothing rather than
/// failing the call; the tokenizer degrades to letters-only, which is what
/// it did before this existed.
#[tauri::command]
pub async fn spellcheck_word_chars(
    app: AppHandle,
    languages: Vec<String>,
) -> CommandResult<String> {
    let dir = dictionary_dir(&app)?;
    let mut chars: Vec<char> = Vec::new();
    for language in languages {
        let path = dir.join(format!("{language}.aff"));
        match dictionary::read_word_chars(&path) {
            Ok(declared) => {
                for ch in declared.chars() {
                    if !chars.contains(&ch) {
                        chars.push(ch);
                    }
                }
            }
            Err(err) => log::warn!("[spellcheck] no WORDCHARS for {language}: {err}"),
        }
    }
    Ok(chars.into_iter().collect())
}
