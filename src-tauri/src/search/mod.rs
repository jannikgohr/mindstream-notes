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

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::error::{AppResult, CommandResult};
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

    let mut stmt = conn.prepare(
        "SELECT id, parent_collection_id, title, position, created, modified,
                trashed_at, favourite, etebase_uid, note_kind, body, pdf_text
         FROM notes
         WHERE trashed_at IS NULL",
    )?;
    let rows = stmt.query_map([], |row| {
        let trashed_at: Option<String> = row.get("trashed_at")?;
        let favourite: i64 = row.get("favourite")?;
        let etebase_uid: Option<String> = row.get("etebase_uid")?;
        let note_kind: NoteKind = row.get("note_kind")?;
        // For PDF notes the `body` column is only a JSON asset pointer; the
        // searchable text lives in `pdf_text` (extracted from the PDF, NULL
        // until indexed). Substitute it so the matcher/snippet never sees the
        // pointer and PDF content becomes searchable.
        let searchable_body = if note_kind == NoteKind::Pdf {
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
                tags: Vec::new(),
                trashed: trashed_at.is_some(),
                favourite: favourite != 0,
                pushed: etebase_uid.is_some(),
                note_kind,
            },
            searchable_body,
        ))
    })?;

    let pool: Vec<(NoteSummary, String)> = rows.collect::<rusqlite::Result<Vec<_>>>()?;

    // Per-note tag fetch — small enough that one statement-per-note is
    // simpler than building an IN-list.
    let mut tag_stmt = conn.prepare("SELECT tag FROM note_tags WHERE note_id = ?1 ORDER BY tag")?;

    let mut scored: Vec<(i64, SearchHit)> = Vec::new();
    for (mut summary, body) in pool {
        let tags: Vec<String> = tag_stmt
            .query_map(params![summary.id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        summary.tags = tags.clone();

        let title_chars = lowercase_chars(&summary.title);
        let body_chars = lowercase_chars(&body);
        let tags_joined = tags.join(" ");
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

        let title_matches = find_matches(&summary.title, &terms);
        let body_match_count: usize = terms.iter().map(|t| count_matches(&body_chars, t)).sum();

        let score: i64 = (title_matches.len() as i64) * 10 + (body_match_count as i64);

        let (snippet, snippet_matches) = build_snippet(&body, &terms);

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

    Ok(scored.into_iter().map(|(_, hit)| hit).collect())
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

// ---------- Tauri command ----------

#[tauri::command]
pub fn search_notes(db: tauri::State<'_, Db>, query: String) -> CommandResult<Vec<SearchHit>> {
    db.with_conn(|c| search(c, &query)).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory_for_tests;
    use crate::notes::{create, update, CreateNote, UpdateNote};

    fn seed_note(db: &Db, title: &str, body: &str) -> String {
        let n = db
            .with_conn(|c| {
                create(
                    c,
                    CreateNote {
                        title: Some(title.into()),
                        body: Some(body.into()),
                        parent_collection_id: None,
                        note_kind: None,
                    },
                )
            })
            .unwrap();
        n.summary.id
    }

    #[test]
    fn empty_query_returns_no_hits() {
        let db = open_memory_for_tests();
        seed_note(&db, "Hello", "World");
        let hits = db.with_conn(|c| search(c, "  ")).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn title_match_outranks_body_only_match() {
        let db = open_memory_for_tests();
        let body_only = seed_note(&db, "Random", "the word foobar lives here");
        let title_hit = seed_note(&db, "foobar in title", "no body match");
        let hits = db.with_conn(|c| search(c, "foobar")).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].note.id, title_hit);
        assert_eq!(hits[1].note.id, body_only);
    }

    #[test]
    fn multi_term_query_is_and() {
        let db = open_memory_for_tests();
        // Misses: contains "alpha" but not "beta" anywhere.
        seed_note(&db, "alpha", "no second term here");
        let both = seed_note(&db, "alpha beta", "");
        let hits = db.with_conn(|c| search(c, "alpha beta")).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].note.id, both);
    }

    #[test]
    fn case_insensitive_match() {
        let db = open_memory_for_tests();
        seed_note(&db, "Mixed Case", "Some BODY here");
        let hits = db.with_conn(|c| search(c, "body")).unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn tag_match_qualifies() {
        let db = open_memory_for_tests();
        let id = seed_note(&db, "untitled", "no body keyword");
        db.with_conn_mut(|c| {
            update(
                c,
                UpdateNote {
                    id: id.clone(),
                    title: None,
                    body: None,
                    parent_collection_id: None,
                    position: None,
                    tags: Some(vec!["project-x".into()]),
                    yrs_state: None,
                    favourite: None,
                },
            )
        })
        .unwrap();
        let hits = db.with_conn(|c| search(c, "project-x")).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].note.id, id);
    }

    #[test]
    fn snippet_contains_first_body_match() {
        let db = open_memory_for_tests();
        let body = "lorem ipsum ".repeat(20) + "the needle is here " + &"dolor sit ".repeat(20);
        seed_note(&db, "title", &body);
        let hits = db.with_conn(|c| search(c, "needle")).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("needle"));
        assert!(!hits[0].snippet_matches.is_empty());
        let m = &hits[0].snippet_matches[0];
        let actual: String = hits[0]
            .snippet
            .chars()
            .skip(m.start)
            .take(m.end - m.start)
            .collect();
        assert_eq!(actual.to_lowercase(), "needle");
    }

    #[test]
    fn title_match_ranges_returned() {
        let db = open_memory_for_tests();
        seed_note(&db, "the FooBar lives", "");
        let hits = db.with_conn(|c| search(c, "foobar")).unwrap();
        assert_eq!(hits.len(), 1);
        let m = &hits[0].title_matches[0];
        let title_chars: Vec<char> = hits[0].note.title.chars().collect();
        let actual: String = title_chars[m.start..m.end].iter().collect();
        assert_eq!(actual, "FooBar");
    }

    #[test]
    fn trashed_notes_excluded() {
        let db = open_memory_for_tests();
        let id = seed_note(&db, "trashy keyword", "");
        db.with_conn(|c| crate::notes::trash(c, &id)).unwrap();
        let hits = db.with_conn(|c| search(c, "keyword")).unwrap();
        assert!(hits.is_empty());
    }

    /// PDF note: `body` is a JSON asset pointer; searchable text comes from
    /// the indexed `pdf_text` column instead.
    fn seed_pdf_note(db: &Db, title: &str, pdf_text: Option<&str>) -> String {
        let id = db
            .with_conn(|c| {
                create(
                    c,
                    CreateNote {
                        title: Some(title.into()),
                        body: Some(r#"{"pdfAssetId":"asset_abc"}"#.into()),
                        parent_collection_id: None,
                        note_kind: Some("pdf".into()),
                    },
                )
            })
            .unwrap()
            .summary
            .id;
        if let Some(text) = pdf_text {
            db.with_conn(|c| crate::pdf_text::store_text(c, &id, text))
                .unwrap();
        }
        id
    }

    #[test]
    fn pdf_content_is_searchable_via_pdf_text() {
        let db = open_memory_for_tests();
        let id = seed_pdf_note(
            &db,
            "Quarterly Report",
            Some("the mitochondria is the powerhouse"),
        );
        let hits = db.with_conn(|c| search(c, "mitochondria")).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].note.id, id);
        assert!(hits[0].snippet.to_lowercase().contains("mitochondria"));
        assert!(!hits[0].snippet_matches.is_empty());
    }

    #[test]
    fn pdf_asset_pointer_is_not_matched() {
        // The JSON body pointer must never produce hits — searching its keys
        // (a latent bug before pdf_text) returns nothing.
        let db = open_memory_for_tests();
        seed_pdf_note(&db, "Report", Some("real content here"));
        assert!(db
            .with_conn(|c| search(c, "pdfAssetId"))
            .unwrap()
            .is_empty());
        assert!(db.with_conn(|c| search(c, "asset_abc")).unwrap().is_empty());
    }

    #[test]
    fn unindexed_pdf_matches_title_only() {
        // pdf_text NULL → content isn't searchable yet, but the title still is.
        let db = open_memory_for_tests();
        let id = seed_pdf_note(&db, "Invoice draft", None);
        assert!(db.with_conn(|c| search(c, "content")).unwrap().is_empty());
        let by_title = db.with_conn(|c| search(c, "invoice")).unwrap();
        assert_eq!(by_title.len(), 1);
        assert_eq!(by_title[0].note.id, id);
    }
}
