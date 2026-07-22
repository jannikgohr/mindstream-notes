//! Canonical word counting for note content.
//!
//! Word counting lives in Rust so the two places that report it can't drift:
//! the History "+N / −M words" delta (computed at capture from DB snapshots,
//! see `history`) and the sidebar's "Words" stat. The sidebar reads the
//! absolute count via `note_word_count`, which reads the note's content
//! straight from the DB (markdown `body`, or the already-extracted `pdf_text`
//! for PDFs) — content is never shipped over IPC just to count it.
//!
//! `markdownToPlain` / `countWords` are mirrored in TS for the browser-dev mock
//! (src/lib/content-stats/word-count.ts); keep the two in sync.

use std::sync::OnceLock;

use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use similar::{ChangeTag, TextDiff};

use crate::db::Db;
use crate::error::{AppResult, CommandResult};

fn cached_regex(
    name: &str,
    pattern: &'static str,
    slot: &'static OnceLock<Option<Regex>>,
) -> Option<&'static Regex> {
    slot.get_or_init(|| match Regex::new(pattern) {
        Ok(re) => Some(re),
        Err(err) => {
            log::error!("[content-stats] invalid {name} regex: {err}");
            None
        }
    })
    .as_ref()
}

fn word_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    cached_regex("word", r"[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*", &RE)
}
fn fence_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    cached_regex("fence", r"(?s)```.*?```", &RE)
}
fn inline_code_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    cached_regex("inline code", r"`[^`]*`", &RE)
}
fn html_re() -> Option<&'static Regex> {
    // HTML comments and tags (`<br />`, `</p>`, `<div class="x">`, autolinks).
    // Without this, a tag's name/attributes leak in as "words".
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    cached_regex("HTML", r"(?s)<!--.*?-->|</?[a-zA-Z][^>]*>", &RE)
}
fn image_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    cached_regex("image", r"!\[[^\]]*\]\([^)]*\)", &RE)
}
fn link_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    cached_regex("link", r"\[([^\]]*)\]\([^)]*\)", &RE)
}
fn punct_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    cached_regex("punctuation", r"[#>*_~|\[\](){}:]", &RE)
}

fn replace_all_owned(input: String, re: Option<&Regex>, replacement: &str) -> String {
    match re {
        Some(re) => re.replace_all(&input, replacement).into_owned(),
        None => input,
    }
}

/// Strip markdown noise to plain prose (code, images, link URLs, formatting
/// punctuation), keeping link labels. Mirrors the TS `markdownToPlain`.
pub fn markdown_to_plain(body: &str) -> String {
    let s = replace_all_owned(body.to_string(), fence_re(), " ");
    let s = replace_all_owned(s, inline_code_re(), " ");
    let s = replace_all_owned(s, html_re(), " ");
    let s = replace_all_owned(s, image_re(), " ");
    let s = replace_all_owned(s, link_re(), "${1}");
    replace_all_owned(s, punct_re(), " ")
}

/// Count real words (Unicode letter/number groups, internal `' ’ _ -` allowed).
pub fn count_words(text: &str) -> i64 {
    word_re()
        .map(|re| re.find_iter(text).count() as i64)
        .unwrap_or(0)
}

fn word_tokens(text: &str) -> Vec<&str> {
    word_re()
        .map(|re| re.find_iter(text).map(|m| m.as_str()).collect())
        .unwrap_or_default()
}

/// Real-word delta `(added, removed)` between two markdown snapshots — the same
/// word notion as `count_words`, so a first snapshot's `added` equals the note's
/// word count.
pub fn word_delta(old_md: &str, new_md: &str) -> (i64, i64) {
    let old_plain = markdown_to_plain(old_md);
    let new_plain = markdown_to_plain(new_md);
    let old_words = word_tokens(&old_plain);
    let new_words = word_tokens(&new_plain);
    let diff = TextDiff::from_slices(&old_words, &new_words);
    let (mut added, mut removed) = (0i64, 0i64);
    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Insert => added += 1,
            ChangeTag::Delete => removed += 1,
            ChangeTag::Equal => {}
        }
    }
    (added, removed)
}

/// Non-whitespace character delta `(added, removed)` between two raw markdown
/// snapshots. The fallback "tokens" magnitude for edits that change no words
/// (formatting, punctuation, code/URL/HTML). Whitespace is skipped so the
/// figure always reflects a *visible* change — an edit that only touches
/// whitespace yields `(0, 0)` and the UI falls back to a qualitative label.
pub fn token_delta(old_md: &str, new_md: &str) -> (i64, i64) {
    let diff = TextDiff::from_chars(old_md, new_md);
    let (mut added, mut removed) = (0i64, 0i64);
    for change in diff.iter_all_changes() {
        if change.value().trim().is_empty() {
            continue;
        }
        match change.tag() {
            ChangeTag::Insert => added += 1,
            ChangeTag::Delete => removed += 1,
            ChangeTag::Equal => {}
        }
    }
    (added, removed)
}

