//! Loading Hunspell dictionaries off disk.
//!
//! `spellbook` is a Rust port of Nuspell and takes `&str`, which makes
//! character encoding this module's problem rather than the engine's.
//!
//! THE TRAP, and the reason this file exists at all: a Hunspell dictionary
//! is a PAIR of files, and the `SET` directive that declares their encoding
//! appears ONLY in the `.aff`. The `.dic` carries no encoding marker of its
//! own, but is written in the same encoding. Default the `.dic` to UTF-8 and
//! every umlaut decodes to U+FFFD, so the dictionary silently "knows" every
//! ASCII word and rejects every accented one — which looks exactly like an
//! engine that cannot handle German, and is not.
//!
//! `de_DE_frami` is `SET ISO8859-1`; `en_US` is UTF-8. A change here that is
//! only tested against English will appear to work.

use std::path::Path;

use encoding_rs::Encoding;

use crate::error::{AppError, AppResult};

/// How much of the `.aff` to scan for the `SET` line. The directive appears
/// in the first few lines, after a licence header at most.
const SNIFF_BYTES: usize = 2048;

/// The encoding declared by an `.aff` file's `SET` directive.
///
/// Unknown encodings are an error rather than a silent fall back to UTF-8:
/// falling back produces a dictionary that loads cleanly and is quietly
/// wrong for exactly the accented words the user installed it for.
pub fn sniff_encoding(aff_bytes: &[u8]) -> AppResult<&'static Encoding> {
    let head = String::from_utf8_lossy(&aff_bytes[..aff_bytes.len().min(SNIFF_BYTES)]);
    let declared = head
        .lines()
        .find_map(|line| line.strip_prefix("SET "))
        .map(|value| value.trim().to_ascii_uppercase());

    match declared.as_deref() {
        // No SET line at all means UTF-8 by modern convention.
        None | Some("UTF-8") => Ok(encoding_rs::UTF_8),
        // WINDOWS_1252 is a superset of ISO8859-1 and agrees with it across
        // the whole 0xA0-0xFF range dictionaries actually use.
        Some("ISO8859-1") | Some("ISO8859-15") => Ok(encoding_rs::WINDOWS_1252),
        Some("ISO8859-2") => Ok(encoding_rs::ISO_8859_2),
        Some("ISO8859-13") => Ok(encoding_rs::ISO_8859_13),
        Some("KOI8-R") => Ok(encoding_rs::KOI8_R),
        Some("CP1251") | Some("WINDOWS-1251") => Ok(encoding_rs::WINDOWS_1251),
        Some(other) => Err(AppError::InvalidArg(format!(
            "unsupported dictionary encoding: {other}"
        ))),
    }
}

/// Decode one dictionary file with an already-determined encoding.
///
/// Decoding errors are fatal. A lossy decode would substitute U+FFFD and
/// produce the silent-wrongness described at the top of this module.
pub fn decode_dictionary_file(bytes: &[u8], encoding: &'static Encoding) -> AppResult<String> {
    let (text, _, had_errors) = encoding.decode(bytes);
    if had_errors {
        return Err(AppError::InvalidArg(format!(
            "dictionary is not valid {}",
            encoding.name()
        )));
    }
    Ok(text.into_owned())
}

