//! Native commands for the shared search implementation.
use crate::db::Db;
use crate::error::{AppResult, CommandResult};
use mindstream_storage_core::search::{load_candidates, rank_candidates};
pub use mindstream_storage_core::search::{MatchRange, SearchHit};
use rusqlite::Connection;

pub fn search(conn: &Connection, query: &str) -> AppResult<Vec<SearchHit>> {
    mindstream_storage_core::search::search(conn, query).map_err(Into::into)
}

// ---------- Tauri command ----------

#[tauri::command]
pub fn search_notes(db: tauri::State<'_, Db>, query: String) -> CommandResult<Vec<SearchHit>> {
    let terms: Vec<Vec<char>> = query
        .split_whitespace()
        .map(|term| term.to_lowercase().chars().collect())
        .collect();
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let candidates = db.with_conn(|c| load_candidates(c, &query).map_err(Into::into))?;
    Ok(rank_candidates(candidates, &terms))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory_for_tests;
    use crate::notes::{create, update, CreateNote, UpdateNote};
    use rusqlite::params;

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
    fn snippet_shows_reading_text_not_markdown() {
        let db = open_memory_for_tests();
        let body = "Intro.\n\n## Itinerary\n\n1. **Thursday:** arrive 14:20\n- [x] Pack *light* \
                    snake_case_name\n> Quote with [a link](https://x.test) and [[Note|alias]]\n\n\
                    | Item | Cost |\n| --- | ---: |\n| Hotel | 390 € |\n\n```python\nx = 1\n```";
        seed_note(&db, "Trip", body);
        let hits = db.with_conn(|c| search(c, "trip")).unwrap();
        assert_eq!(
            hits[0].snippet,
            "Intro. · Itinerary · Thursday: arrive 14:20 · Pack light snake_case_name · \
             Quote with a link and alias · Item Cost · Hotel 390 € · x = 1"
        );
    }

    #[test]
    fn snippet_keeps_angle_brackets_in_code() {
        let db = open_memory_for_tests();
        let body = "<div>Before</div>\nUse `Map<Key>`\n```ts\nconst r: Promise<Needle> = f();\n```";
        seed_note(&db, "Trip", body);
        let hits = db.with_conn(|c| search(c, "trip")).unwrap();
        assert_eq!(
            hits[0].snippet,
            "Before · Use Map<Key> · const r: Promise<Needle> = f();"
        );
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
    #[test]
    fn nested_trash_is_excluded_and_restoring_folder_restores_visibility() {
        let db = open_memory_for_tests();
        let folder = db
            .with_conn(|c| {
                crate::collections::create(
                    c,
                    crate::collections::CreateCollection {
                        name: "Parent".into(),
                        parent_collection_id: None,
                    },
                )
            })
            .unwrap()
            .id;
        let child = db
            .with_conn(|c| {
                crate::collections::create(
                    c,
                    crate::collections::CreateCollection {
                        name: "Child".into(),
                        parent_collection_id: Some(folder.clone()),
                    },
                )
            })
            .unwrap()
            .id;
        let id = seed_pdf_note(&db, "needle PDF", None);
        db.with_conn(|c| {
            c.execute(
                "UPDATE notes SET parent_collection_id = ?1 WHERE id = ?2",
                params![child, id],
            )?;
            Ok(())
        })
        .unwrap();
        for parent in [Some("trash".to_string()), None] {
            let hidden = parent.is_some();
            db.with_conn_mut(|c| {
                crate::tree_batch::move_many_items(
                    c,
                    vec![crate::tree_batch::TreeItemRef::Folder { id: folder.clone() }],
                    parent,
                )
            })
            .unwrap();
            db.with_conn(|c| {
                assert_eq!(search(c, "needle")?.is_empty(), hidden);
                assert_eq!(crate::notes::list(c, false)?.is_empty(), hidden);
                assert_eq!(crate::pdf_text::notes_missing_text(c)?.is_empty(), hidden);
                assert_eq!(crate::pdf_text::note_needs_text(c, &id)?, !hidden);
                Ok(())
            })
            .unwrap();
        }
    }

    #[test]
    fn fts_candidates_track_updates_deletes_tags_and_literal_substrings() {
        let db = open_memory_for_tests();
        let id = seed_note(&db, "pineapple", "quote\"mark");
        seed_note(&db, "unrelated", &"large irrelevant content ".repeat(1000));
        db.with_conn(|c| {
            assert_eq!(load_candidates(c, "apple")?.len(), 1);
            assert_eq!(search(c, "pi")?.len(), 1);
            assert_eq!(search(c, "quote\"mark")?.len(), 1);
            c.execute(
                "UPDATE notes SET body = 'changed' WHERE id = ?1",
                params![id],
            )?;
            assert!(search(c, "quote\"mark")?.is_empty());
            c.execute(
                "INSERT INTO note_tags(note_id, tag) VALUES (?1, 'new-tag')",
                params![id],
            )?;
            assert_eq!(search(c, "new-tag")?.len(), 1);
            c.execute("DELETE FROM note_tags WHERE note_id = ?1", params![id])?;
            assert!(search(c, "new-tag")?.is_empty());
            crate::notes::purge(c, &id)?;
            assert!(search(c, "apple")?.is_empty());
            Ok(())
        })
        .unwrap();
    }
}
