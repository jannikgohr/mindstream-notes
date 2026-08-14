//! The user's personal dictionary.
//!
//! Words the user has explicitly accepted, stored per vault in the DB.
//!
//! WHY THE DB AND NOT A SETTING: settings live in the WebView's
//! localStorage, which is device-local and gets wiped by a session reload.
//! A personal dictionary the user has to rebuild after every reload is
//! worse than not having one. It is also the piece the native spellchecker
//! could never give us — its "add to dictionary" writes to a per-machine
//! store shared with unrelated apps.
//!
//! MATCHING IS CASE-INSENSITIVE. A word added mid-sentence in lowercase
//! would otherwise come back underlined the moment it starts a sentence,
//! which is exactly when people notice. Accepting `MINDSTREAM` too is the
//! harmless direction of that trade, and matches the rule the rest of the
//! feature already follows: prefer a missed typo over a false alarm.
//!
//! NOT SCOPED PER LANGUAGE. A personal word — a surname, a product, a piece
//! of jargon — is not a fact about German or English, and asking the user
//! which language their own name belongs to is a question with no good
//! answer.

use rusqlite::{params, Connection};

use crate::error::AppResult;

/// Lowercase form used for both storage and lookup.
///
/// `to_lowercase` rather than `to_ascii_lowercase`: the words that most need
/// this are the non-ASCII ones (Ärzte, Straße), and ASCII folding would
/// leave them matching only in their original case.
fn fold(word: &str) -> String {
    word.to_lowercase()
}

/// Every accepted word, in the form the user originally typed it.
pub fn list(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT word FROM custom_dictionary ORDER BY word_folded")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Accept a word. Idempotent — re-adding a different casing keeps the first.
pub fn add(conn: &Connection, word: &str) -> AppResult<()> {
    let trimmed = word.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    conn.execute(
        "INSERT OR IGNORE INTO custom_dictionary (word, word_folded, created)
         VALUES (?1, ?2, ?3)",
        params![trimmed, fold(trimmed), chrono::Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

/// Stop accepting a word. Matches case-insensitively, like lookup does, so
/// removing works from whatever casing the user is looking at.
pub fn remove(conn: &Connection, word: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM custom_dictionary WHERE word_folded = ?1",
        params![fold(word.trim())],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory_for_tests;

    /// Real schema via the migration runner, so migration 23 is exercised
    /// rather than a hand-written CREATE TABLE that could drift from it.
    fn db() -> Connection {
        let db = open_memory_for_tests();
        let mut guard = db.0.into_inner().expect("db mutex");
        guard.pragma_update(None, "foreign_keys", "ON").unwrap();
        guard
    }

    #[test]
    fn starts_empty() {
        assert!(list(&db()).unwrap().is_empty());
    }

    #[test]
    fn keeps_the_casing_the_user_typed() {
        let conn = db();
        add(&conn, "Mindstream").unwrap();
        assert_eq!(list(&conn).unwrap(), vec!["Mindstream"]);
    }

    #[test]
    fn adding_another_casing_does_not_create_a_second_entry() {
        let conn = db();
        add(&conn, "Mindstream").unwrap();
        add(&conn, "mindstream").unwrap();
        add(&conn, "MINDSTREAM").unwrap();
        assert_eq!(list(&conn).unwrap(), vec!["Mindstream"]);
    }

    #[test]
    fn removes_regardless_of_casing() {
        let conn = db();
        add(&conn, "Mindstream").unwrap();
        remove(&conn, "MINDSTREAM").unwrap();
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn folds_non_ascii_words() {
        // The words that most need case-insensitive matching are the ones
        // ASCII folding would miss.
        let conn = db();
        add(&conn, "Ärzteschaft").unwrap();
        add(&conn, "ärzteschaft").unwrap();
        assert_eq!(list(&conn).unwrap(), vec!["Ärzteschaft"]);
    }

    #[test]
    fn ignores_blank_input() {
        let conn = db();
        add(&conn, "   ").unwrap();
        add(&conn, "").unwrap();
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn trims_surrounding_whitespace() {
        let conn = db();
        add(&conn, "  Mindstream  ").unwrap();
        assert_eq!(list(&conn).unwrap(), vec!["Mindstream"]);
    }

    #[test]
    fn removing_an_absent_word_is_not_an_error() {
        assert!(remove(&db(), "nothing").is_ok());
    }

    #[test]
    fn lists_in_a_stable_order() {
        let conn = db();
        for word in ["zebra", "Apfel", "mango"] {
            add(&conn, word).unwrap();
        }
        assert_eq!(list(&conn).unwrap(), vec!["Apfel", "mango", "zebra"]);
    }
}