/// Absolute word count for a note, from its DB content. PDF notes count the
/// extracted `pdf_text` (already plain, 0 until indexed); others strip markdown.
pub fn note_word_count_inner(conn: &Connection, note_id: &str) -> AppResult<i64> {
    let row: Option<(String, String, Option<String>)> = conn
        .query_row(
            "SELECT note_kind, body, pdf_text FROM notes WHERE id = ?1",
            params![note_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((kind, body, pdf_text)) = row else {
        return Ok(0);
    };
    let words = if kind == "pdf" {
        count_words(&pdf_text.unwrap_or_default())
    } else {
        count_words(&markdown_to_plain(&body))
    };
    Ok(words)
}

#[tauri::command]
pub fn note_word_count(db: tauri::State<'_, Db>, note_id: String) -> CommandResult<i64> {
    db.with_conn(|c| note_word_count_inner(c, &note_id))
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory_for_tests;
    use crate::notes::{create, CreateNote};

    #[test]
    fn counts_plain_words() {
        assert_eq!(count_words("hello world"), 2);
        assert_eq!(count_words("don't well-known foo_bar"), 3);
        assert_eq!(count_words("   "), 0);
    }

    #[test]
    fn strips_markdown_noise_before_counting() {
        // Heading/bold punctuation, image (dropped), link (label kept), code.
        let md = "# Title\n\n**bold** word ![alt](img.png) [label](http://x) `code`";
        let plain = markdown_to_plain(md);
        assert!(!plain.contains('#') && !plain.contains('*'));
        // Title, bold, word, label = 4 (alt/img/code/url excluded).
        assert_eq!(count_words(&plain), 4);
    }

    #[test]
    fn fenced_code_is_excluded() {
        let md = "intro\n```\nlet x = 1;\n```\noutro";
        assert_eq!(count_words(&markdown_to_plain(md)), 2); // intro, outro
    }

    #[test]
    fn html_tags_and_comments_are_not_words() {
        // The reported bug: `<br />` counted as the word "br".
        assert_eq!(count_words(&markdown_to_plain("line one<br />line two")), 4);
        let md = "<div class=\"x\">hello</div> <!-- note --> world";
        assert_eq!(count_words(&markdown_to_plain(md)), 2); // hello, world
                                                            // A bare comparison in prose isn't a tag.
        assert_eq!(count_words(&markdown_to_plain("if a < b then")), 4);
    }

    #[test]
    fn first_snapshot_delta_equals_word_count() {
        let md = "# Notes\n\nalpha beta **gamma**";
        let (added, removed) = word_delta("", md);
        assert_eq!(removed, 0);
        assert_eq!(added, count_words(&markdown_to_plain(md)));
        assert_eq!(added, 4); // Notes, alpha, beta, gamma
    }

    #[test]
    fn delta_tracks_word_churn() {
        let (added, removed) = word_delta("alpha beta gamma", "alpha delta gamma epsilon");
        assert_eq!((added, removed), (2, 1)); // +delta +epsilon, -beta
    }

    #[test]
    fn token_delta_counts_visible_chars_ignoring_whitespace() {
        // Formatting-only edit: no word change, four visible '*' added.
        assert_eq!(word_delta("hello world", "**hello** world"), (0, 0));
        assert_eq!(token_delta("hello world", "**hello** world"), (4, 0));
        // A punctuation edit that doesn't cross a word boundary.
        assert_eq!(token_delta("done", "done!"), (1, 0));
        // Whitespace-only edits contribute no visible tokens.
        assert_eq!(token_delta("a b", "a  b"), (0, 0));
        assert_eq!(token_delta("para", "para\n\n"), (0, 0));
    }

    #[test]
    fn note_word_count_reads_db_content() {
        let db = open_memory_for_tests();
        let id = db
            .with_conn(|c| {
                create(
                    c,
                    CreateNote {
                        title: Some("t".into()),
                        body: Some("# Hi\n\nhello world".into()),
                        parent_collection_id: None,
                        note_kind: Some("markdown".into()),
                    },
                )
            })
            .unwrap()
            .summary
            .id;
        assert_eq!(
            db.with_conn(|c| note_word_count_inner(c, &id)).unwrap(),
            3 // Hi, hello, world
        );
    }
}
