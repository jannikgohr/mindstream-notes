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

use crate::error::AppResult;

pub fn cached_regex(
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

pub fn word_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    cached_regex("word", r"[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*", &RE)
}
pub fn fence_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    cached_regex("fence", r"(?s)```.*?```", &RE)
}
pub fn inline_code_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    cached_regex("inline code", r"`[^`]*`", &RE)
}
pub fn html_re() -> Option<&'static Regex> {
    // HTML comments and tags (`<br />`, `</p>`, `<div class="x">`, autolinks).
    // Without this, a tag's name/attributes leak in as "words".
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    cached_regex("HTML", r"(?s)<!--.*?-->|</?[a-zA-Z][^>]*>", &RE)
}
pub fn image_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    cached_regex("image", r"!\[[^\]]*\]\([^)]*\)", &RE)
}
pub fn link_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    cached_regex("link", r"\[([^\]]*)\]\([^)]*\)", &RE)
}
pub fn punct_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    cached_regex("punctuation", r"[#>*_~|\[\](){}:]", &RE)
}

pub fn replace_all_owned(input: String, re: Option<&Regex>, replacement: &str) -> String {
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

pub fn word_tokens(text: &str) -> Vec<&str> {
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
    let words = if kind == "pdf" || kind == "ink" {
        count_words(&pdf_text.unwrap_or_default())
    } else {
        count_words(&markdown_to_plain(&body))
    };
    Ok(words)
}
