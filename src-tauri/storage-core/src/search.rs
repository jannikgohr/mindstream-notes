//! Free-text search across notes (title, body, tags).
//!
//! The query is space-tokenised; every token must appear (case-insensitively)
//! somewhere in title + body + tags for a note to be a hit (AND semantics —
//! matches Joplin's basic search). Scoring is `+10 per title hit` and
//! `+1 per body hit` so title matches surface above body-only ones; results
//! are then ordered by score desc, modified desc.
//!
//! The hit returned to the frontend carries a short body snippet around the
//! first body match (or the leading body chars for title-only hits), plus
//! char-index ranges for the title + snippet matches so the UI can highlight
//! them without reimplementing the matcher in JS. Char indices line up with
//! JavaScript `String#slice` semantics (which counts UTF-16 code units, not
//! bytes); on the dominant Basic Multilingual Plane characters the two
//! agree, so the UI can slice directly.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::AppResult;
use crate::notes::{NoteKind, NoteSummary};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub note: NoteSummary,
    /// Short body excerpt around the first match (or the leading body
    /// chars for title-only hits). Empty for body-less notes.
    pub snippet: String,
    /// Ranges within `note.title` that matched any query term.
    pub title_matches: Vec<MatchRange>,
    /// Ranges within `snippet` that matched any query term.
    pub snippet_matches: Vec<MatchRange>,
}

const SNIPPET_PRE_CHARS: usize = 40;
const SNIPPET_LEN_CHARS: usize = 200;

/// Search the (non-trashed) notes for `query`. An empty or whitespace-only
/// query returns an empty result set — the UI shows a hint instead of
/// dumping every note.
pub fn search(conn: &Connection, query: &str) -> AppResult<Vec<SearchHit>> {
    let terms: Vec<Vec<char>> = query
        .split_whitespace()
        .map(|t| t.to_lowercase().chars().collect())
        .filter(|t: &Vec<char>| !t.is_empty())
        .collect();
    if terms.is_empty() {
        return Ok(Vec::new());
    }

    let pool = load_candidates(conn, query)?;
    Ok(rank_candidates(pool, &terms))
}

pub type Candidate = (NoteSummary, String);

pub fn load_candidates(conn: &Connection, query: &str) -> AppResult<Vec<Candidate>> {
    // Trigrams retain substring matching. Short queries fall back to the
    // active-note scan because FTS5 cannot index fewer than three characters.
    let indexed_terms: Vec<String> = query
        .split_whitespace()
        .filter(|term| term.chars().count() >= 3)
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect();
    let fts_query = indexed_terms.join(" AND ");
    let filter = if fts_query.is_empty() {
        ""
    } else {
        " AND n.id IN (SELECT notes.id FROM notes JOIN note_search ON notes.rowid = note_search.rowid WHERE note_search MATCH ?1)"
    };
    let sql = format!(
        "SELECT n.id, parent_collection_id, title, position, created, modified,
                trashed_at, favourite, etebase_uid, note_kind, body, pdf_text,
                (SELECT json_group_array(tag) FROM (SELECT tag FROM note_tags WHERE note_id = n.id ORDER BY tag)) AS tags
         FROM active_notes n WHERE 1=1{filter}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let values: Vec<&dyn rusqlite::ToSql> = if fts_query.is_empty() {
        vec![]
    } else {
        vec![&fts_query]
    };
    let rows = stmt.query_map(values.as_slice(), |row| {
        let trashed_at: Option<String> = row.get("trashed_at")?;
        let favourite: i64 = row.get("favourite")?;
        let etebase_uid: Option<String> = row.get("etebase_uid")?;
        let note_kind: NoteKind = row.get("note_kind")?;
        // For PDF notes the `body` column is only a JSON asset pointer; the
        // searchable text lives in `pdf_text` (extracted from the PDF, NULL
        // until indexed). Substitute it so the matcher/snippet never sees the
        // pointer and PDF content becomes searchable.
        let searchable_body = if matches!(note_kind, NoteKind::Pdf | NoteKind::Ink) {
            row.get::<_, Option<String>>("pdf_text")?
                .unwrap_or_default()
        } else {
            row.get::<_, String>("body")?
        };
        Ok((
            NoteSummary {
                id: row.get("id")?,
                parent_collection_id: row.get("parent_collection_id")?,
                title: row.get("title")?,
                position: row.get("position")?,
                created: row.get("created")?,
                modified: row.get("modified")?,
                tags: serde_json::from_str(&row.get::<_, String>("tags")?).map_err(|err| {
                    rusqlite::Error::FromSqlConversionFailure(
                        12,
                        rusqlite::types::Type::Text,
                        Box::new(err),
                    )
                })?,
                trashed: trashed_at.is_some(),
                favourite: favourite != 0,
                pushed: etebase_uid.is_some(),
                note_kind,
            },
            searchable_body,
        ))
    })?;

    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn rank_candidates(pool: Vec<Candidate>, terms: &[Vec<char>]) -> Vec<SearchHit> {
    let mut scored: Vec<(i64, SearchHit)> = Vec::new();
    for (summary, body) in pool {
        let title_chars = lowercase_chars(&summary.title);
        let body_chars = lowercase_chars(&body);
        let tags_joined = summary.tags.join(" ");
        let tags_chars = lowercase_chars(&tags_joined);

        // AND match: every term must appear in title ∪ body ∪ tags.
        let all_present = terms.iter().all(|term| {
            contains_subslice(&title_chars, term)
                || contains_subslice(&body_chars, term)
                || contains_subslice(&tags_chars, term)
        });
        if !all_present {
            continue;
        }

        let title_matches = find_matches(&summary.title, terms);
        let body_match_count: usize = terms.iter().map(|t| count_matches(&body_chars, t)).sum();

        let score: i64 = (title_matches.len() as i64) * 10 + (body_match_count as i64);

        let (snippet, snippet_matches) = build_snippet(&body, terms);

        scored.push((
            score,
            SearchHit {
                note: summary,
                snippet,
                title_matches,
                snippet_matches,
            },
        ));
    }

    // Score desc, modified desc as the tiebreaker (newer first).
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| b.1.note.modified.cmp(&a.1.note.modified))
    });

    scored.into_iter().take(200).map(|(_, hit)| hit).collect()
}