/// Rewrite the `SET` line to match what we actually hand to spellbook.
///
/// Once both files are decoded to Rust strings the original declaration is
/// a lie, and spellbook parses the directive itself.
pub fn retag_utf8(aff: &str) -> String {
    aff.lines()
        .map(|line| {
            if line.starts_with("SET ") {
                "SET UTF-8"
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Load a dictionary from an `.aff`/`.dic` pair sharing a basename.
pub fn load_dictionary(aff_path: &Path, dic_path: &Path) -> AppResult<spellbook::Dictionary> {
    let aff_bytes = std::fs::read(aff_path)?;
    let dic_bytes = std::fs::read(dic_path)?;

    // The .aff decides for both files.
    let encoding = sniff_encoding(&aff_bytes)?;
    let aff = retag_utf8(&decode_dictionary_file(&aff_bytes, encoding)?);
    let dic = decode_dictionary_file(&dic_bytes, encoding)?;

    spellbook::Dictionary::new(&aff, &dic).map_err(|err| {
        AppError::InvalidArg(format!(
            "could not parse dictionary {}: {err}",
            aff_path.display()
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal but real .aff/.dic pair: one suffix rule and three stems.
    fn fixture(set_line: &str) -> (String, String) {
        let aff = format!("{set_line}\nTRY esiao\n\nSFX S Y 1\nSFX S 0 s .\n");
        let dic = "3\nhaus/S\nStra\u{00df}e\nsch\u{00f6}n\n".to_string();
        (aff, dic)
    }

    fn to_latin1(text: &str) -> Vec<u8> {
        let (bytes, _, had_errors) = encoding_rs::WINDOWS_1252.encode(text);
        assert!(!had_errors, "fixture must be representable in latin-1");
        bytes.into_owned()
    }

    #[test]
    fn sniffs_utf8_when_declared() {
        let enc = sniff_encoding(b"SET UTF-8\nTRY abc\n").unwrap();
        assert_eq!(enc, encoding_rs::UTF_8);
    }

    #[test]
    fn sniffs_latin1_when_declared() {
        let enc = sniff_encoding(b"# comment\nSET ISO8859-1\nTRY abc\n").unwrap();
        assert_eq!(enc, encoding_rs::WINDOWS_1252);
    }

    #[test]
    fn defaults_to_utf8_without_a_set_line() {
        let enc = sniff_encoding(b"TRY abc\n").unwrap();
        assert_eq!(enc, encoding_rs::UTF_8);
    }

    #[test]
    fn rejects_an_unknown_encoding_rather_than_guessing() {
        assert!(sniff_encoding(b"SET EBCDIC-500\n").is_err());
    }

    #[test]
    fn rejects_a_mis_declared_encoding_instead_of_decoding_lossily() {
        // Latin-1 bytes claiming to be UTF-8. Silently substituting U+FFFD
        // here is the bug this whole module exists to prevent.
        let (_, dic) = fixture("SET UTF-8");
        let bytes = to_latin1(&dic);
        assert!(decode_dictionary_file(&bytes, encoding_rs::UTF_8).is_err());
    }

    #[test]
    fn retags_the_set_line_and_leaves_the_rest_alone() {
        let out = retag_utf8("SET ISO8859-1\nTRY esiao\nSFX S Y 1");
        assert_eq!(out, "SET UTF-8\nTRY esiao\nSFX S Y 1");
    }

    #[test]
    fn loads_a_latin1_dictionary_and_knows_its_accented_words() {
        // The regression test for the whole module: an ASCII-only assertion
        // would pass with the encoding handling completely broken.
        let dir = tempdir();
        let (aff, dic) = fixture("SET ISO8859-1");
        std::fs::write(dir.join("t.aff"), to_latin1(&aff)).unwrap();
        std::fs::write(dir.join("t.dic"), to_latin1(&dic)).unwrap();

        let dict = load_dictionary(&dir.join("t.aff"), &dir.join("t.dic")).unwrap();

        assert!(
            dict.check("Stra\u{00df}e"),
            "must know a word with \u{00df}"
        );
        assert!(
            dict.check("sch\u{00f6}n"),
            "must know a word with an umlaut"
        );
        assert!(dict.check("haus"));
        assert!(dict.check("hauss"), "suffix rule must still apply");
        assert!(!dict.check("nichtvorhanden"));
    }

    #[test]
    fn loads_a_utf8_dictionary() {
        let dir = tempdir();
        let (aff, dic) = fixture("SET UTF-8");
        std::fs::write(dir.join("t.aff"), aff.as_bytes()).unwrap();
        std::fs::write(dir.join("t.dic"), dic.as_bytes()).unwrap();

        let dict = load_dictionary(&dir.join("t.aff"), &dir.join("t.dic")).unwrap();
        assert!(dict.check("Stra\u{00df}e"));
    }

    #[test]
    fn fails_loudly_when_the_dic_encoding_contradicts_the_aff() {
        // .aff says UTF-8, .dic is latin-1 — the exact shape of the bug.
        let dir = tempdir();
        let (aff, dic) = fixture("SET UTF-8");
        std::fs::write(dir.join("t.aff"), aff.as_bytes()).unwrap();
        std::fs::write(dir.join("t.dic"), to_latin1(&dic)).unwrap();

        assert!(load_dictionary(&dir.join("t.aff"), &dir.join("t.dic")).is_err());
    }

    fn tempdir() -> std::path::PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "mindstream-dict-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
