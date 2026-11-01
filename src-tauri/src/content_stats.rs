//! Native adapters for shared content stats storage.
use crate::db::Db;
use crate::error::{AppResult, CommandResult};
pub use mindstream_storage_core::content_stats::*;
use rusqlite::Connection;

pub fn note_word_count_inner(conn: &Connection, note_id: &str) -> AppResult<i64> {
    mindstream_storage_core::content_stats::note_word_count_inner(conn, note_id).map_err(Into::into)
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