fn lowercase_chars(s: &str) -> Vec<char> {
    // `flat_map(char::to_lowercase)` handles per-char case folding (incl.
    // German ß → "ss", Greek Σ → σ/ς) at the cost of a possible char-count
    // change vs. the original. For highlight positioning we accept that —
    // a mis-aligned range is rare and visually localised.
    s.chars().flat_map(|c| c.to_lowercase()).collect()
}

fn contains_subslice(haystack: &[char], needle: &[char]) -> bool {
    if needle.is_empty() || needle.len() > haystack.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// Return the char-index ranges of every term match in `haystack`,
/// case-insensitively. The ranges are valid as `String#slice` arguments
/// in JavaScript (char/code-unit indices for BMP chars).
fn find_matches(haystack: &str, terms: &[Vec<char>]) -> Vec<MatchRange> {
    if terms.is_empty() || haystack.is_empty() {
        return Vec::new();
    }
    let lower_chars = lowercase_chars(haystack);
    let mut raw: Vec<(usize, usize)> = Vec::new();
    for term in terms {
        if term.is_empty() || term.len() > lower_chars.len() {
            continue;
        }
        let mut i = 0usize;
        while i + term.len() <= lower_chars.len() {
            if lower_chars[i..i + term.len()] == term[..] {
                raw.push((i, i + term.len()));
                i += term.len();
            } else {
                i += 1;
            }
        }
    }
    merge_ranges(raw)
}

fn count_matches(lower_chars: &[char], term: &[char]) -> usize {
    if term.is_empty() || term.len() > lower_chars.len() {
        return 0;
    }
    let mut count = 0;
    let mut i = 0usize;
    while i + term.len() <= lower_chars.len() {
        if lower_chars[i..i + term.len()] == term[..] {
            count += 1;
            i += term.len();
        } else {
            i += 1;
        }
    }
    count
}

fn merge_ranges(mut raw: Vec<(usize, usize)>) -> Vec<MatchRange> {
    if raw.is_empty() {
        return Vec::new();
    }
    raw.sort_by_key(|(s, _)| *s);
    let mut out: Vec<MatchRange> = Vec::new();
    let (mut cs, mut ce) = raw[0];
    for &(s, e) in &raw[1..] {
        if s <= ce {
            if e > ce {
                ce = e;
            }
        } else {
            out.push(MatchRange { start: cs, end: ce });
            cs = s;
            ce = e;
        }
    }
    out.push(MatchRange { start: cs, end: ce });
    out
}

/// Take a short excerpt of `body` centred on the first match of any
/// term, with the matched ranges relative to the returned snippet.
/// Falls back to the leading chars of the body when no body match exists
/// (title-only hits still get a preview).
fn build_snippet(body: &str, terms: &[Vec<char>]) -> (String, Vec<MatchRange>) {
    if body.is_empty() {
        return (String::new(), Vec::new());
    }

    let body_chars: Vec<char> = body.chars().collect();
    let body_lower: Vec<char> = lowercase_chars(body);

    let mut first_match: Option<usize> = None;
    for term in terms {
        if term.is_empty() || term.len() > body_lower.len() {
            continue;
        }
        let mut i = 0usize;
        while i + term.len() <= body_lower.len() {
            if body_lower[i..i + term.len()] == term[..] {
                first_match = Some(match first_match {
                    Some(prev) => prev.min(i),
                    None => i,
                });
                break;
            }
            i += 1;
        }
    }

    let body_char_count = body_chars.len();
    let start_char = match first_match {
        Some(c) => c.saturating_sub(SNIPPET_PRE_CHARS),
        None => 0,
    };
    let end_char = (start_char + SNIPPET_LEN_CHARS).min(body_char_count);

    let snippet_raw: String = body_chars[start_char..end_char].iter().collect();
    let snippet = collapse_whitespace(&snippet_raw);

    let prefix = if start_char > 0 { "…" } else { "" };
    let suffix = if end_char < body_char_count {
        "…"
    } else {
        ""
    };
    let prefix_chars: usize = prefix.chars().count();

    let inner_matches = find_matches(&snippet, terms);
    let shifted: Vec<MatchRange> = inner_matches
        .into_iter()
        .map(|m| MatchRange {
            start: m.start + prefix_chars,
            end: m.end + prefix_chars,
        })
        .collect();

    (format!("{prefix}{snippet}{suffix}"), shifted)
}

fn collapse_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_ws = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !prev_ws {
                out.push(' ');
            }
            prev_ws = true;
        } else {
            out.push(c);
            prev_ws = false;
        }
    }
    out.trim().to_string()
}
