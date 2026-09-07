use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use rusqlite::params;

use super::links::{self, LinkIndex, RewriteContext, RewriteOptions, RewriteStats};
use super::markdown;
use super::model::{AliasTier, UnresolvedLinks};
use super::{run_import, ImportOptions, ImportSourceKind, DEFAULT_MAX_ATTACHMENT_BYTES};
use crate::db::{open_memory_for_tests, Db};
use crate::error::AppError;

/// A throwaway directory that cleans itself up, so a failing assertion doesn't
/// leave litter in the temp dir.
struct TempVault(PathBuf);

impl TempVault {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("ms-import-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).expect("temp vault");
        Self(path)
    }

    fn write(&self, relative: &str, contents: &str) -> &Self {
        self.write_bytes(relative, contents.as_bytes())
    }

    fn write_bytes(&self, relative: &str, contents: &[u8]) -> &Self {
        let path = self
            .0
            .join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent dir");
        }
        fs::write(&path, contents).expect("write fixture");
        self
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempVault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn options(vault: &TempVault) -> ImportOptions {
    ImportOptions {
        source_path: vault.path().to_string_lossy().to_string(),
        kind: Some(ImportSourceKind::Gfm),
        destination_collection_id: None,
        create_folder_named: None,
        import_attachments: true,
        max_attachment_bytes: DEFAULT_MAX_ATTACHMENT_BYTES,
        unresolved_links: UnresolvedLinks::PlainText,
    }
}

fn import(db: &Db, options: ImportOptions) -> super::ImportReport {
    let cancelled = AtomicBool::new(false);
    run_import(db, options, &cancelled, |_| {}).expect("import")
}

fn body_of(db: &Db, title: &str) -> String {
    db.with_conn(|c| {
        Ok(c.query_row(
            "SELECT body FROM notes WHERE title = ?1",
            params![title],
            |r| r.get::<_, String>(0),
        )?)
    })
    .unwrap()
}

fn note_id_of(db: &Db, title: &str) -> String {
    db.with_conn(|c| {
        Ok(c.query_row(
            "SELECT id FROM notes WHERE title = ?1",
            params![title],
            |r| r.get::<_, String>(0),
        )?)
    })
    .unwrap()
}

// ---------- link resolution ----------

#[test]
fn mutual_links_resolve_in_both_directions() {
    // The case that motivates minting every id in phase 1. When Alpha's body
    // is rewritten, Beta has not been read yet — but its id already exists, so
    // the link resolves without a second pass.
    let vault = TempVault::new();
    vault
        .write("Alpha.md", "See [Beta](Beta.md).")
        .write("Beta.md", "Back to [Alpha](Alpha.md).");
    let db = open_memory_for_tests();

    let report = import(&db, options(&vault));

    assert_eq!(report.notes_created, 2);
    assert_eq!(report.links_resolved, 2);
    assert_eq!(report.links_unresolved, 0);

    let alpha = note_id_of(&db, "Alpha");
    let beta = note_id_of(&db, "Beta");
    assert_eq!(
        body_of(&db, "Alpha"),
        format!("See [Beta](mindstream://note/{beta}).")
    );
    assert_eq!(
        body_of(&db, "Beta"),
        format!("Back to [Alpha](mindstream://note/{alpha}).")
    );
}

#[test]
fn a_three_note_cycle_resolves() {
    let vault = TempVault::new();
    vault
        .write("One.md", "[Two](Two.md)")
        .write("Two.md", "[Three](Three.md)")
        .write("Three.md", "[One](One.md)");
    let db = open_memory_for_tests();

    let report = import(&db, options(&vault));

    assert_eq!(report.links_resolved, 3);
    assert_eq!(report.links_unresolved, 0);
    for (from, to) in [("One", "Two"), ("Two", "Three"), ("Three", "One")] {
        let target = note_id_of(&db, to);
        assert!(
            body_of(&db, from).contains(&format!("mindstream://note/{target}")),
            "{from} should link to {to}"
        );
    }
}

#[test]
fn a_self_link_resolves_to_the_note_itself() {
    let vault = TempVault::new();
    vault.write("Loop.md", "I link to [myself](Loop.md).");
    let db = open_memory_for_tests();

    import(&db, options(&vault));

    let id = note_id_of(&db, "Loop");
    assert_eq!(
        body_of(&db, "Loop"),
        format!("I link to [myself](mindstream://note/{id}).")
    );
}

#[test]
fn a_full_path_beats_a_basename_collision() {
    // Two notes share a file name. The bare basename can only belong to one of
    // them, but a link that spells out the path must still reach the other.
    let vault = TempVault::new();
    vault
        .write("Archive/Index.md", "---\ntitle: Archived\n---\narchived")
        .write("Index.md", "---\ntitle: Root\n---\nroot")
        .write("Hub.md", "[a](Archive/Index.md) and [b](Index.md)");
    let db = open_memory_for_tests();

    import(&db, options(&vault));

    let archived = note_id_of(&db, "Archived");
    let root = note_id_of(&db, "Root");
    let hub = body_of(&db, "Hub");
    assert!(
        hub.contains(&format!("[a](mindstream://note/{archived})")),
        "explicit path must win: {hub}"
    );
    assert!(
        hub.contains(&format!("[b](mindstream://note/{root})")),
        "{hub}"
    );
}

#[test]
fn parent_relative_links_resolve() {
    let vault = TempVault::new();
    vault
        .write("Guides/Setup.md", "Back to [home](../Home.md).")
        .write("Home.md", "hello");
    let db = open_memory_for_tests();

    import(&db, options(&vault));

    let home = note_id_of(&db, "Home");
    assert!(body_of(&db, "Setup").contains(&format!("mindstream://note/{home}")));
}

#[test]
fn percent_encoded_targets_resolve() {
    let vault = TempVault::new();
    vault
        .write("Release Notes.md", "notes")
        .write("Index.md", "[link](Release%20Notes.md)");
    let db = open_memory_for_tests();

    import(&db, options(&vault));

    let target = note_id_of(&db, "Release Notes");
    assert!(body_of(&db, "Index").contains(&format!("mindstream://note/{target}")));
}

#[test]
fn external_urls_are_left_alone() {
    let vault = TempVault::new();
    vault.write(
        "Links.md",
        "[site](https://example.com/a.md) and [anchor](#section)",
    );
    let db = open_memory_for_tests();

    let report = import(&db, options(&vault));

    assert_eq!(report.links_resolved, 0);
    assert_eq!(
        body_of(&db, "Links"),
        "[site](https://example.com/a.md) and [anchor](#section)"
    );
}

#[test]
fn unresolved_links_stay_plain_text_by_default() {
    let vault = TempVault::new();
    vault.write("Solo.md", "[missing](Ghost.md)");
    let db = open_memory_for_tests();

    let report = import(&db, options(&vault));

    // A markdown link to a file we never imported is left exactly as written:
    // rewriting it would break a link that may still be valid on disk.
    assert_eq!(report.links_resolved, 0);
    assert_eq!(report.placeholders_created, 0);
    assert_eq!(body_of(&db, "Solo"), "[missing](Ghost.md)");
}

// ---------- wikilink rewriting (exercised directly; GFM leaves [[…]] alone) ----------

fn rewrite(body: &str, index: &mut LinkIndex) -> (String, RewriteStats) {
    let mut stats = RewriteStats::default();
    let out = links::rewrite_links(
        body,
        index,
        &RewriteContext {
            options: RewriteOptions {
                wikilinks: true,
                markdown_links: true,
            },
            base_dir: String::new(),
        },
        &mut stats,
    );
    (out, stats)
}

#[test]
fn wikilinks_become_id_backed_links() {
    let mut index = LinkIndex::new(UnresolvedLinks::PlainText);
    index.register(AliasTier::Basename, "Target", "note_abc");

    let (out, stats) = rewrite("see [[Target]] here", &mut index);

    assert_eq!(out, "see [Target](mindstream://note/note_abc) here");
    assert_eq!(stats.resolved, 1);
}

#[test]
fn wikilink_aliases_headings_and_blocks_are_handled() {
    let mut index = LinkIndex::new(UnresolvedLinks::PlainText);
    index.register(AliasTier::Basename, "Target", "note_abc");

    let (out, _) = rewrite("[[Target|the alias]]", &mut index);
    assert_eq!(out, "[the alias](mindstream://note/note_abc)");

    // The anchor is dropped from the target — links address a note, not a
    // position — but is kept in the display text so the reference still reads
    // the way the author wrote it.
    let (out, _) = rewrite("[[Target#Section]]", &mut index);
    assert_eq!(out, "[Target#Section](mindstream://note/note_abc)");

    let (out, _) = rewrite("[[Target^block-id]]", &mut index);
    assert_eq!(out, "[Target^block-id](mindstream://note/note_abc)");
}

#[test]
fn a_note_embed_degrades_to_a_plain_link() {
    // Mindstream has no transclusion, so `![[Note]]` becomes the closest thing
    // that still works: a link to the same note.
    let mut index = LinkIndex::new(UnresolvedLinks::PlainText);
    index.register(AliasTier::Basename, "Target", "note_abc");

    let (out, _) = rewrite("![[Target]]", &mut index);

    assert_eq!(out, "[Target](mindstream://note/note_abc)");
}

#[test]
fn an_unresolved_wikilink_becomes_its_own_text() {
    let mut index = LinkIndex::new(UnresolvedLinks::PlainText);

    let (out, stats) = rewrite("a [[Ghost]] link", &mut index);

    assert_eq!(out, "a Ghost link");
    assert_eq!(stats.unresolved, 1);
    assert!(index.placeholders().is_empty());
}

#[test]
fn placeholder_policy_mints_one_note_per_missing_target() {
    // Two references to the same missing target must land on the SAME note —
    // otherwise a vault with a popular red link grows a note per mention.
    let mut index = LinkIndex::new(UnresolvedLinks::CreatePlaceholder);

    let (first, _) = rewrite("[[Ghost]]", &mut index);
    let (second, _) = rewrite("also [[ghost]]", &mut index);

    assert_eq!(index.placeholders().len(), 1);
    let id = &index.placeholders()[0].note_id;
    assert_eq!(first, format!("[Ghost](mindstream://note/{id})"));
    assert_eq!(second, format!("also [ghost](mindstream://note/{id})"));
}

#[test]
fn a_normalized_title_matches_an_underscore_separated_target() {
    // MediaWiki writes `Foo_Bar`; the exported file is `Foo Bar.md`. Without
    // this tier a Wikipedia import resolves almost nothing.
    let mut index = LinkIndex::new(UnresolvedLinks::PlainText);
    index.register(
        AliasTier::NormalizedTitle,
        &links::normalize_title("Foo Bar"),
        "note_x",
    );

    let (out, _) = rewrite("[[Foo_Bar]]", &mut index);

    assert_eq!(out, "[Foo_Bar](mindstream://note/note_x)");
}

#[test]
fn a_stronger_tier_displaces_a_weaker_claim() {
    let mut index = LinkIndex::new(UnresolvedLinks::PlainText);
    index.register(AliasTier::Title, "shared", "note_weak");
    index.register(AliasTier::FullPath, "shared", "note_strong");
    // …and a later weak claim must not take it back.
    index.register(AliasTier::Title, "shared", "note_other");

    assert_eq!(index.resolve("shared"), Some("note_strong"));
}

#[test]
fn rebase_resolves_dot_segments_and_refuses_to_escape_the_root() {
    assert_eq!(
        links::rebase("Guides", "../Home.md"),
        Some("Home.md".to_string())
    );
    assert_eq!(links::rebase("a/b", "./c.md"), Some("a/b/c.md".to_string()));
    assert_eq!(links::rebase("", "../outside.md"), None);
}

// ---------- frontmatter and metadata ----------

#[test]
fn frontmatter_supplies_title_tags_and_timestamps() {
    let vault = TempVault::new();
    vault.write(
        "page.md",
        "---\ntitle: Real Title\ntags:\n  - alpha\n  - beta\ncreated: 2024-03-04\n---\nBody text\n",
    );
    let db = open_memory_for_tests();

    import(&db, options(&vault));

    let (created, body) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT created, body FROM notes WHERE title = 'Real Title'",
                [],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )?)
        })
        .unwrap();
    assert!(created.starts_with("2024-03-04"), "created was {created}");
    assert_eq!(body, "Body text\n");

    let tags: Vec<String> = db
        .with_conn(|c| {
            let mut stmt = c.prepare("SELECT tag FROM note_tags ORDER BY tag")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .unwrap();
    assert_eq!(tags, vec!["alpha".to_string(), "beta".to_string()]);
}

#[test]
fn a_leading_heading_supplies_the_title_when_frontmatter_has_none() {
    let vault = TempVault::new();
    vault.write("slugified-name.md", "# The Real Page Title\n\nbody");
    let db = open_memory_for_tests();

    import(&db, options(&vault));

    assert!(!note_id_of(&db, "The Real Page Title").is_empty());
}

#[test]
fn a_horizontal_rule_on_line_one_is_not_frontmatter() {
    let (frontmatter, body) = markdown::split_frontmatter("---\nJust a rule\n\nmore");
    assert_eq!(frontmatter, markdown::Frontmatter::default());
    assert_eq!(body, "---\nJust a rule\n\nmore");
}

#[test]
fn tags_accept_a_sequence_or_a_comma_separated_string() {
    let (list, _) = markdown::split_frontmatter("---\ntags:\n  - a\n  - b\n---\n");
    assert_eq!(list.tags, vec!["a".to_string(), "b".to_string()]);

    let (inline, _) = markdown::split_frontmatter("---\ntags: a, b\n---\n");
    assert_eq!(inline.tags, vec!["a".to_string(), "b".to_string()]);
}

#[test]
fn inline_tags_skip_headings_code_and_issue_numbers() {
    let tags = markdown::extract_inline_tags(
        "# Heading\n#real-tag here\n`#not-a-tag`\n```\n#fenced\n```\nsee #42 and https://x/y#frag\n",
    );
    assert_eq!(tags, vec!["real-tag".to_string()]);
}

// ---------- structure ----------

#[test]
fn folders_mirror_the_directory_tree() {
    let vault = TempVault::new();
    vault
        .write("Work/Projects/plan.md", "plan")
        .write("Personal/diary.md", "diary");
    let db = open_memory_for_tests();

    let report = import(&db, options(&vault));

    assert_eq!(report.folders_created, 3);
    let parent_name: String = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT p.name FROM notes n
                 JOIN collections p ON p.id = n.parent_collection_id
                 WHERE n.title = 'plan'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(parent_name, "Projects");
}

#[test]
fn everything_lands_under_a_new_destination_folder() {
    let vault = TempVault::new();
    vault.write("a.md", "a").write("Sub/b.md", "b");
    let db = open_memory_for_tests();

    let mut opts = options(&vault);
    opts.create_folder_named = Some("My Vault".into());
    import(&db, opts);

    let destination: String = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT id FROM collections WHERE name = 'My Vault'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    // The root-level note and the root-level folder both hang off it.
    let children: i64 = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT (SELECT COUNT(*) FROM notes WHERE parent_collection_id = ?1)
                      + (SELECT COUNT(*) FROM collections WHERE parent_collection_id = ?1)",
                params![destination],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(children, 2);
}

#[test]
fn hidden_directories_are_not_imported() {
    let vault = TempVault::new();
    vault
        .write("real.md", "real")
        .write(".obsidian/plugins/readme.md", "config")
        .write(".git/notes.md", "internal");
    let db = open_memory_for_tests();

    let report = import(&db, options(&vault));

    assert_eq!(report.notes_created, 1);
    assert_eq!(report.folders_created, 0);
}

// ---------- attachments ----------

#[test]
fn attachments_are_imported_and_deduplicated() {
    let vault = TempVault::new();
    let png = b"\x89PNG\r\n\x1a\n-fixture";
    vault
        .write_bytes("images/logo.png", png)
        .write_bytes("images/copy.png", png)
        .write("One.md", "![logo](images/logo.png)")
        .write("Two.md", "![same bytes](images/copy.png)");
    let db = open_memory_for_tests();

    let report = import(&db, options(&vault));

    assert_eq!(report.attachments_imported, 1, "one blob written");
    assert_eq!(report.attachments_deduplicated, 1, "the twin reused it");

    let rows: i64 = db
        .with_conn(|c| Ok(c.query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(rows, 1);
    let refs: i64 = db
        .with_conn(|c| Ok(c.query_row("SELECT COUNT(*) FROM asset_refs", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(refs, 2, "both notes reference the single blob");

    for title in ["One", "Two"] {
        assert!(
            body_of(&db, title).contains("asset:mindstream/asset_"),
            "{title} body should point at the stored asset"
        );
    }
}

#[test]
fn attachments_over_the_size_cap_are_skipped() {
    let vault = TempVault::new();
    vault
        .write_bytes("big.png", &vec![0u8; 4096])
        .write("Note.md", "![big](big.png)");
    let db = open_memory_for_tests();

    let mut opts = options(&vault);
    opts.max_attachment_bytes = 1024;
    let report = import(&db, opts);

    assert_eq!(report.attachments_too_large, 1);
    assert_eq!(report.attachments_imported, 0);
    // The link is left inert rather than pointing at an asset that isn't there.
    assert_eq!(body_of(&db, "Note"), "![big](big.png)");
}

#[test]
fn attachments_can_be_turned_off() {
    let vault = TempVault::new();
    vault
        .write_bytes("pic.png", b"bytes")
        .write("Note.md", "![pic](pic.png)");
    let db = open_memory_for_tests();

    let mut opts = options(&vault);
    opts.import_attachments = false;
    let report = import(&db, opts);

    assert_eq!(report.attachments_imported, 0);
    let rows: i64 = db
        .with_conn(|c| Ok(c.query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(rows, 0);
}

#[test]
fn a_link_to_a_missing_file_is_not_treated_as_an_attachment() {
    let vault = TempVault::new();
    vault.write("Note.md", "![gone](images/missing.png)");
    let db = open_memory_for_tests();

    let report = import(&db, options(&vault));

    assert_eq!(report.attachments_imported, 0);
    assert_eq!(body_of(&db, "Note"), "![gone](images/missing.png)");
}

// ---------- control flow ----------

#[test]
fn cancelling_keeps_everything_already_committed() {
    let vault = TempVault::new();
    for i in 0..5 {
        vault.write(&format!("note{i}.md"), "body");
    }
    let db = open_memory_for_tests();

    // Pre-cancelled: the run indexes, creates folders, then stops before the
    // first note. Nothing is rolled back, and the report says so.
    let cancelled = AtomicBool::new(true);
    let report = run_import(&db, options(&vault), &cancelled, |_| {}).expect("import");

    assert!(report.cancelled);
    assert_eq!(report.notes_created, 0);
}

#[test]
fn a_run_reports_progress_for_its_phases() {
    let vault = TempVault::new();
    vault.write("a.md", "a");
    let db = open_memory_for_tests();

    let mut phases = Vec::new();
    let cancelled = AtomicBool::new(false);
    run_import(&db, options(&vault), &cancelled, |progress| {
        phases.push(progress.phase)
    })
    .expect("import");

    assert_eq!(phases.first(), Some(&"scanning"));
    assert_eq!(phases.last(), Some(&"done"));
}

#[test]
fn detect_refuses_a_path_that_is_not_a_directory() {
    let vault = TempVault::new();
    vault.write("lonely.md", "x");
    let file = vault.path().join("lonely.md");

    let err = super::detect::detect(&file).unwrap_err();

    assert!(matches!(err, AppError::InvalidArg(_)), "got {err:?}");
}
